import { describe, expect, it } from "vitest";
import { fetchArxivPaper, fetchSemanticScholarPaper, resolveReference } from "./citations.server";

// Both APIs are free/keyless, so there's no API-key env var to gate on like
// the other .live.test.ts files use. Opt in explicitly instead — this
// sandbox's network proxy blocks export.arxiv.org and api.semanticscholar.org
// by default (only an allow-listed set of hosts is reachable), so this suite
// is expected to fail here; it's meant to be run from an environment with
// real outbound network access (e.g. the deployed Worker, or a local dev box).
const runIf = process.env.RUN_LIVE_CITATION_TESTS ? describe : describe.skip;

runIf("citations live clients", () => {
  it("resolves a well-known arXiv paper via arXiv's own API", async () => {
    // "Attention Is All You Need"
    const paper = await fetchArxivPaper("1706.03762");
    expect(paper?.title.toLowerCase()).toContain("attention is all you need");
    expect(paper?.abstract?.length).toBeGreaterThan(50);
  });

  it("resolves the same paper via Semantic Scholar", async () => {
    const paper = await fetchSemanticScholarPaper("1706.03762");
    expect(paper?.title.toLowerCase()).toContain("attention is all you need");
  });

  it("resolveReference prefers Semantic Scholar and gets a real abstract", async () => {
    const paper = await resolveReference({ arxivId: "1706.03762" });
    expect(paper?.source).toBe("semantic-scholar");
    expect(paper?.abstract).toBeTruthy();
  });
});
