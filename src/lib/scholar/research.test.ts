import { describe, expect, it, vi } from "vitest";
import {
  _internals,
  buildCitationContext,
  generateResearch,
  normalizeResearch,
} from "./research.server";
import type { FetchLike } from "./citations.server";

describe("normalizeResearch", () => {
  it("rejects missing summary", () => {
    const res = normalizeResearch({ keyPoints: [] });
    expect(res.ok).toBe(false);
  });

  it("coerces a string keyPoints into an array", () => {
    const res = normalizeResearch({
      summary: "Test summary about a topic.",
      keyPoints: "single point",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result.keyPoints).toEqual(["single point"]);
  });

  it("treats null keyPoints as empty array", () => {
    const res = normalizeResearch({
      summary: "x",
      keyPoints: null,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result.keyPoints).toEqual([]);
  });

  it("trims and dedupes empty bullets", () => {
    const res = normalizeResearch({
      summary: "fine",
      keyPoints: ["a", "  ", "b"],
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result.keyPoints).toEqual(["a", "b"]);
  });

  it("rejects when loose schema doesn't match", () => {
    const res = normalizeResearch("not an object");
    expect(res.ok).toBe(false);
  });
});

describe("buildCitationContext", () => {
  it("resolves candidates and formats a numbered block with title/authors/year/abstract", async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      Response.json({
        title: "Random number generation using expander graphs",
        abstract: "We present a new method for RNG using expander graphs.",
        year: 2019,
        authors: [{ name: "A. Author" }, { name: "B. Coauthor" }],
      }),
    );

    const { block, resolvedCount } = await buildCitationContext(
      [{ arxivId: "1901.01234" }],
      fetchImpl,
    );

    expect(resolvedCount).toBe(1);
    expect(block).toContain('"Random number generation using expander graphs"');
    expect(block).toContain("A. Author, B. Coauthor");
    expect(block).toContain("(2019)");
    expect(block).toContain("We present a new method for RNG using expander graphs.");
  });

  it("drops candidates that fail to resolve instead of leaving gaps", async () => {
    const fetchImpl: FetchLike = vi.fn(async (url) =>
      String(url).includes("arXiv:1111.11111")
        ? Response.json({ title: "Found paper" })
        : new Response("Not Found", { status: 404 }),
    );

    const { block, resolvedCount } = await buildCitationContext(
      [{ arxivId: "1111.11111" }, { arxivId: "0000.00000" }],
      fetchImpl,
    );

    expect(resolvedCount).toBe(1);
    expect(block).toContain("Found paper");
    expect(block.match(/\d+\./g)).toHaveLength(1);
  });

  it("returns an empty block when nothing resolves", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => new Response("Not Found", { status: 404 }));
    const result = await buildCitationContext([{ arxivId: "0000.00000" }], fetchImpl);
    expect(result).toEqual({ block: "", resolvedCount: 0 });
  });

  it("returns an empty block for an empty candidate list without making any request", async () => {
    const fetchImpl = vi.fn();
    const result = await buildCitationContext([], fetchImpl as unknown as FetchLike);
    expect(result).toEqual({ block: "", resolvedCount: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falls back to 'unknown authors' and 'no abstract available' when missing", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => Response.json({ title: "Bare paper" }));
    const { block } = await buildCitationContext([{ arxivId: "1234.56789" }], fetchImpl);
    expect(block).toContain("unknown authors");
    expect(block).toContain("no abstract available");
  });
});

describe("generateResearch failure surfacing", () => {
  it("uses Gemini 3.5 Flash Lite and clamps research generation to one provider call", async () => {
    const generateContentImpl = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        summary: "Grounded summary for the requested background.",
        keyPoints: ["One fact"],
      }),
    });

    const result = await generateResearch(
      { query: "background on expander graphs" },
      { apiKey: "test-key", maxAttempts: 3, generateContentImpl },
    );

    expect(result.attempts).toBe(1);
    expect(generateContentImpl).toHaveBeenCalledTimes(1);
    const call = generateContentImpl.mock.calls[0][0];
    expect(call.model).toBe("gemini-3.1-flash-lite");
    expect(call.config.thinkingConfig).toEqual({ thinkingLevel: "low" });
    // Search grounding is intentionally disabled (rate-limit avoidance).
    expect(call.config.tools).toBeUndefined();
    expect(_internals.GEMINI_MODELS).toEqual(["gemini-3.1-flash-lite"]);
  });

  it("includes a citationContext block in the prompt when provided", async () => {
    const generateContentImpl = vi.fn().mockResolvedValue({
      text: JSON.stringify({ summary: "A grounded summary citing the real paper.", keyPoints: [] }),
    });

    await generateResearch(
      {
        query: "how does this compare to prior expander-graph RNG work",
        citationContext:
          '1. "Random number generation using expander graphs" — A. Author (2019). Abstract: ...',
      },
      { apiKey: "test-key", generateContentImpl },
    );

    const userText = generateContentImpl.mock.calls[0][0].contents[0].parts[0].text;
    expect(userText).toContain("REAL CITED PAPERS");
    expect(userText).toContain("Random number generation using expander graphs");
  });

  it("throws a visible Payment Required error instead of fabricating a stub briefing", async () => {
    const generateContentImpl = vi.fn().mockRejectedValue(new Error("Payment Required"));

    await expect(
      generateResearch(
        {
          query: "related work for lossless BF16 compression",
          pdfExcerpt: "Unweight separates BF16 values into sign, exponent, and mantissa fields.",
        },
        { apiKey: "test-key", maxAttempts: 3, generateContentImpl },
      ),
    ).rejects.toThrow(/credits exhausted|unpaid|quota/i);
    expect(generateContentImpl).toHaveBeenCalledTimes(1);
  });

  it("throws when no AI provider is configured", async () => {
    const prev = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      await expect(generateResearch({ query: "anything" }, { maxAttempts: 1 })).rejects.toThrow(
        /No AI provider configured/,
      );
    } finally {
      if (prev !== undefined) process.env.GEMINI_API_KEY = prev;
    }
  });
});
