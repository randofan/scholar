// Client-side reader for the persistent, distilled skill files.
//
// This closes the cross-session half of the learning loop. The two halves:
//
//   within a session   validator rejects -> session lesson -> replayed into
//                      the next attempt's system prompt (raw, specific)
//   across sessions    session lessons -> POST /api/skills at hangup ->
//                      Workers AI generalizes them -> R2 -> fetched HERE ->
//                      folded into every future generation's system prompt
//
// The second half was dead for a while: generation moved on-device, which
// removed /api/illustrate — the only thing that used to read the skill file
// back. Rules were being written and never read, so the system re-learned the
// same lessons every session instead of starting each one smarter.
//
// Fetched once per page load and cached: skill files only change at session
// end, and a per-slide round trip would defeat the point of generating
// locally.
//
// Not named *.client.ts despite being browser-facing: every path degrades to
// "no rules" when the fetch fails, so this imports cleanly in Node (tests)
// rather than tripping TanStack's client-only import protection.

import type { StrictKind } from "./illustrate-shared";

interface SkillsResponse {
  ok?: boolean;
  rulesByKind?: Partial<Record<StrictKind, string[]>>;
}

let cache: Promise<Partial<Record<StrictKind, string[]>>> | null = null;

/**
 * Distilled rules for every kind, fetched once. Returns {} on any failure —
 * a missing R2 binding (plain `vite dev`) or an offline worker must degrade
 * to "no learned rules", never break generation.
 */
export function loadPersistedSkillRules(
  fetchImpl: typeof fetch = fetch,
): Promise<Partial<Record<StrictKind, string[]>>> {
  cache ??= (async () => {
    try {
      const res = await fetchImpl("/api/skills");
      if (!res.ok) return {};
      const json = (await res.json()) as SkillsResponse;
      return json.rulesByKind ?? {};
    } catch {
      return {};
    }
  })();
  return cache;
}

/** Drop the cache so the next read re-fetches — call after a distill run. */
export function invalidatePersistedSkillRules() {
  cache = null;
}

/** Prime the cache in the background (e.g. on PDF load) so the first slide doesn't wait on it. */
export function prefetchPersistedSkillRules(fetchImpl: typeof fetch = fetch) {
  void loadPersistedSkillRules(fetchImpl).catch(() => {});
}

const MAX_PERSISTED = 8;
const MAX_SESSION = 6;

/**
 * The rules handed to one generation, distilled-first.
 *
 * Ordering is deliberate. Persisted rules have survived a Workers AI
 * generalization pass, so they read as reusable instructions ("balance every
 * bracket pair before emitting"). Session lessons are raw validator output
 * from minutes ago — more specific, noisier, but describing a failure this
 * exact model just made on this exact paper. Distilled rules lead; session
 * lessons follow as recent-and-relevant context.
 *
 * Both are capped: this text goes into the system prompt of a model with a
 * few thousand tokens of input quota, and the diagram prompt already spends
 * ~1,600 of them on the mermaid guide.
 */
export function mergeSkillRules(persisted: string[] = [], session: string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (rule: string) => {
    const trimmed = rule.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };
  persisted.slice(0, MAX_PERSISTED).forEach(push);
  session.slice(-MAX_SESSION).forEach(push);
  return out;
}
