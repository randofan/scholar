#!/usr/bin/env bun
// Offline-first eval harness for the two generation paths that make up the
// product loop (visualize, research). Default mode replays committed
// cassettes — zero network calls, zero API spend, fully deterministic — so
// it's safe to run on every change.
//
// `--live` hits real providers for RESEARCH only, gated by `--budget N` so it
// can never blow through a free tier by accident. Visualize has no live mode
// here: it runs on-device in Chrome, which a Bun CLI cannot reach. Its
// cassettes are replayed through the on-device code path instead (see
// cassetteToModelResponses), which still exercises schema decoding, content
// validation, and the retry loop — everything downstream of the model.
//
// Usage:
//   bun evals/run.ts                    # replay mode (default, free)
//   bun evals/run.ts --live --budget 20 # live run, capped at 20 API calls
//   bun evals/run.ts --live --record    # live run that (re)writes cassettes
//   bun evals/run.ts --check            # replay + compare against baseline, exit 1 on regression
//   bun evals/run.ts --case=attention-diagram  # run a single case by id
//   bun evals/run.ts --distill          # also distill failure reasons into evals/skill-store/
//
// --distill closes the loop between "the eval harness catches a regression"
// and "the system learns not to repeat it": every visualize case already
// loads the rules accumulated in evals/skill-store/ (a committed, file-backed
// stand-in for the real R2 skill file — see file-bucket.ts) so a lesson
// learned once keeps getting fed back into every later run, live or replay.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  loadCassette,
  recordingCall,
  recordingFetch,
  replayingCall,
  replayingFetch,
  type Cassette,
} from "./cassette";
import { createFileBucket } from "./file-bucket";
import { generateVisualWithRetries } from "../src/lib/scholar/agent-tools";
import { pickStrictKind } from "../src/lib/scholar/illustrate-shared";
import { __setLanguageModel, type LanguageModelLike } from "../src/lib/scholar/on-device";
import { generateResearch, type GeminiGenerateContent } from "../src/lib/scholar/research.server";
import { distillLessonsIntoSkill, loadSkillRules } from "../src/lib/scholar/skills.server";
import { scoreResearch, scoreVisual } from "./scoring";

const EVALS_DIR = import.meta.dirname;
const CASSETTE_DIR = path.join(EVALS_DIR, "cassettes");
const CASES_PATH = path.join(EVALS_DIR, "cases.json");
const REPORT_PATH = path.join(EVALS_DIR, "report.json");
const BASELINE_PATH = path.join(EVALS_DIR, "baseline.json");
const SKILL_STORE_DIR = path.join(EVALS_DIR, "skill-store");

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
  scope?: "web" | "citations" | "both";
}
type EvalCase = VisualizeCase | ResearchCase;

interface CaseResult {
  id: string;
  type: "visualize" | "research";
  pass: boolean;
  skipped?: string;
  attempts?: number;
  latencyMs?: number;
  kind?: string;
  checks: Record<string, boolean>;
  reasons: string[];
}

