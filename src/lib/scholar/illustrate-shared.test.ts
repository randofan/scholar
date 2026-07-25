import { describe, expect, it } from "vitest";
import {
  containsHedgeLanguage,
  detectRequestedKind,
  isPromptLikeVisualText,
  validateAxisLabel,
  validateMermaid,
  validateVisual,
  type Visual,
} from "./illustrate-shared";

describe("validateMermaid", () => {
  it("accepts a well-formed flowchart", () => {
    const src = `flowchart TD\n  A[Start] --> B[End]`;
    expect(validateMermaid(src)).toEqual({ ok: true });
  });
  it("accepts sequenceDiagram", () => {
    const src = `sequenceDiagram\n  Alice->>Bob: hello`;
    expect(validateMermaid(src)).toEqual({ ok: true });
  });
  it("rejects missing header", () => {
    const res = validateMermaid(`A --> B\nB --> C`);
    expect(res.ok).toBe(false);
  });
  it("rejects unbalanced brackets", () => {
    const res = validateMermaid(`graph TD\n  A[Start --> B[End]`);
    expect(res.ok).toBe(false);
  });
  it("rejects too few lines", () => {
    const res = validateMermaid(`graph TD`);
    expect(res.ok).toBe(false);
  });

  it("accepts a colon inside a bracketed label (confirmed safe by the mermaid corpus fidelity test)", () => {
    // Was previously rejected on the theory that colons are reserved inside
    // brackets; a real mermaid.render() corpus test (tests/e2e/mermaid-corpus.spec.ts)
    // disproved that, so the validator no longer flags it.
    const res = validateMermaid(`flowchart LR\n  A[Step: detail] --> B[End]`);
    expect(res).toEqual({ ok: true });
  });

  it("accepts a colon inside a mindmap child label", () => {
    const res = validateMermaid(`mindmap\n  root\n    [Child: thing]`);
    expect(res).toEqual({ ok: true });
  });

  it("accepts erDiagram crow's-foot cardinality notation without a false unbalanced-brace rejection", () => {
    const res = validateMermaid(
      `erDiagram\n  PAPER ||--o{ CITATION : references\n  PAPER {\n    string title\n    int year\n  }\n  CITATION {\n    string title\n    string arxivId\n  }`,
    );
    expect(res).toEqual({ ok: true });
  });

  it("still rejects genuinely unbalanced curly braces in an erDiagram entity block", () => {
    const res = validateMermaid(`erDiagram\n  PAPER {\n    string title\n    int year`);
    expect(res.ok).toBe(false);
  });

  it("rejects two chained edges on one flowchart line", () => {
    const res = validateMermaid(`flowchart LR\n  A --> B  B --> C`);
    expect(res.ok).toBe(false);
  });

  it("rejects a bare bracketed node with no ID on a flowchart edge", () => {
    const res = validateMermaid(`flowchart LR\n  [WP0] --> [WP1]`);
    expect(res.ok).toBe(false);
  });

  it("rejects flowchart arrows inside a mindmap", () => {
    const res = validateMermaid(`mindmap\n  root((R))\n  A --> B`);
    expect(res.ok).toBe(false);
  });

  it("rejects chained siblings with edge syntax inside a mindmap", () => {
    const res = validateMermaid(`mindmap\n  root((R5))\n  A -- B\n  A -- C`);
    expect(res.ok).toBe(false);
  });

  it("accepts a well-formed mindmap with indentation-only hierarchy", () => {
    const src = `mindmap\n  root((Paper title))\n    Contribution 1\n      Detail A\n    Contribution 2`;
    expect(validateMermaid(src)).toEqual({ ok: true });
  });

  it("accepts a labeled flowchart edge without flagging it as chained", () => {
    const src = `flowchart LR\n  Q[User query] --> R{Cache hit?}\n  R -- yes --> C[Return cached]`;
    expect(validateMermaid(src)).toEqual({ ok: true });
  });
});
describe("validateAxisLabel", () => {
  it("rejects an empty label", () => {
    expect(validateAxisLabel("", "x").ok).toBe(false);
    expect(validateAxisLabel(undefined, "y").ok).toBe(false);
  });

  it("rejects generic single-word placeholders", () => {
    for (const bad of ["X", "Y", "Value", "Axis", "Metric", "Data", "tbd", "n/a"]) {
      expect(validateAxisLabel(bad, "x").ok).toBe(false);
    }
  });

  it("rejects a single generic word with no unit hint", () => {
    expect(validateAxisLabel("Latency", "y").ok).toBe(false);
  });

  it("accepts a descriptive label with units", () => {
    expect(validateAxisLabel("Latency (ms)", "y")).toEqual({ ok: true });
    expect(validateAxisLabel("Sequence length (tokens)", "x")).toEqual({ ok: true });
  });

  it("accepts a multi-word descriptive label without explicit units", () => {
    expect(validateAxisLabel("Model size", "x")).toEqual({ ok: true });
  });
});
describe("validateVisual", () => {
  it("rejects when kind/spec mismatch", () => {
    const v = { title: "x", narration: "y", kind: "diagram" } as Visual;
    const res = validateVisual(v);
    expect(res.ok).toBe(false);
  });
  it("accepts a complete diagram visual", () => {
    const v: Visual = {
      title: "x",
      narration: "y",
      kind: "diagram",
      diagram: { mermaid: "flowchart LR\n  A --> B" },
    };
    expect(validateVisual(v)).toEqual({ ok: true });
  });
});
describe("detectRequestedKind", () => {
  it.each([
    ["Mathematical Formalism of Expander Graphs", undefined, "math"],
    ["Edge expansion theorem", undefined, "math"],
    ["Spraypoint routing pipeline", "diagram", "diagram"],
    ["Expander graph vs fat tree topology", undefined, "diagram"],
    ["Throughput trend across scales", "chart", "chart"],
    ["Baseline comparison matrix", undefined, "table"],
    ["Key takeaway", "callout", null],
    ["Generic topic with no signal", undefined, null],
  ])("detects kind for topic=%j hint=%j", (topic, hint, expected) => {
    expect(detectRequestedKind({ topic, hint })).toBe(expected);
  });
});
describe("containsHedgeLanguage", () => {
  it.each([
    "The paper does not provide explicit equations.",
    "Not enough information in the excerpt.",
    "No explicit formulas appear in the text.",
    "The text does not contain a diagram.",
    "Insufficient detail to derive the result.",
    "Diagram: Illustrate the concept of edge expansion.",
    "Chart: trend over time",
  ])("flags hedge text: %s", (s) => {
    expect(containsHedgeLanguage(s)).toBe(true);
  });

  it.each([
    "Three contributions: A, B, C with respective ablations.",
    "Edge expansion bounds the second eigenvalue of the adjacency matrix.",
    "BF16 splits into 1 sign, 8 exponent, 7 mantissa bits.",
  ])("does not flag concrete text: %s", (s) => {
    expect(containsHedgeLanguage(s)).toBe(false);
  });
});
describe("prompt-like visual text guardrails", () => {
  it.each([
    "A table comparing RNG and Fat Tree topologies based on cost, performance, and throughput.",
    "summarizing the core problem and solution presented in the paper.",
    "Callout summarizing the contribution list.",
  ])("flags prompt text rendered as a visual: %s", (s) => {
    expect(isPromptLikeVisualText(s)).toBe(true);
  });

  it("does not treat a prompt-ish callout hint as an explicit callout request", () => {
    expect(
      detectRequestedKind({
        topic: "RNG: Flat Datacenter Networks at Scale",
        hint: "Callout summarizing the core problem and solution presented in the paper.",
      }),
    ).toBeNull();
  });

  // Removed: deterministic fallback visuals were eliminated; generation now
  // throws on failure rather than serving hard-coded RNG/Fat-tree content.
});
