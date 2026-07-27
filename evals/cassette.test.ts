import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadCassette, recordingCall, replayingCall, saveCassette } from "./cassette";

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

describe("loadCassette", () => {
  it("returns null when no cassette file exists", async () => {
    const dir = await scratchDir();
    expect(await loadCassette(dir, "missing")).toBeNull();
  });
});

describe("recordingCall / replayingCall (non-fetch SDK calls)", () => {
  it("round-trips arbitrary JSON-serializable args and results", async () => {
    const dir = await scratchDir();
    const real = async (args: { model: string }) => ({ text: `echo:${args.model}` });
    const wrapped = recordingCall<{ model: string }, { text: string }>(dir, "gemini", real);

    const result = await wrapped({ model: "gemini-3.1-flash-lite" });
    expect(result).toEqual({ text: "echo:gemini-3.1-flash-lite" });

    const cassette = await loadCassette(dir, "gemini");
    expect(cassette?.entries).toHaveLength(1);
    expect(JSON.parse(cassette!.entries[0].requestBody)).toEqual({
      model: "gemini-3.1-flash-lite",
    });

    const replay = replayingCall<{ text: string }>(cassette!);
    expect(await replay({})).toEqual({ text: "echo:gemini-3.1-flash-lite" });
  });
});
