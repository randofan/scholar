#!/usr/bin/env bun
// One-off (but reusable) utility: synthesize plausible, schema-valid
// cassette fixtures for evals/cases.json when no live GROQ_API_KEY /
// GEMINI_API_KEY is available to record real ones. Uses the REAL
// pickStrictKind() so synthesized visualize payloads always match the kind
// the code would actually request — a hand-maintained kind mapping here
// would silently drift out of sync with illustrate.server.ts over time.
//
// This produces a starter baseline for `bun evals/run.ts --check` to compare
// against. It is NOT a substitute for periodically recording real cassettes
// with `bun evals/run.ts --live --record` against a real provider — do that
// whenever you have API access, so the eval corpus reflects real model
// output, not hand-authored placeholders.
//
// Usage: bun evals/synth-fixtures.ts

import { readFile } from "node:fs/promises";
import path from "node:path";
import { saveCassette } from "./cassette";
import { pickStrictKind, type IllustrateInput } from "../src/lib/scholar/illustrate.server";

const EVALS_DIR = import.meta.dirname;
const CASSETTE_DIR = path.join(EVALS_DIR, "cassettes");
const CASES_PATH = path.join(EVALS_DIR, "cases.json");

interface VisualizeCase {
  id: string;
  type: "visualize";
  topic: string;
  hint?: string;
  pdfExcerpt: string;
}
interface ResearchCase {
  id: string;
  type: "research";
  query: string;
  pdfExcerpt?: string;
}
type EvalCase = VisualizeCase | ResearchCase;

function synthPayload(
  kind: ReturnType<typeof pickStrictKind>,
  c: VisualizeCase,
): Record<string, unknown> {
  const title = c.topic.slice(0, 60);
  const narration = `Illustrates ${c.topic.toLowerCase()} with concrete, labeled detail.`.slice(
    0,
    140,
  );

  switch (kind) {
    case "diagram": {
      const isMindmap = /mindmap/i.test(c.hint ?? "");
      const mermaid = isMindmap
        ? `mindmap\n  root((${title}))\n    Aspect one\n      Detail A\n    Aspect two\n      Detail B\n    Aspect three\n      Detail C`
        : `flowchart LR\n  A[Input] --> B[Process]\n  B --> C{Decision}\n  C -- yes --> D[Path A]\n  C -- no --> E[Path B]`;
      return { title, narration, mermaid };
    }
    case "table":
      return {
        title,
        narration,
        columns: ["Dimension", "Baseline", "Proposed"],
        rows: [
          ["Cost", "High", "Low"],
          ["Throughput", "Moderate", "High"],
          ["Complexity", "Low", "Moderate"],
        ],
      };
    case "math":
      return {
        title,
        narration,
        inline: "",
        steps: ["f(x) = \\sum_{i=1}^{n} w_i x_i", "\\nabla f(x) = w", "x^{*} = \\arg\\min_x f(x)"],
      };
    case "chart":
      return {
        title,
        narration,
        chartType: "line",
        xLabel: "Input size (units)",
        yLabel: "Measured value (ms)",
        series: [
          {
            name: "Series A",
            points: Array.from({ length: 10 }, (_, i) => ({
              x: String((i + 1) * 8),
              y: 10 + i * 3.2,
            })),
          },
        ],
      };
  }
}

async function synthVisualize(c: VisualizeCase) {
  const kind = pickStrictKind({
    topic: c.topic,
    hint: c.hint,
    pdfExcerpt: c.pdfExcerpt,
  } satisfies IllustrateInput);
  const payload = synthPayload(kind, c);
  const responseBody = JSON.stringify({
    choices: [{ message: { content: JSON.stringify(payload) } }],
  });
  await saveCassette(CASSETTE_DIR, {
    name: c.id,
    entries: [
      {
        url: "https://api.groq.com/openai/v1/chat/completions",
        method: "POST",
        requestBody: "",
        status: 200,
        responseBody,
      },
    ],
  });
  console.log(`wrote ${c.id} (kind=${kind})`);
}

async function synthResearch(c: ResearchCase) {
  const summary = `Background context on ${c.query}: prior approaches trade off complexity against robustness, and this line of work extends earlier results with a more general analysis and stronger empirical validation across several benchmark settings.`;
  const keyPoints = [
    `Prior work established the baseline approach referenced by "${c.query}".`,
    "Later extensions generalized the technique to a broader class of settings.",
    "Empirical results consistently favor the more recent variants on standard benchmarks.",
  ];
  const responseBody = JSON.stringify({ text: JSON.stringify({ summary, keyPoints }) });
  await saveCassette(CASSETTE_DIR, {
    name: c.id,
    entries: [{ url: "call", method: "CALL", requestBody: "", status: 200, responseBody }],
  });
  console.log(`wrote ${c.id} (research)`);
}

async function main() {
  const cases = JSON.parse(await readFile(CASES_PATH, "utf-8")) as EvalCase[];
  for (const c of cases) {
    if (c.type === "visualize") await synthVisualize(c);
    else await synthResearch(c);
  }
}

void main();
