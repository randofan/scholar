import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invalidatePersistedSkillRules,
  loadPersistedSkillRules,
  mergeSkillRules,
} from "./skill-rules";

afterEach(() => invalidatePersistedSkillRules());

describe("loadPersistedSkillRules", () => {
  it("fetches the distilled rules once and caches them across calls", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ ok: true, rulesByKind: { diagram: ["balance every bracket pair"] } }),
      );

    expect(await loadPersistedSkillRules(fetchImpl)).toEqual({
      diagram: ["balance every bracket pair"],
    });
    await loadPersistedSkillRules(fetchImpl);
    await loadPersistedSkillRules(fetchImpl);

    // A per-slide round trip would defeat the point of generating locally.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after invalidation, so a distill run is picked up", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, rulesByKind: { diagram: ["old"] } }))
      .mockResolvedValueOnce(Response.json({ ok: true, rulesByKind: { diagram: ["new"] } }));

    expect((await loadPersistedSkillRules(fetchImpl)).diagram).toEqual(["old"]);
    invalidatePersistedSkillRules();
    expect((await loadPersistedSkillRules(fetchImpl)).diagram).toEqual(["new"]);
  });

  it("degrades to no rules when R2 is unconfigured, rather than breaking generation", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ ok: false, error: "R2 skills bucket not configured" }, { status: 503 }),
      );
    expect(await loadPersistedSkillRules(fetchImpl)).toEqual({});
  });

  it("degrades to no rules when the request throws", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    expect(await loadPersistedSkillRules(fetchImpl)).toEqual({});
  });
});

describe("mergeSkillRules", () => {
  it("puts distilled rules ahead of raw session lessons", () => {
    expect(mergeSkillRules(["distilled rule"], ["raw session lesson"])).toEqual([
      "distilled rule",
      "raw session lesson",
    ]);
  });

  it("dedupes case-insensitively so a distilled rule is not repeated by its raw origin", () => {
    expect(mergeSkillRules(["Balance every bracket pair"], ["balance every bracket pair"])).toEqual(
      ["Balance every bracket pair"],
    );
  });

  it("caps both sources — this text lands in a system prompt with a tight quota", () => {
    const persisted = Array.from({ length: 20 }, (_, i) => `persisted ${i}`);
    const session = Array.from({ length: 20 }, (_, i) => `session ${i}`);
    const merged = mergeSkillRules(persisted, session);
    expect(merged.length).toBeLessThanOrEqual(14);
    expect(merged[0]).toBe("persisted 0");
    // Session lessons are kept from the END — the most recent failures.
    expect(merged).toContain("session 19");
    expect(merged).not.toContain("session 0");
  });

  it("handles either side being absent", () => {
    expect(mergeSkillRules(undefined, ["only session"])).toEqual(["only session"]);
    expect(mergeSkillRules(["only persisted"], undefined)).toEqual(["only persisted"]);
    expect(mergeSkillRules()).toEqual([]);
  });
});
