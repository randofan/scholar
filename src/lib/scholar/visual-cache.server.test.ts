import { describe, expect, it } from "vitest";
import { loadCachedVisual, storeCachedVisual, visualCacheKey } from "./visual-cache.server";
import type { R2BucketLike } from "@/lib/cf-bindings";
import type { Visual } from "./illustrate.server";

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

const sampleVisual: Visual = {
  kind: "table",
  title: "Comparison of RNG methods",
  headers: ["Method", "Throughput"],
  rows: [["Xorshift", "fast"]],
} as unknown as Visual;

describe("visualCacheKey", () => {
  it("is deterministic for identical inputs", async () => {
    const a = await visualCacheKey("Expander graphs", "hint", "excerpt text", "diagram");
    const b = await visualCacheKey("Expander graphs", "hint", "excerpt text", "diagram");
    expect(a).toBe(b);
  });

  it("is case/whitespace-insensitive for topic and hint", async () => {
    const a = await visualCacheKey("Expander Graphs", "  Hint  ", "excerpt", "diagram");
    const b = await visualCacheKey("expander graphs", "hint", "excerpt", "diagram");
    expect(a).toBe(b);
  });

  it("differs when the topic differs", async () => {
    const a = await visualCacheKey("Expander graphs", undefined, undefined, "diagram");
    const b = await visualCacheKey("Fat trees", undefined, undefined, "diagram");
    expect(a).not.toBe(b);
  });

  it("differs when the kind differs", async () => {
    const a = await visualCacheKey("Expander graphs", undefined, undefined, "diagram");
    const b = await visualCacheKey("Expander graphs", undefined, undefined, "chart");
    expect(a).not.toBe(b);
  });

  it("differs when the pdfExcerpt differs, even with identical topic/hint (prevents cross-paper collisions)", async () => {
    const a = await visualCacheKey(
      "Architecture overview",
      "diagram",
      "Paper A discusses expander graphs.",
      "diagram",
    );
    const b = await visualCacheKey(
      "Architecture overview",
      "diagram",
      "Paper B discusses fat trees.",
      "diagram",
    );
    expect(a).not.toBe(b);
  });

  it("treats undefined and empty-string hint the same", async () => {
    const a = await visualCacheKey("Topic", undefined, "excerpt", "diagram");
    const b = await visualCacheKey("Topic", "", "excerpt", "diagram");
    expect(a).toBe(b);
  });
});

describe("loadCachedVisual / storeCachedVisual", () => {
  it("returns null when no bucket is configured", async () => {
    expect(await loadCachedVisual(undefined, "Topic", undefined, undefined, "diagram")).toBeNull();
  });

  it("returns null on a cache miss", async () => {
    const { bucket } = memoryBucket();
    expect(await loadCachedVisual(bucket, "Topic", undefined, undefined, "diagram")).toBeNull();
  });

  it("round-trips a stored visual on a cache hit", async () => {
    const { bucket } = memoryBucket();
    await storeCachedVisual(bucket, "Expander graphs", "hint", "excerpt", "table", sampleVisual);
    const hit = await loadCachedVisual(bucket, "Expander graphs", "hint", "excerpt", "table");
    expect(hit).toEqual(sampleVisual);
  });

  it("misses when any input used to derive the key changes", async () => {
    const { bucket } = memoryBucket();
    await storeCachedVisual(bucket, "Expander graphs", "hint", "excerpt", "table", sampleVisual);
    expect(
      await loadCachedVisual(bucket, "Expander graphs", "different hint", "excerpt", "table"),
    ).toBeNull();
  });

  it("storeCachedVisual is a no-op when no bucket is configured (does not throw)", async () => {
    await expect(
      storeCachedVisual(undefined, "Topic", undefined, undefined, "diagram", sampleVisual),
    ).resolves.toBeUndefined();
  });

  it("degrades to null instead of throwing when the bucket read fails", async () => {
    const bucket: R2BucketLike = {
      get: async () => {
        throw new Error("R2 unavailable");
      },
      put: async () => {},
    };
    expect(await loadCachedVisual(bucket, "Topic", undefined, undefined, "diagram")).toBeNull();
  });

  it("degrades gracefully instead of throwing when the bucket write fails", async () => {
    const bucket: R2BucketLike = {
      get: async () => null,
      put: async () => {
        throw new Error("R2 unavailable");
      },
    };
    await expect(
      storeCachedVisual(bucket, "Topic", undefined, undefined, "diagram", sampleVisual),
    ).resolves.toBeUndefined();
  });

  it("degrades to null instead of throwing on a corrupt cached entry", async () => {
    const { bucket } = memoryBucket();
    const key = await visualCacheKey("Topic", undefined, undefined, "diagram");
    await bucket.put(`cache/visuals/${key}.json`, "not json{");
    expect(await loadCachedVisual(bucket, "Topic", undefined, undefined, "diagram")).toBeNull();
  });
});
