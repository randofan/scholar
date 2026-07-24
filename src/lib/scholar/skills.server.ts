// Persistent "skill file" for the visualize generator, stored in R2.
//
// The loop: session lessons (validator rejections + browser render failures)
// accumulate client-side during a voice session. When the session ends they
// are POSTed to /api/skills, where Workers AI distills them INTO the skill
// file — generalizing, deduping, and capping. Every subsequent /api/illustrate
// call loads the skill file and injects its rules into the generation prompt,
// so fixes for common failure modes persist across sessions and users.

import type { R2BucketLike, WorkersAiLike } from "@/lib/cf-bindings";

export const VISUALIZE_SKILL_KEY = "skills/visualize.json";
export const MAX_SKILL_RULES = 25;
const MAX_RULE_LENGTH = 200;

// Fast open-weights model on Workers AI; distillation is a small text-merging
// task, not deep reasoning.
export const DISTILL_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export interface SkillFile {
  version: number;
  updatedAt: string;
  rules: string[];
}

function normalizeRule(rule: string) {
  return rule.replace(/\s+/g, " ").trim().slice(0, MAX_RULE_LENGTH);
}

function sanitizeRules(rules: unknown): string[] {
  if (!Array.isArray(rules)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rules) {
    if (typeof r !== "string") continue;
    const normalized = normalizeRule(r);
    if (!normalized || seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    out.push(normalized);
    if (out.length >= MAX_SKILL_RULES) break;
  }
  return out;
}

/** Load the current skill rules from R2. Missing/corrupt file → empty list. */
export async function loadSkillRules(bucket: R2BucketLike | undefined): Promise<string[]> {
  if (!bucket) return [];
  try {
    const obj = await bucket.get(VISUALIZE_SKILL_KEY);
    if (!obj) return [];
    const parsed = JSON.parse(await obj.text()) as Partial<SkillFile>;
    return sanitizeRules(parsed.rules);
  } catch (err) {
    console.warn("skill file load failed", err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Deterministic fallback merge used when Workers AI is unavailable or returns
 * garbage: append new lessons after existing rules, dedupe, cap. Existing
 * rules win the cap fight since they are already distilled.
 */
export function mergeRulesDeterministic(existing: string[], lessons: string[]): string[] {
  return sanitizeRules([...existing, ...lessons]);
}

const DISTILL_SYSTEM_PROMPT = `You maintain a short rules file for an LLM that generates slide visuals (mermaid diagrams, Recharts charts, KaTeX math, tables). You receive the CURRENT RULES and a batch of NEW FAILURE LESSONS observed in a live session (validator rejections and browser render errors).

Produce the updated rules list:
- Merge the lessons into the rules. Generalize specifics into reusable rules (e.g. a lesson quoting one bad line becomes a rule about that syntax mistake).
- Deduplicate aggressively: if a lesson is already covered by a rule, keep the rule.
- Every rule is ONE imperative sentence under ${MAX_RULE_LENGTH} characters, concrete enough to act on.
- At most ${MAX_SKILL_RULES} rules total. Prefer keeping existing rules; drop the least actionable if over the cap.

Return ONLY a JSON object: {"rules": ["...", "..."]}`;

function extractRulesFromAiResult(result: unknown): string[] | null {
  // Workers AI text models return { response: string }; JSON mode may return
  // { response: object } depending on model. Handle both plus raw objects.
  let candidate: unknown = result;
  if (result && typeof result === "object" && "response" in result) {
    candidate = (result as { response: unknown }).response;
  }
  if (typeof candidate === "string") {
    const match = candidate.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      candidate = JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
  if (candidate && typeof candidate === "object" && "rules" in candidate) {
    const rules = sanitizeRules((candidate as { rules: unknown }).rules);
    return rules.length ? rules : null;
  }
  return null;
}

/**
 * Distill a batch of session lessons into the persistent skill file.
 * Uses Workers AI to merge/generalize; falls back to a deterministic merge if
 * the AI binding is missing or its output is unusable, so lessons are never
 * dropped. Returns the updated rules.
 */
export async function distillLessonsIntoSkill(
  bucket: R2BucketLike,
  ai: WorkersAiLike | undefined,
  lessons: string[],
): Promise<string[]> {
  const cleanLessons = sanitizeRules(lessons);
  if (!cleanLessons.length) return loadSkillRules(bucket);

  const existing = await loadSkillRules(bucket);

  let updated: string[] | null = null;
  if (ai) {
    try {
      const result = await ai.run(DISTILL_MODEL, {
        messages: [
          { role: "system", content: DISTILL_SYSTEM_PROMPT },
          {
            role: "user",
            content: `CURRENT RULES:\n${existing.length ? existing.map((r) => `- ${r}`).join("\n") : "(none yet)"}\n\nNEW FAILURE LESSONS:\n${cleanLessons.map((l) => `- ${l}`).join("\n")}`,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            type: "object",
            properties: {
              rules: { type: "array", items: { type: "string" } },
            },
            required: ["rules"],
          },
        },
        max_tokens: 2048,
      });
      updated = extractRulesFromAiResult(result);
    } catch (err) {
      console.warn(
        "skill distillation via Workers AI failed",
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (!updated) updated = mergeRulesDeterministic(existing, cleanLessons);

  const file: SkillFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    rules: updated,
  };
  await bucket.put(VISUALIZE_SKILL_KEY, JSON.stringify(file, null, 2));
  return updated;
}

// Per-isolate cache so /api/illustrate doesn't hit R2 on every slide.
let skillCache: { rules: string[]; fetchedAt: number } | null = null;
const SKILL_CACHE_TTL_MS = 60_000;

export async function loadSkillRulesCached(bucket: R2BucketLike | undefined): Promise<string[]> {
  if (!bucket) return [];
  const now = Date.now();
  if (skillCache && now - skillCache.fetchedAt < SKILL_CACHE_TTL_MS) return skillCache.rules;
  const rules = await loadSkillRules(bucket);
  skillCache = { rules, fetchedAt: now };
  return rules;
}

/** Drop the cache (called after a distill run, and from tests). */
export function invalidateSkillCache() {
  skillCache = null;
}
