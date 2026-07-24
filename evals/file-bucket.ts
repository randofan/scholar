// Local, file-backed stand-in for R2BucketLike (see src/lib/cf-bindings.ts)
// so the eval harness can exercise skills.server.ts's distillation loop
// without a real Cloudflare R2 binding or network access — same spirit as
// evals/cassette.ts's record/replay for provider calls.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { R2BucketLike } from "../src/lib/cf-bindings";

function keyToPath(dir: string, key: string): string {
  // R2 keys are POSIX-style relative paths (e.g. "skills/visualize.json");
  // strip any ".." segments so a malformed key can't escape `dir`.
  const safeKey = key
    .split("/")
    .filter((segment) => segment !== "" && segment !== "..")
    .join("/");
  return path.join(dir, safeKey);
}

/** Creates an R2BucketLike backed by plain files under `dir`. */
export function createFileBucket(dir: string): R2BucketLike {
  return {
    async get(key: string) {
      try {
        const text = await readFile(keyToPath(dir, key), "utf-8");
        return { text: async () => text };
      } catch {
        return null;
      }
    },
    async put(key: string, value: string) {
      const filePath = keyToPath(dir, key);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, value, "utf-8");
    },
  };
}
