// Authoritative mermaid validation: mermaid's OWN parser, not our
// approximation of it.
//
// validateMermaid() in illustrate-shared.ts is a hand-rolled structural check
// (header keyword, bracket balance, mindmap/flowchart syntax bleed). It is
// fast, synchronous, isomorphic, and produces precise human-readable reasons
// that make good retry corrections — but it is fundamentally an approximation
// of mermaid's grammar, so it has always had a false-negative class: sources
// it accepts that mermaid.render() then rejects. That gap is exactly why
// regenerateAfterRenderFailure exists as a post-render safety net.
//
// Now that generation runs in the browser, mermaid itself is already loaded
// and we can close that gap inside the generation loop: mermaid.parse() runs
// the real grammar and reports the real error. A diagram that clears this
// cannot fail to render for syntax reasons, so the loop can genuinely
// guarantee renderable output rather than merely probable output.
//
// Kept separate from illustrate-shared.ts on purpose: that module must stay
// import-clean for Node (tests, eval harness), and mermaid is browser-only.

import { getMermaid } from "./render";
import type { ThemeType } from "./themes";

export type MermaidParseOutcome =
  | { ok: true; checked: true }
  /** mermaid could not be loaded (Node, SSR) — the caller should fall back to the structural check alone. */
  | { ok: true; checked: false }
  | { ok: false; checked: true; reason: string };

/**
 * Run mermaid's real parser over a source string. Never throws: a parse
 * failure is a result, and an environment where mermaid can't load reports
 * `checked: false` so callers can tell "valid" apart from "not verified".
 */
export async function parseMermaid(
  source: string,
  theme: ThemeType = "linearLight",
): Promise<MermaidParseOutcome> {
  if (typeof document === "undefined") return { ok: true, checked: false };

  let mermaid: Awaited<ReturnType<typeof getMermaid>>;
  try {
    mermaid = await getMermaid(theme);
  } catch {
    // No DOM / module unavailable — not a validation failure.
    return { ok: true, checked: false };
  }

  try {
    // Throws a real grammar error when the source is invalid.
    await mermaid.parse(source);
    return { ok: true, checked: true };
  } catch (err) {
    return { ok: false, checked: true, reason: normalizeParseError(err) };
  }
}

/**
 * Mermaid parse errors carry a multi-line caret diagram that is great for a
 * human and terrible for a small model's context budget. Keep the first
 * couple of lines, which name the offending token and line number.
 */
function normalizeParseError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const compact = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");
  return compact.slice(0, 300) || "mermaid rejected the source";
}
