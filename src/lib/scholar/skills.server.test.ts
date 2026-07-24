import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DISTILL_MODEL,
  MAX_SKILL_RULES,
  VISUALIZE_SKILL_KEY,
  distillLessonsIntoSkill,
  invalidateSkillCache,
  loadSkillRules,
  loadSkillRulesCached,
  mergeRulesDeterministic,
} from "./skills.server";
import type { R2BucketLike, WorkersAiLike } from "@/lib/cf-bindings";

function memoryBucket(initial?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  const bucket: R2BucketLike = {
    get: async (key) => {
      const value = store.get(key);
      return value === undefined ? null : { text: async () => value };
    },
    put: async (key, value) => {
      store.set(key, value);
    },
  };
  return { bucket, store };
}

const skillFile = (rules: string[]) =>
  JSON.stringify({ version: 1, updatedAt: "2026-01-01T00:00:00Z", rules });

beforeEach(() => {
  invalidateSkillCache();
});

describe("loadSkillRules", () => {
  it("returns [] when the bucket binding is missing", async () => {
    expect(await loadSkillRules(undefined)).toEqual([]);
  });

  it("returns [] when the skill file does not exist", async () => {
    const { bucket } = memoryBucket();
    expect(await loadSkillRules(bucket)).toEqual([]);
  });

  it("returns [] on a corrupt skill file instead of throwing", async () => {
    const { bucket } = memoryBucket({ [VISUALIZE_SKILL_KEY]: "not json{" });
    expect(await loadSkillRules(bucket)).toEqual([]);
  });

  it("loads and sanitizes rules (dedupe, trim, cap)", async () => {
    const many = Array.from({ length: 40 }, (_, i) => `rule number ${i}`);
    const { bucket } = memoryBucket({
      [VISUALIZE_SKILL_KEY]: skillFile(["  keep this  ", "keep this", ...many]),
    });
    const rules = await loadSkillRules(bucket);
    expect(rules[0]).toBe("keep this");
    expect(rules.filter((r) => r === "keep this")).toHaveLength(1);
    expect(rules.length).toBeLessThanOrEqual(MAX_SKILL_RULES);
  });
});

describe("distillLessonsIntoSkill", () => {
  const lessons = [
    "mermaid render error: Parse error on line 2",
    "xLabel was a bare 'X' placeholder",
  ];

  it("merges via Workers AI and persists the updated file", async () => {
    const { bucket, store } = memoryBucket({
      [VISUALIZE_SKILL_KEY]: skillFile(["Always label both chart axes with units"]),
    });
    const ai: WorkersAiLike = {
      run: vi.fn(async () => ({
        response: JSON.stringify({
          rules: [
            "Always label both chart axes with units",
            "Balance every mermaid bracket pair before emitting",
          ],
        }),
      })),
    };

    const rules = await distillLessonsIntoSkill(bucket, ai, lessons);

    expect(ai.run).toHaveBeenCalledWith(
      DISTILL_MODEL,
      expect.objectContaining({ messages: expect.any(Array) }),
    );
    expect(rules).toContain("Balance every mermaid bracket pair before emitting");
    const persisted = JSON.parse(store.get(VISUALIZE_SKILL_KEY)!);
    expect(persisted.rules).toEqual(rules);
  });

  it("passes both current rules and new lessons to the model", async () => {
    const { bucket } = memoryBucket({
      [VISUALIZE_SKILL_KEY]: skillFile(["Existing rule about axis labels"]),
    });
    let capturedInput: { messages?: Array<{ content: string }> } = {};
    const run = vi.fn(async (_model: string, input: Record<string, unknown>) => {
      capturedInput = input as typeof capturedInput;
      return { response: JSON.stringify({ rules: ["merged"] }) };
    });
    await distillLessonsIntoSkill(bucket, { run }, lessons);

    const messages = capturedInput.messages ?? [];
    const userMsg = messages[messages.length - 1].content;
    expect(userMsg).toContain("Existing rule about axis labels");
    expect(userMsg).toContain("Parse error on line 2");
  });

  it("falls back to a deterministic merge when Workers AI throws", async () => {
    const { bucket, store } = memoryBucket({
      [VISUALIZE_SKILL_KEY]: skillFile(["Existing rule"]),
    });
    const ai: WorkersAiLike = {
      run: vi.fn(async () => Promise.reject(new Error("model unavailable"))),
    };

    const rules = await distillLessonsIntoSkill(bucket, ai, lessons);

    expect(rules[0]).toBe("Existing rule");
    expect(rules).toContain("mermaid render error: Parse error on line 2");
    expect(store.get(VISUALIZE_SKILL_KEY)).toBeTruthy();
  });

  it("falls back to a deterministic merge when the AI response is garbage", async () => {
    const { bucket } = memoryBucket();
    const ai: WorkersAiLike = { run: vi.fn(async () => ({ response: "sorry, I cannot do that" })) };

    const rules = await distillLessonsIntoSkill(bucket, ai, lessons);
    expect(rules).toEqual(lessons.map((l) => l));
  });

  it("works without an AI binding at all", async () => {
    const { bucket } = memoryBucket();
    const rules = await distillLessonsIntoSkill(bucket, undefined, lessons);
    expect(rules).toHaveLength(2);
  });

  it("accepts an AI response where response is already an object", async () => {
    const { bucket } = memoryBucket();
    const ai: WorkersAiLike = {
      run: vi.fn(async () => ({ response: { rules: ["object-mode rule"] } })),
    };
    const rules = await distillLessonsIntoSkill(bucket, ai, lessons);
    expect(rules).toEqual(["object-mode rule"]);
  });
});

describe("mergeRulesDeterministic", () => {
  it("keeps existing rules first and caps the total", () => {
    const existing = Array.from({ length: MAX_SKILL_RULES }, (_, i) => `existing ${i}`);
    const merged = mergeRulesDeterministic(existing, ["brand new lesson"]);
    expect(merged).toHaveLength(MAX_SKILL_RULES);
    expect(merged).not.toContain("brand new lesson");
  });

  it("dedupes case-insensitively", () => {
    expect(mergeRulesDeterministic(["Label axes"], ["label axes", "new one"])).toEqual([
      "Label axes",
      "new one",
    ]);
  });
});

describe("loadSkillRulesCached", () => {
  it("caches reads within the TTL", async () => {
    const { bucket, store } = memoryBucket({ [VISUALIZE_SKILL_KEY]: skillFile(["cached rule"]) });
    expect(await loadSkillRulesCached(bucket)).toEqual(["cached rule"]);
    store.set(VISUALIZE_SKILL_KEY, skillFile(["changed rule"]));
    expect(await loadSkillRulesCached(bucket)).toEqual(["cached rule"]);
    invalidateSkillCache();
    expect(await loadSkillRulesCached(bucket)).toEqual(["changed rule"]);
  });
});
