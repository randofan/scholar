import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFileBucket } from "./file-bucket";
import {
  distillLessonsIntoSkill,
  loadSkillRules,
  skillKeyForKind,
} from "../src/lib/scholar/skills.server";

let dirs: string[] = [];
async function scratchDir() {
  const d = await mkdtemp(path.join(tmpdir(), "file-bucket-test-"));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

describe("createFileBucket", () => {
  it("returns null for a key that doesn't exist yet", async () => {
    const bucket = createFileBucket(await scratchDir());
    expect(await bucket.get("skills/visualize.json")).toBeNull();
  });

  it("round-trips a value through put then get", async () => {
    const bucket = createFileBucket(await scratchDir());
    await bucket.put("skills/visualize.json", '{"rules":["a rule"]}');
    const obj = await bucket.get("skills/visualize.json");
    expect(await obj?.text()).toBe('{"rules":["a rule"]}');
  });

  it("creates nested directories implied by the key", async () => {
    const dir = await scratchDir();
    const bucket = createFileBucket(dir);
    await bucket.put("a/b/c/file.json", "content");
    expect(await readFile(path.join(dir, "a/b/c/file.json"), "utf-8")).toBe("content");
  });

  it("persists across separate createFileBucket calls against the same directory", async () => {
    const dir = await scratchDir();
    await createFileBucket(dir).put("key.json", "value");
    expect(
      await createFileBucket(dir)
        .get("key.json")
        .then((o) => o?.text()),
    ).toBe("value");
  });

  it("does not allow a key to escape the base directory via ..", async () => {
    const dir = await scratchDir();
    const bucket = createFileBucket(dir);
    await bucket.put("../escape.json", "should stay contained");
    const escapedPath = path.join(dir, "..", "escape.json");
    await expect(readFile(escapedPath, "utf-8")).rejects.toThrow();
    // It still gets written somewhere inside dir, retrievable via the same key.
    expect(await bucket.get("../escape.json").then((o) => o?.text())).toBe("should stay contained");
  });
});

describe("createFileBucket integration with distillLessonsIntoSkill", () => {
  it("persists distilled rules to disk and reloads them via a fresh bucket instance", async () => {
    const dir = await scratchDir();
    const lessons = ["mermaid mindmap bodies must never contain --> arrows"];

    const rules = await distillLessonsIntoSkill(
      createFileBucket(dir),
      undefined,
      lessons,
      "diagram",
    );
    expect(rules).toContain(lessons[0]);

    // A brand new bucket instance pointed at the same directory sees the
    // same rules — proves this is real on-disk persistence, not in-memory.
    const reloaded = await loadSkillRules(createFileBucket(dir), "diagram");
    expect(reloaded).toEqual(rules);

    const raw = JSON.parse(await readFile(path.join(dir, skillKeyForKind("diagram")), "utf-8"));
    expect(raw.rules).toEqual(rules);
  });
});