interface Report {
  generatedAt: string;
  mode: "replay" | "live";
  total: number;
  passed: number;
  skipped: number;
  passRate: number;
  avgAttempts: number;
  avgLatencyMs: number;
  cases: CaseResult[];
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const isLive = args.includes("--live");
const isRecord = args.includes("--record");
const isCheck = args.includes("--check");
const budgetArg = args.find((a) => a.startsWith("--budget="));
const budget = budgetArg ? Number(budgetArg.split("=")[1]) : 30;
const caseFilterArg = args.find((a) => a.startsWith("--case="));
const caseFilter = caseFilterArg ? caseFilterArg.split("=")[1] : undefined;
const isDistill = args.includes("--distill");

if (isRecord && !isLive) {
  console.error("--record requires --live (nothing to record from replay mode)");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Budget guard — shared across all live calls this run makes.
// ---------------------------------------------------------------------------
let callsMade = 0;
class BudgetExceededError extends Error {}
function checkBudget() {
  if (isLive && callsMade >= budget) {
    throw new BudgetExceededError(`live call budget (${budget}) exhausted`);
  }
}

/**
 * Replay a visualize cassette through the on-device code path.
 *
 * Visualize now runs entirely in-browser against Chrome's Gemini Nano, so
 * there is no HTTP call to record or replay. The committed cassettes are still
 * useful though: the payload the old provider returned is byte-for-byte the
 * shape `session.prompt()` yields under responseConstraint, so unwrapping
 * `choices[0].message.content` gives a faithful stand-in. That keeps the eval
 * corpus, the scorer, and baseline.json meaningful for everything downstream
 * of the model — schema decoding, content validation, and the retry loop —
 * without needing a GPU or a headless Chrome in the loop.
 */
function cassetteToModelResponses(cassette: Cassette): string[] {
  return cassette.entries.map((e) => {
    try {
      const body = JSON.parse(e.responseBody) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return body.choices?.[0]?.message?.content ?? e.responseBody;
    } catch {
      return e.responseBody;
    }
  });
}

/** A fake Prompt API that serves canned responses in order (last one repeats). */
function fakeLanguageModel(responses: string[]): LanguageModelLike {
  let i = 0;
  return {
    availability: async () => "available",
    create: async () => ({
      prompt: async () => {
        const r = responses[Math.min(i, responses.length - 1)];
        i += 1;
        if (r === undefined) throw new Error("cassette exhausted");
        return r;
      },
    }),
  };
}

async function runVisualizeCase(c: VisualizeCase, skillRules: string[]): Promise<CaseResult> {
  if (isLive) {
    return {
      id: c.id,
      type: "visualize",
      pass: false,
      skipped: "visualize runs on-device (Chrome only) — not reachable from a live CLI run",
      checks: {},
      reasons: [],
    };
  }

  const cassette = await loadCassette(CASSETTE_DIR, c.id);
  if (!cassette) {
    return {
      id: c.id,
      type: "visualize",
      pass: false,
      skipped: "no cassette recorded",
      checks: {},
      reasons: [],
    };
  }

  __setLanguageModel(fakeLanguageModel(cassetteToModelResponses(cassette)));
  const kind = pickStrictKind({ topic: c.topic, hint: c.hint });
  const start = Date.now();
  try {
    const { visual, warnings } = await generateVisualWithRetries(
      kind,
      { topic: c.topic, hint: c.hint, facts: c.pdfExcerpt },
      { skillRules, maxAttempts: 2 },
    );
    const latencyMs = Date.now() - start;
    const { checks, reasons, pass } = scoreVisual(visual);
    return {
      id: c.id,
      type: "visualize",
      pass,
      attempts: warnings.length + 1,
      latencyMs,
      kind: visual.kind,
      checks,
      reasons,
    };
  } catch (err) {
    return {
      id: c.id,
      type: "visualize",
      pass: false,
      latencyMs: Date.now() - start,
      checks: { generated: false },
      reasons: [err instanceof Error ? err.message : String(err)],
    };
  } finally {
    __setLanguageModel(undefined);
  }
}

async function runResearchCase(c: ResearchCase): Promise<CaseResult> {
  const cassette = await loadCassette(CASSETTE_DIR, c.id);
  let generateContentImpl: GeminiGenerateContent | undefined;

  if (isLive) {
    checkBudget();
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return {
        id: c.id,
        type: "research",
        pass: false,
        skipped: "GEMINI_API_KEY not set",
        checks: {},
        reasons: [],
      };
    }
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey });
    const real: GeminiGenerateContent = (a) => {
      checkBudget();
      callsMade += 1;
      return ai.models.generateContent(a);
    };
    generateContentImpl = isRecord ? recordingCall(CASSETTE_DIR, c.id, real) : real;
  } else {
    if (!cassette) {
      return {
        id: c.id,
        type: "research",
        pass: false,
        skipped: "no cassette recorded — run with --live --record",
        checks: {},
        reasons: [],
      };
    }
    generateContentImpl = replayingCall(cassette) as GeminiGenerateContent;
  }

  const start = Date.now();
  try {
    const result = await generateResearch(
      { query: c.query, pdfExcerpt: c.pdfExcerpt },
      { apiKey: process.env.GEMINI_API_KEY ?? "cassette-key", generateContentImpl },
    );
    const latencyMs = Date.now() - start;
    const { checks, reasons, pass } = scoreResearch(result.result);
    return {
      id: c.id,
      type: "research",
      pass,
      attempts: result.attempts,
      latencyMs,
      checks,
      reasons,
    };
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      return {
        id: c.id,
        type: "research",
        pass: false,
        skipped: err.message,
        checks: {},
        reasons: [],
      };
    }
    return {
      id: c.id,
      type: "research",
      pass: false,
      latencyMs: Date.now() - start,
      checks: { generated: false },
      reasons: [err instanceof Error ? err.message : String(err)],
    };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const skillBucket = createFileBucket(SKILL_STORE_DIR);
  const skillRules = await loadSkillRules(skillBucket, "diagram");
  if (skillRules.length > 0) {
    console.log(`Loaded ${skillRules.length} learned rule(s) from ${SKILL_STORE_DIR}`);
  }

  const cases = JSON.parse(await readFile(CASES_PATH, "utf-8")) as EvalCase[];
  const selected = caseFilter ? cases.filter((c) => c.id === caseFilter) : cases;
  if (selected.length === 0) {
    console.error(`No cases matched${caseFilter ? ` filter "${caseFilter}"` : ""}.`);
    process.exit(1);
  }

  const results: CaseResult[] = [];
  for (const c of selected) {
    if (isLive && callsMade >= budget) {
      results.push({
        id: c.id,
        type: c.type,
        pass: false,
        skipped: `live call budget (${budget}) exhausted`,
        checks: {},
        reasons: [],
      });
      continue;
    }
    const result =
      c.type === "visualize" ? await runVisualizeCase(c, skillRules) : await runResearchCase(c);
    results.push(result);
    const statusIcon = result.skipped ? "○" : result.pass ? "✓" : "✗";
    console.log(
      `${statusIcon} ${c.id}${result.attempts ? ` (attempts=${result.attempts})` : ""}${result.latencyMs ? ` ${result.latencyMs}ms` : ""}${result.skipped ? ` — ${result.skipped}` : ""}`,
    );
    if (!result.pass && !result.skipped) {
      for (const r of result.reasons) console.log(`    ${r}`);
    }
  }

  const scored = results.filter((r) => !r.skipped);
  const skippedCount = results.length - scored.length;
  const passed = scored.filter((r) => r.pass).length;
  const attemptsSamples = scored.filter((r) => r.attempts != null).map((r) => r.attempts!);
  const latencySamples = scored.filter((r) => r.latencyMs != null).map((r) => r.latencyMs!);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  const report: Report = {
    generatedAt: new Date().toISOString(),
    mode: isLive ? "live" : "replay",
    total: results.length,
    passed,
    skipped: skippedCount,
    passRate: scored.length ? passed / scored.length : 0,
    avgAttempts: avg(attemptsSamples),
    avgLatencyMs: avg(latencySamples),
    cases: results,
  };

  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log("");
  console.log(
    `${passed}/${scored.length} passed (${(report.passRate * 100).toFixed(0)}%), ${skippedCount} skipped, avg ${report.avgAttempts.toFixed(2)} attempts, avg ${report.avgLatencyMs.toFixed(0)}ms`,
  );

  if (isDistill) {
    // No Workers AI binding here — falls back to the deterministic merge
    // (dedupe + cap), which is exactly what a local/CI run should do: no
    // network call, no API spend, still useful.
    const failureReasons = results
      .filter((r) => r.type === "visualize" && !r.pass && !r.skipped)
      .flatMap((r) => r.reasons);
    if (failureReasons.length > 0) {
      const rules = await distillLessonsIntoSkill(
        skillBucket,
        undefined,
        failureReasons,
        "diagram",
      );
      console.log(
        `Distilled ${failureReasons.length} failure reason(s) into ${SKILL_STORE_DIR} (${rules.length} total rule(s)).`,
      );
    } else {
      console.log("--distill: no visualize failures this run — nothing new to distill.");
    }
  }

  if (isCheck) {
    let baseline: Report | null = null;
    try {
      baseline = JSON.parse(await readFile(BASELINE_PATH, "utf-8"));
    } catch {
      console.error(
        `No baseline at ${BASELINE_PATH} — run once and commit evals/baseline.json to enable --check.`,
      );
      process.exit(1);
    }
    if (baseline && report.passRate < baseline.passRate) {
      console.error(
        `REGRESSION: pass rate ${(report.passRate * 100).toFixed(0)}% is below baseline ${(baseline.passRate * 100).toFixed(0)}%`,
      );
      process.exit(1);
    }
    console.log(
      `OK: pass rate ${(report.passRate * 100).toFixed(0)}% meets baseline ${((baseline?.passRate ?? 0) * 100).toFixed(0)}%`,
    );
  }
}

void main();
