import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadCassette, recordingFetch, replayingFetch, saveCassette } from "./cassette";

let dirs: string[] = [];
async function scratchDir() {
  const d = await mkdtemp(path.join(tmpdir(), "cassette-test-"));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

describe("recordingFetch / loadCassette", () => {
  it("captures each call's request and response and persists after every call", async () => {
    const dir = await scratchDir();
    const real = (async (url: string) =>
      new Response(JSON.stringify({ echoed: url }), { status: 200 })) as typeof fetch;
    const fetchImpl = recordingFetch(dir, "example", real);

    await fetchImpl("https://api.example.com/a", { method: "POST", body: "req-1" });
    // Persisted after the FIRST call already, before the second happens.
    const midway = await loadCassette(dir, "example");
    expect(midway?.entries).toHaveLength(1);

    await fetchImpl("https://api.example.com/b", { method: "POST", body: "req-2" });
    const final = await loadCassette(dir, "example");
    expect(final?.entries).toHaveLength(2);
    expect(final?.entries[0].url).toBe("https://api.example.com/a");
    expect(JSON.parse(final!.entries[1].responseBody)).toEqual({ echoed: "https://api.example.com/b" });
  });
});

describe("replayingFetch", () => {
  it("replays saved entries in call order", async () => {
    const dir = await scratchDir();
    await saveCassette(dir, {
      name: "seq",
      entries: [
        { url: "u1", method: "POST", requestBody: "", status: 200, responseBody: '{"n":1}' },
        { url: "u2", method: "POST", requestBody: "", status: 200, responseBody: '{"n":2}' },
      ],
    });
    const cassette = await loadCassette(dir, "seq");
    const fetchImpl = replayingFetch(cassette!);

    const r1 = await fetchImpl("anything");
    const r2 = await fetchImpl("anything");
    expect(await r1.json()).toEqual({ n: 1 });
    expect(await r2.json()).toEqual({ n: 2 });
  });

  it("throws a descriptive error once entries are exhausted", async () => {
    const cassette = { name: "short", entries: [] };
    const fetchImpl = replayingFetch(cassette);
    await expect(fetchImpl("anything")).rejects.toThrow(/exhausted/);
  });
});

describe("loadCassette", () => {
  it("returns null when no cassette file exists", async () => {
    const dir = await scratchDir();
    expect(await loadCassette(dir, "missing")).toBeNull();
  });
});
