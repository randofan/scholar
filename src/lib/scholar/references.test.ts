import { describe, expect, it } from "vitest";
import { extractReferences } from "./references";

// Mirrors extractPdfText()'s actual output shape: no newlines within a page
// (items are space-joined), pages separated by "\n\n--- Page N ---\n".
function fakePdfText(pages: string[]): string {
  return pages.map((body, i) => `\n\n--- Page ${i + 1} ---\n${body}`).join("");
}

describe("extractReferences", () => {
  it("returns [] when there is no references section", () => {
    const text = fakePdfText([
      "This paper studies expander graphs for RNG design. No bibliography here.",
    ]);
    expect(extractReferences(text)).toEqual([]);
  });

  it("splits a bracket-numbered reference list and extracts arXiv IDs", () => {
    const text = fakePdfText([
      "We build on prior work for random number generation using expander graphs.",
      "References [1] A. Author and B. Coauthor. Random number generation using expander graphs. In Proceedings of STOC, 2019. arXiv:1901.01234 [2] C. Third. Fat-tree topologies for datacenter networks. ACM SIGCOMM, 2015. [3] D. Fourth and E. Fifth. Sparse graph constructions. arXiv:2005.06789v2, 2020.",
    ]);

    const refs = extractReferences(text);
    expect(refs).toHaveLength(3);
    expect(refs.map((r) => r.index)).toEqual([1, 2, 3]);
    expect(refs[0].arxivId).toBe("1901.01234");
    expect(refs[1].arxivId).toBeUndefined();
    // v2 version suffix stripped.
    expect(refs[2].arxivId).toBe("2005.06789");
  });

  it("extracts old-style arXiv IDs (category/number)", () => {
    const text = fakePdfText([
      "References [1] F. Sixth. Early work on graph expansion. arXiv:hep-th/9901001. [2] G. Seventh. Later work, 2003.",
    ]);
    const refs = extractReferences(text);
    expect(refs[0].arxivId).toBe("hep-th/9901001");
  });

  it("extracts a plausible year from each entry", () => {
    const text = fakePdfText([
      "References [1] A. Author. Some title here. Venue (2018). [2] B. Author. Another title. Venue (2021).",
    ]);
    const refs = extractReferences(text);
    expect(refs[0].year).toBe(2018);
    expect(refs[1].year).toBe(2021);
  });

  it("falls back to decimal-numbered splitting when there are no bracket markers", () => {
    const text = fakePdfText([
      "References 1. A. Author. (2017). Title of the first paper. Venue A. 2. B. Author. (2020). Title of the second paper. Venue B.",
    ]);
    const refs = extractReferences(text);
    expect(refs).toHaveLength(2);
    expect(refs[0].index).toBe(1);
    expect(refs[1].index).toBe(2);
  });

  it("guesses a title for the common 'Authors. (Year). Title. Venue.' style", () => {
    const text = fakePdfText([
      "References [1] A. Author and B. Coauthor. (2019). Random number generation using expander graphs. In Proceedings of STOC.",
    ]);
    const refs = extractReferences(text);
    expect(refs[0].titleGuess).toBe("Random number generation using expander graphs");
  });

  it("guesses a title for the IEEE-style 'Authors. Year. Title. Venue.' style (no parens around the year)", () => {
    const text = fakePdfText([
      "References [1] Jung Ho Ahn and Nathan Binkert. 2009. HyperX: topology, routing, and packaging of efficient large-scale networks. In Proceedings of SC.",
    ]);
    const refs = extractReferences(text);
    expect(refs[0].titleGuess).toBe(
      "HyperX: topology, routing, and packaging of efficient large-scale networks",
    );
  });

  it("reconnects a reference entry that spans a page break", () => {
    const text = fakePdfText([
      "References [1] A. Author. Random number generation using",
      "expander graphs. arXiv:1901.01234 [2] B. Author. Something else, 2020.",
    ]);
    const refs = extractReferences(text);
    expect(refs).toHaveLength(2);
    expect(refs[0].raw).not.toContain("--- Page");
    expect(refs[0].arxivId).toBe("1901.01234");
  });

  it("does not mistake an in-text mention of 'references' for the bibliography heading", () => {
    const text = fakePdfText([
      "This section references [12] several prior results without a real bibliography nearby.",
      "Unrelated later content continues the discussion for a while before the paper wraps up.",
      "References [1] A. Author. A real citation. Venue, 2020. [2] B. Author. Another real citation, 2021.",
    ]);
    const refs = extractReferences(text);
    expect(refs).toHaveLength(2);
    expect(refs[0].raw).toContain("A real citation");
  });

  it("stops at a trailing Appendix section instead of treating it as more references", () => {
    const text = fakePdfText([
      "References [1] A. Author. A real citation. Venue, 2020. Appendix A. Extra proofs and details follow that are not citations at all and go on for a while to make sure the cutoff index is comfortably past our minimum-offset guard so it isn't skipped as a false trigger near the start of the section.",
    ]);
    const refs = extractReferences(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].raw).not.toContain("Appendix");
    expect(refs[0].raw).not.toContain("Extra proofs");
  });

  it("stops at the real reference list's end instead of absorbing a trailing appendix that reuses bracket citations", () => {
    // Regression test: found against a real 27-page paper (tests/fixtures/rng-paper.pdf)
    // whose appendix cites earlier references (e.g. "[1]") using the same
    // "[N]" bracket syntax as the reference list itself, which — before the
    // sequential-numbering truncation — caused the last real entry to
    // absorb thousands of characters of unrelated appendix prose.
    // Deliberately has no "Appendix"/"Acknowledgments" heading word — the
    // real PDF that surfaced this bug had none either, so the cutoff-by-
    // keyword guard in sectionText() can't help. Two defenses catch it
    // instead: (1) once citation numbering stops being sequential (the
    // appendix's "[1]"/"[2]" mentions don't continue 1,2,3,...), later
    // "entries" are dropped entirely; (2) even the last kept entry, which
    // can still pick up some immediately-following prose before the next
    // (out-of-sequence) marker, is capped so it can never balloon into a
    // multi-page blob the way the uncapped version did against the real PDF.
    const longTail =
      "Proof of Theorem 1. ".repeat(80) + "As shown in [1], the bound holds. Then [2] extends it.";
    const text = fakePdfText([
      "References [1] A. Author. First real citation. Venue, 2020. [2] B. Author. Second real citation. Venue, 2021.",
      longTail,
    ]);
    const refs = extractReferences(text);
    expect(refs).toHaveLength(2);
    expect(refs[1].raw.length).toBeLessThanOrEqual(700);
    expect(refs[1].raw).not.toContain("bound holds");
  });

  it("falls back to a single raw entry when no numbering pattern is detected", () => {
    const text = fakePdfText([
      "References A. Author, Some Title Without Any Numbering At All, Venue, 2020.",
    ]);
    const refs = extractReferences(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].index).toBeNull();
    expect(refs[0].raw).toContain("Some Title Without Any Numbering");
  });
});
