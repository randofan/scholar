// Pure scoring functions for the eval harness (evals/run.ts), split out so
// they're independently unit-testable without needing cassettes, network
// mocks, or the CLI plumbing around them.

import {
  containsHedgeLanguage,
  validateAxisLabels,
  validateMermaid,
  type Visual,
} from "../src/lib/scholar/illustrate.server";
import type { ResearchResult } from "../src/lib/scholar/research.server";

export interface ScoreOutcome {
  checks: Record<string, boolean>;
  reasons: string[];
  pass: boolean;
}

function finalize(checks: Record<string, boolean>, reasons: string[]): ScoreOutcome {
  return { checks, reasons, pass: Object.values(checks).every(Boolean) };
}

export function scoreVisual(visual: Visual): ScoreOutcome {
  const checks: Record<string, boolean> = {};
  const reasons: string[] = [];

  checks.noHedge = !containsHedgeLanguage(visual.narration);
  if (!checks.noHedge) reasons.push("narration contains hedge/meta language");

  if (visual.kind === "diagram" && visual.diagram) {
    const m = validateMermaid(visual.diagram.mermaid);
    checks.mermaidValid = m.ok;
    if (!m.ok) reasons.push(`mermaid: ${m.reason}`);
  }
  if (visual.kind === "chart" && visual.chart) {
    const a = validateAxisLabels(visual.chart);
    checks.axisLabelsValid = a.ok;
    if (!a.ok) reasons.push(`axis labels: ${a.reason}`);
  }

  return finalize(checks, reasons);
}

export function scoreResearch(result: ResearchResult): ScoreOutcome {
  const checks: Record<string, boolean> = {};
  const reasons: string[] = [];

  checks.hasSummary = result.summary.trim().length > 0;
  if (!checks.hasSummary) reasons.push("empty summary");

  checks.noHedge = !containsHedgeLanguage(result.summary);
  if (!checks.noHedge) reasons.push("summary contains hedge/meta language");

  return finalize(checks, reasons);
}
