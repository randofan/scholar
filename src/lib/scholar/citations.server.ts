// Free, keyless clients for resolving a paper's own references into real
// fetched metadata (title/abstract/authors) — the grounding data source for
// Phase 6c's research(scope="citations"). Both arXiv and Semantic Scholar
// are queried without an API key, so every call here is best-effort: a
// missing paper, a transient 429/5xx, or a network error all just resolve
// to `null` rather than throwing — a citation lookup failing should never
// break the research briefing it's meant to enrich.

/** GET-only fetch shape — matches illustrate.server.ts's FetchLike convention, narrowed since these clients never send a request body. */
export type FetchLike = (url: string) => Promise<Response>;

export interface ResolvedPaper {
  title: string;
  abstract?: string;
  authors?: string[];
  year?: number;
  url?: string;
  source: "arxiv" | "semantic-scholar";
}

const ARXIV_API_BASE = "https://export.arxiv.org/api/query";
const SEMANTIC_SCHOLAR_BASE = "https://api.semanticscholar.org/graph/v1";
const SEMANTIC_SCHOLAR_FIELDS = "title,abstract,year,authors,externalIds,url";

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractTag(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml);
  if (!m) return undefined;
  const cleaned = decodeXmlEntities(m[1]).replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function extractAuthors(entryXml: string): string[] {
  const names: string[] = [];
  const re = /<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(entryXml))) {
    const name = decodeXmlEntities(m[1]).replace(/\s+/g, " ").trim();
    if (name) names.push(name);
  }
  return names;
}

/** Parse a single <entry>...</entry> block from an arXiv Atom feed. Exported for unit testing without a real HTTP round trip. */
export function parseArxivEntry(entryXml: string): ResolvedPaper | null {
  const id = extractTag(entryXml, "id");
  // Invalid id_list queries return a single entry whose id points at the API's own error page.
  if (!id || /\/api\/errors/i.test(id)) return null;
  const title = extractTag(entryXml, "title");
  if (!title) return null;
  const publishedYear = extractTag(entryXml, "published")?.slice(0, 4);
  return {
    title,
    abstract: extractTag(entryXml, "summary"),
    authors: extractAuthors(entryXml),
    year: publishedYear ? Number(publishedYear) : undefined,
    url: id,
    source: "arxiv",
  };
}

/** Parse a full arXiv Atom feed response into its entries. Exported for unit testing. */
export function parseArxivFeed(xml: string): ResolvedPaper[] {
  const entries: ResolvedPaper[] = [];
  const re = /<entry>([\s\S]*?)<\/entry>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const parsed = parseArxivEntry(m[1]);
    if (parsed) entries.push(parsed);
  }
  return entries;
}

/** Look up a paper directly by its arXiv ID via arXiv's own Atom API. */
export async function fetchArxivPaper(
  arxivId: string,
  fetchImpl: FetchLike = fetch as FetchLike,
): Promise<ResolvedPaper | null> {
  try {
    const res = await fetchImpl(`${ARXIV_API_BASE}?id_list=${encodeURIComponent(arxivId)}`);
    if (!res.ok) return null;
    const xml = await res.text();
    return parseArxivFeed(xml)[0] ?? null;
  } catch {
    return null;
  }
}

/** Best-effort title search against arXiv when we don't have an arXiv ID. */
export async function searchArxivByTitle(
  title: string,
  fetchImpl: FetchLike = fetch as FetchLike,
): Promise<ResolvedPaper | null> {
  try {
    const query = `ti:"${title.replace(/"/g, "")}"`;
    const res = await fetchImpl(
      `${ARXIV_API_BASE}?search_query=${encodeURIComponent(query)}&max_results=1`,
    );
    if (!res.ok) return null;
    const xml = await res.text();
    return parseArxivFeed(xml)[0] ?? null;
  } catch {
    return null;
  }
}

interface SemanticScholarPaperJson {
  title?: string;
  abstract?: string | null;
  year?: number | null;
  authors?: Array<{ name?: string }>;
  url?: string;
}

function fromSemanticScholarJson(
  paper: SemanticScholarPaperJson | undefined,
): ResolvedPaper | null {
  if (!paper?.title) return null;
  return {
    title: paper.title,
    abstract: paper.abstract ?? undefined,
    authors: paper.authors?.map((a) => a.name).filter((n): n is string => !!n),
    year: paper.year ?? undefined,
    url: paper.url,
    source: "semantic-scholar",
  };
}

/** Look up a paper by its arXiv ID via Semantic Scholar's external-ID resolution (usually richer/cleaner abstracts than arXiv's own Atom feed). */
export async function fetchSemanticScholarPaper(
  arxivId: string,
  fetchImpl: FetchLike = fetch as FetchLike,
): Promise<ResolvedPaper | null> {
  try {
    const res = await fetchImpl(
      `${SEMANTIC_SCHOLAR_BASE}/paper/arXiv:${encodeURIComponent(arxivId)}?fields=${SEMANTIC_SCHOLAR_FIELDS}`,
    );
    if (!res.ok) return null;
    const json = (await res.json()) as SemanticScholarPaperJson;
    return fromSemanticScholarJson(json);
  } catch {
    return null;
  }
}

/** Best-effort title search against Semantic Scholar when we don't have an arXiv ID. */
export async function searchSemanticScholarByTitle(
  title: string,
  fetchImpl: FetchLike = fetch as FetchLike,
): Promise<ResolvedPaper | null> {
  try {
    const res = await fetchImpl(
      `${SEMANTIC_SCHOLAR_BASE}/paper/search?query=${encodeURIComponent(title)}&limit=1&fields=${SEMANTIC_SCHOLAR_FIELDS}`,
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: SemanticScholarPaperJson[] };
    return fromSemanticScholarJson(json.data?.[0]);
  } catch {
    return null;
  }
}

/**
 * Resolve one extracted Reference (see references.ts) into real fetched
 * metadata. Semantic Scholar is tried first when we have a precise arXiv
 * ID (richer/cleaner abstracts than arXiv's own feed); arXiv's Atom API is
 * the fallback for that same ID. Without an ID, falls back to a title
 * search on both, in the same preference order. Returns null if nothing
 * resolves — callers should treat that as "skip this citation," not an error.
 */
export async function resolveReference(
  ref: { arxivId?: string; titleGuess?: string },
  fetchImpl: FetchLike = fetch as FetchLike,
): Promise<ResolvedPaper | null> {
  if (ref.arxivId) {
    const viaSemanticScholar = await fetchSemanticScholarPaper(ref.arxivId, fetchImpl);
    if (viaSemanticScholar) return viaSemanticScholar;
    const viaArxiv = await fetchArxivPaper(ref.arxivId, fetchImpl);
    if (viaArxiv) return viaArxiv;
  }
  if (ref.titleGuess) {
    const viaSemanticScholar = await searchSemanticScholarByTitle(ref.titleGuess, fetchImpl);
    if (viaSemanticScholar) return viaSemanticScholar;
    const viaArxiv = await searchArxivByTitle(ref.titleGuess, fetchImpl);
    if (viaArxiv) return viaArxiv;
  }
  return null;
}
