// Persistent "skill files" for the visualize generator, stored in R2 — one
// per visual kind.
//
// The loop: session lessons (validator rejections + browser render failures)
// accumulate client-side during a voice session, tagged with the kind that
// produced them. When the session ends they are POSTed to /api/skills, where
// Workers AI distills them INTO that kind's skill file — generalizing,
// deduping, and capping. Every subsequent generation folds the matching
// kind's rules into its system prompt (see buildSystemPrompt), so fixes for
// common failure modes persist across sessions.
//
// Partitioned by kind because these rules come from validator rejections and
// render errors, which are inherently format-specific: a mermaid bracket rule
// is pure noise in a table prompt, and on-device generation has no token
// budget to spare for noise.

import type { R2BucketLike, WorkersAiLike } from "@/lib/cf-bindings";
import type { StrictKind } from "./illustrate-shared";

/** R2 key holding the distilled rules for one visual kind. */
export function skillKeyForKind(kind: StrictKind) {
  return `skills/visualize-${kind}.json`;
}

// Lower than the old global cap of 25 — rules are now scoped to a single
// format, so fewer are relevant, and the on-device input quota is tight.
export const MAX_SKILL_RULES = 8;
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

/** Load one kind's distilled rules from R2. Missing/corrupt file → empty list. */
export async function loadSkillRules(
  bucket: R2BucketLike | undefined,
  kind: StrictKind,
): Promise<string[]> {
  if (!bucket) return [];
  try {
    const obj = await bucket.get(skillKeyForKind(kind));
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

const KIND_DESCRIPTION: Record<StrictKind, string> = {
  diagram: "mermaid diagram sources",
  chart: "Recharts chart specs (series data plus axis labels)",
  math: "KaTeX equation steps",
  table: "table column/row structures",
};

const distillSystemPrompt = (kind: StrictKind) =>
  `You maintain a short rules file for a SMALL on-device LLM that generates ${KIND_DESCRIPTION[kind]}. You receive the CURRENT RULES and a batch of NEW FAILURE LESSONS observed in a live session (validator rejections and browser render errors) for this one format.

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
  kind: StrictKind,
): Promise<string[]> {
  const cleanLessons = sanitizeRules(lessons);
  if (!cleanLessons.length) return loadSkillRules(bucket, kind);

  const existing = await loadSkillRules(bucket, kind);

  let updated: string[] | null = null;
  if (ai) {
    try {
      const result = await ai.run(DISTILL_MODEL, {
        messages: [
          { role: "system", content: distillSystemPrompt(kind) },
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
  await bucket.put(skillKeyForKind(kind), JSON.stringify(file, null, 2));
  return updated;
}
