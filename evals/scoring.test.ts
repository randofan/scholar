import { describe, expect, it } from "vitest";
import { scoreResearch, scoreVisual } from "./scoring";
import type { Visual } from "../src/lib/scholar/illustrate.server";
import type { ResearchResult } from "../src/lib/scholar/research.server";

describe("scoreVisual", () => {
  it("passes a well-formed diagram", () => {
    const visual: Visual = {
      title: "Pipeline",
      narration: "Tokens flow from input through the model to the decoder.",
      kind: "diagram",
      diagram: { mermaid: "flowchart LR\n  A[Input] --> B[Model]\n  B --> C[Decoder]" },
    };
    const outcome = scoreVisual(visual);
    expect(outcome.pass).toBe(true);
    expect(outcome.reasons).toEqual([]);
  });

  it("fails a diagram with invalid mermaid and names the reason", () => {
    const visual: Visual = {
      title: "Broken",
      narration: "A broken diagram.",
      kind: "diagram",
      diagram: { mermaid: "not mermaid at all" },
    };
    const outcome = scoreVisual(visual);
    expect(outcome.pass).toBe(false);
    expect(outcome.checks.mermaidValid).toBe(false);
    expect(outcome.reasons.some((r) => r.startsWith("mermaid:"))).toBe(true);
  });

  it("fails a chart with a generic axis label", () => {
    const visual: Visual = {
      title: "Chart",
      narration: "Throughput scales with batch size.",
      kind: "chart",
      chart: {
        chartType: "line",
        xKey: "x",
        yKeys: ["y"],
        data: [
          { x: "1", y: 1 },
          { x: "2", y: 2 },
        ],
        xLabel: "X",
        yLabel: "Throughput (req/s)",
      },
    };
    const outcome = scoreVisual(visual);
    expect(outcome.pass).toBe(false);
    expect(outcome.checks.axisLabelsValid).toBe(false);
  });

  it("fails a visual whose narration hedges", () => {
    const visual: Visual = {
      title: "Math",
      narration: "The paper does not provide explicit equations for this.",
      kind: "math",
      math: { steps: ["x = 1"] },
    };
    const outcome = scoreVisual(visual);
    expect(outcome.pass).toBe(false);
    expect(outcome.checks.noHedge).toBe(false);
  });

  it("does not apply mermaid/axis checks to kinds that don't have them", () => {
    const visual: Visual = {
      title: "Table",
      narration: "Baseline comparison across three systems.",
      kind: "table",
      table: { columns: ["A", "B"], rows: [["1", "2"]] },
    };
    const outcome = scoreVisual(visual);
    expect(outcome.checks).not.toHaveProperty("mermaidValid");
    expect(outcome.checks).not.toHaveProperty("axisLabelsValid");
    expect(outcome.pass).toBe(true);
  });
});

describe("scoreResearch", () => {
  it("passes a well-formed research result", () => {
    const result: ResearchResult = {
      summary: "Prior work on this topic established several baseline techniques.",
      keyPoints: ["Point one", "Point two"],
    };
    const outcome = scoreResearch(result);
    expect(outcome.pass).toBe(true);
  });

  it("fails an empty summary", () => {
    const result: ResearchResult = { summary: "   ", keyPoints: [] };
    const outcome = scoreResearch(result);
    expect(outcome.pass).toBe(false);
    expect(outcome.checks.hasSummary).toBe(false);
  });

  it("fails a hedging summary", () => {
    const result: ResearchResult = {
      summary: "Not enough information is available to answer this in the provided text.",
      keyPoints: [],
    };
    const outcome = scoreResearch(result);
    expect(outcome.pass).toBe(false);
    expect(outcome.checks.noHedge).toBe(false);
  });
});
