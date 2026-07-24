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
 * Wrap a real fetch so every call this cassette makes is captured in order.
 * Persists after each call so a mid-run crash doesn't lose earlier recordings.
 */
export function recordingFetch(dir: string, name: string, realFetch: FetchLike): FetchLike {
  const entries: CassetteEntry[] = [];
  return async (url, init) => {
    const res = await realFetch(url, init);
    const responseBody = await res.clone().text();
    entries.push({
      url: String(url),
      method: init?.method ?? "GET",
      requestBody: String(init?.body ?? ""),
      status: res.status,
      responseBody,
    });
    await saveCassette(dir, { name, entries });
    return res;
  };
}

/**
 * Build a fetch-like function that replays a saved cassette in call order.
 * Throws a descriptive error if more calls happen than were recorded (e.g. a
 * retry loop needing more attempts than the cassette has) rather than
 * returning undefined/garbage.
 */
export function replayingFetch(cassette: Cassette): FetchLike {
  let index = 0;
  return async () => {
    const entry = cassette.entries[index];
    if (!entry) {
      throw new Error(
        `Cassette "${cassette.name}" exhausted after ${index} replayed call(s) — re-record with --record to capture more coverage.`,
      );
    }
    index += 1;
    return new Response(entry.responseBody, {
      status: entry.status,
      headers: { "content-type": "application/json" },
    });
  };
}
