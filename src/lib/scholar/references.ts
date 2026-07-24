// Heuristic parser that pulls a paper's reference list out of its raw
// extracted PDF text. Pure and isomorphic (no DOM/Node APIs) so it can run
// client-side (where the full PDF text lives, in useScholarStore) or
// server-side — used by Phase 6c to ground research(scope="citations")
// answers in the paper's actual bibliography instead of guessing.
//
// extractPdfText() (see pdf.ts) joins each page's text items with a single
// space and has NO internal line breaks — a whole page is one long run-on
// string, with "\n\n--- Page N ---\n" markers between pages. So reference
// entries can't be split on newlines; they have to be split on the citation
// markers themselves ("[1]", "[2]", ... or "1.", "2.", ...).

export interface Reference {
  /** The citation number as printed (e.g. 12 for "[12]"), or null if the list wasn't numbered. */
  index: number | null;
  /** Whitespace-normalized reference text, page-break markers stripped. */
  raw: string;
  /** Normalized arXiv ID (e.g. "2301.12345" or the old "hep-th/9901001" form), if present. */
  arxivId?: string;
  /** Publication year, if a plausible one could be found. */
  year?: number;
  /** Best-effort title guess — approximate, not guaranteed correct for every citation style. */
  titleGuess?: string;
}

const SECTION_HEADING_RE = /\breferences\b|\bbibliography\b/gi;
const CUTOFF_HEADING_RE = /\b(appendix|supplementary material|acknowledg(e)?ments)\b/i;
const PAGE_MARKER_RE = /\n\n--- Page \d+ ---\n/g;
const MAX_REFERENCES = 200;
const MAX_FALLBACK_LENGTH = 4000;
// A real reference entry is a citation, not a page of prose. If the text
// between two markers runs on far longer than that, the "next marker" it
// stopped at almost certainly wasn't a real list item (e.g. a stray
// in-text "[13]" deep in a trailing appendix) — cap it rather than return
// a multi-page blob mislabeled as one reference.
const MAX_ENTRY_LENGTH = 700;

const ARXIV_NEW_RE = /arxiv\s*:?\s*(\d{4}\.\d{4,5})(?:v\d+)?/i;
const ARXIV_OLD_RE = /arxiv\s*:?\s*([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?/i;
const YEAR_PAREN_RE = /\((?:19|20)\d{2}[a-z]?\)/;
const YEAR_BARE_RE = /\b(19|20)\d{2}\b/;

function normalize(text: string): string {
  return text.replace(PAGE_MARKER_RE, " ").replace(/\s+/g, " ").trim();
}

/** Find where the reference list starts: the LAST "References"/"Bibliography" heading that's actually followed by a numbered citation shortly after (guards against the word appearing in running prose). */
function findReferencesSectionStart(text: string): number {
  const candidates: number[] = [];
  let m: RegExpExecArray | null;
  SECTION_HEADING_RE.lastIndex = 0;
  while ((m = SECTION_HEADING_RE.exec(text))) candidates.push(m.index + m[0].length);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const after = text.slice(candidates[i], candidates[i] + 200).trimStart();
    // A real heading is followed by the start of a new entry — a bracketed
    // or decimal number, or an author surname (capitalized). A false
    // positive (the word appearing mid-sentence, e.g. "...no bibliography
    // here.") is followed by ordinary lowercase continuation text instead.
    if (/^[[\dA-Z]/.test(after)) return candidates[i];
  }
  // No candidate looked like a real heading — either there's no references
  // section, or it uses a format we don't recognize. Returning nothing
  // beats fabricating a "reference" out of an unrelated sentence.
  return -1;
}

function sectionText(text: string): string | null {
  const start = findReferencesSectionStart(text);
  if (start < 0) return null;
  let end = text.length;
  const cutoffMatch = CUTOFF_HEADING_RE.exec(text.slice(start));
  if (cutoffMatch && cutoffMatch.index > 0) end = start + cutoffMatch.index;
  const body = text.slice(start, end).trim();
  return body.length > 0 ? body : null;
}

function splitBracketNumbered(body: string): Array<{ index: number; raw: string }> {
  const markerRe = /\[(\d{1,3})\]/g;
  const marks: Array<{ index: number; markerStart: number; pos: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(body))) {
    marks.push({ index: Number(m[1]), markerStart: m.index, pos: m.index + m[0].length });
  }
  const entries: Array<{ index: number; raw: string }> = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].pos;
    const end = i + 1 < marks.length ? marks[i + 1].markerStart : body.length;
    const raw = body.slice(start, end).trim().slice(0, MAX_ENTRY_LENGTH);
    if (raw) entries.push({ index: marks[i].index, raw });
  }
  return entries;
}

