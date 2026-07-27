// Record/replay layer for the eval harness (evals/run.ts). Both generateVisual
// and generateResearch already accept an injectable fetch implementation, so
// wrapping that is enough to make a live run reproducible offline: record once
// against the real Groq/Gemini endpoints, then every later `bun run eval`
// replays the exact same bytes with zero network calls and zero API spend.
//
// This is a dev/CI tool, not application code — it does real filesystem I/O
// and is only ever imported from evals/*.ts or its own tests.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface CassetteEntry {
  url: string;
  method: string;
  requestBody: string;
  status: number;
  responseBody: string;
}

export interface Cassette {
  name: string;
  entries: CassetteEntry[];
}

export function cassettePath(dir: string, name: string): string {
  return path.join(dir, `${name}.json`);
}

export async function loadCassette(dir: string, name: string): Promise<Cassette | null> {
  const p = cassettePath(dir, name);
  if (!existsSync(p)) return null;
  const raw = await readFile(p, "utf-8");
  return JSON.parse(raw) as Cassette;
}

export async function saveCassette(dir: string, cassette: Cassette): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(cassettePath(dir, cassette.name), JSON.stringify(cassette, null, 2));
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Same record/replay idea as above, but for non-fetch-shaped SDK calls (e.g.
 * @google/genai's `generateContent`, which research.server.ts accepts as an
 * injectable `generateContentImpl`). Args and results are JSON-serialized
 * into the same cassette file format so tooling doesn't need to distinguish
 * cassette kinds.
 */
export function recordingCall<TArgs, TResult>(
  dir: string,
  name: string,
  realCall: (args: TArgs) => Promise<TResult>,
): (args: TArgs) => Promise<TResult> {
  const entries: CassetteEntry[] = [];
  return async (args: TArgs) => {
    const result = await realCall(args);
    entries.push({
      url: "call",
      method: "CALL",
      requestBody: JSON.stringify(args),
      status: 200,
      responseBody: JSON.stringify(result),
    });
    await saveCassette(dir, { name, entries });
    return result;
  };
}

export function replayingCall<TResult>(cassette: Cassette): (args: unknown) => Promise<TResult> {
  let index = 0;
  return async () => {
    const entry = cassette.entries[index];
    if (!entry) {
      throw new Error(
        `Cassette "${cassette.name}" exhausted after ${index} replayed call(s) — re-record with --record to capture more coverage.`,
      );
    }
    index += 1;
    return JSON.parse(entry.responseBody) as TResult;
  };
}