function splitDecimalNumbered(body: string): Array<{ index: number; raw: string }> {
  const markerRe = /(?:^|\s)(\d{1,3})\.\s+(?=[A-Z])/g;
  const marks: Array<{ index: number; markerStart: number; pos: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(body))) {
    marks.push({ index: Number(m[1]), markerStart: m.index, pos: m.index + m[0].length });
  }
  const entries: Array<{ index: number; raw: string }> = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].pos;
    const end = i + 1 < marks.length ? marks[i + 1].markerStart : body.length;
    const raw = body.slice(start, end).trim().slice(0, MAX_ENTRY_LENGTH);
    if (raw) entries.push({ index: marks[i].index, raw });
  }
  return entries;
}

/**
 * Numbered reference lists are always strictly sequential (1, 2, 3, ...).
 * Bracket-style in-text citations inside a trailing appendix/proof section
 * reuse the exact same "[N]" marker syntax, so naively splitting to EOF
 * bleeds appendix prose into fake trailing "references" once real entries
 * run out. The numbering breaking sequence (a repeat, a skip, a drop) is a
 * reliable signal we've left the real list — truncate there.
 */
function truncateAtFirstSequenceBreak(
  entries: Array<{ index: number; raw: string }>,
): Array<{ index: number; raw: string }> {
  const kept: Array<{ index: number; raw: string }> = [];
  for (const entry of entries) {
    if (entry.index !== kept.length + 1) break;
    kept.push(entry);
  }
  return kept;
}

function extractArxivId(raw: string): string | undefined {
  return ARXIV_NEW_RE.exec(raw)?.[1] ?? ARXIV_OLD_RE.exec(raw)?.[1];
}

function extractYear(raw: string): number | undefined {
  const paren = YEAR_PAREN_RE.exec(raw)?.[0];
  const bare = (paren ?? raw).match(YEAR_BARE_RE)?.[0];
  return bare ? Number(bare) : undefined;
}

function cleanTitleCandidate(candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  const cleaned = candidate.replace(/\.$/, "").trim();
  return cleaned.length >= 6 ? cleaned.slice(0, 300) : undefined;
}

/**
 * Approximate title guess: the sentence right after the author list / year,
 * up to the next period. Handles both "Authors. (Year). Title. Venue." (ACM
 * style) and "Authors. Year. Title. Venue." (IEEE style, no parens around
 * the year) — a rough guess either way, not always right for more exotic
 * formats, but good enough to search arXiv/Semantic Scholar by, which is
 * this function's only real consumer.
 */
function extractTitleGuess(raw: string): string | undefined {
  const afterYearParen = raw.split(YEAR_PAREN_RE)[1];
  if (afterYearParen !== undefined) {
    const sentences = afterYearParen
      .split(". ")
      .map((s) => s.trim())
      .filter(Boolean);
    return cleanTitleCandidate(sentences[0]);
  }

  const sentences = raw
    .split(". ")
    .map((s) => s.trim())
    .filter(Boolean);
  const bareYearIdx = sentences.findIndex((s) => /^(19|20)\d{2}[a-z]?$/.test(s));
  return cleanTitleCandidate(bareYearIdx >= 0 ? sentences[bareYearIdx + 1] : sentences[1]);
}

/**
 * Parse the reference/bibliography list out of a paper's raw extracted
 * text. Returns [] if no references section could be located. Best-effort
 * throughout: arxivId extraction is high-precision (a strict regex), but
 * titleGuess and entry splitting are heuristics that won't be perfect for
 * every citation style.
 */
export function extractReferences(fullText: string): Reference[] {
  const normalized = normalize(fullText);
  const body = sectionText(normalized);
  if (!body) return [];

  let split = truncateAtFirstSequenceBreak(splitBracketNumbered(body));
  if (split.length < 2) split = truncateAtFirstSequenceBreak(splitDecimalNumbered(body));

  const entries =
    split.length >= 2
      ? split
      : body.length > 0
        ? [{ index: null as number | null, raw: body.slice(0, MAX_FALLBACK_LENGTH) }]
        : [];

  return entries.slice(0, MAX_REFERENCES).map(({ index, raw }) => {
    const arxivId = extractArxivId(raw);
    const year = extractYear(raw);
    const titleGuess = extractTitleGuess(raw);
    return {
      index,
      raw,
      ...(arxivId ? { arxivId } : {}),
      ...(year ? { year } : {}),
      ...(titleGuess ? { titleGuess } : {}),
    };
  });
}
