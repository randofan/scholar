import { GoogleGenAI, Type } from "@google/genai";
import { z } from "zod";
import { resolveReference, type FetchLike, type ResolvedPaper } from "./citations.server";

export const ResearchSchema = z.object({
  summary: z
    .string()
    .min(1)
    .describe(
      "Dense 4-8 sentence briefing for the voice agent. No URLs, no markdown links, no citation markers.",
    ),
  keyPoints: z
    .array(z.string())
    .max(10)
    .default([])
    .describe("Punchy factual bullets the voice agent can drop into a spoken response."),
});

export type ResearchResult = z.infer<typeof ResearchSchema>;

const LooseResearchSchema = z.object({
  summary: z.string().optional().nullable(),
  keyPoints: z.union([z.array(z.string()), z.string(), z.null()]).optional(),
});

export function normalizeResearch(
  raw: unknown,
): { ok: true; result: ResearchResult } | { ok: false; reason: string } {
  const parsed = LooseResearchSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: `loose schema rejected: ${parsed.error.message}` };
  }
  const r = parsed.data;
  const summary = (r.summary ?? "").trim();
  if (!summary) return { ok: false, reason: "summary missing or empty" };

  let keyPoints: string[] = [];
  if (Array.isArray(r.keyPoints))
    keyPoints = r.keyPoints.filter((s) => typeof s === "string" && s.trim().length > 0);
  else if (typeof r.keyPoints === "string" && r.keyPoints.trim()) keyPoints = [r.keyPoints.trim()];
  keyPoints = keyPoints.slice(0, 10);

  return { ok: true, result: { summary, keyPoints } };
}

const SYNTHESIS_SYSTEM = `You are a deep-research librarian feeding factual grounding to a live voice agent.

Synthesize from your training knowledge — you do NOT have web search available on this call. Be confident and concrete; do not hedge about lack of information.

If a "REAL CITED PAPERS" block is provided below, those abstracts were fetched live from arXiv/Semantic Scholar for papers this specific paper actually cites — they are verified, not hallucinated. Ground your answer in them for anything they cover, in preference to your own training-knowledge recall about those specific works.

Final output rules (strict):
- Return a single JSON object matching the schema: {"summary": string, "keyPoints": string[]}.
- "summary" is REQUIRED and non-empty: 4-8 dense sentences. Mention concrete techniques, prior work names, numbers, or definitions. NO URLs, NO markdown link syntax, NO citation markers like [1] or (Smith 2024). The voice agent will speak this aloud.
- "keyPoints": 3-7 short factual bullets, same constraints (no URLs, no link syntax, no citations).
- Do not output a bibliography. The briefing must read as confident grounded knowledge.`;

export interface ResearchInput {
  query: string;
  pdfExcerpt?: string;
  /** Pre-formatted block of real fetched citation abstracts — see buildCitationContext(). */
  citationContext?: string;
}

export interface CitationCandidate {
  arxivId?: string;
  titleGuess?: string;
}

const MAX_CITATION_ABSTRACT_LENGTH = 600;
const MAX_CITATION_CONTEXT_LENGTH = 4000;

/**
 * Resolves a short list of candidate references (see references.ts's
 * rankReferencesByQuery) into real fetched abstracts and formats them into
 * a single block for generateResearch's prompt. Best-effort throughout —
 * resolveReference() already degrades individual lookup failures to null,
 * so this can only ever produce a shorter (possibly empty) block, never throw.
 */
export async function buildCitationContext(
  candidates: CitationCandidate[],
  fetchImpl?: FetchLike,
): Promise<{ block: string; resolvedCount: number }> {
  const resolved = await Promise.all(candidates.map((c) => resolveReference(c, fetchImpl)));
  const papers = resolved.filter((p): p is ResolvedPaper => !!p);
  if (papers.length === 0) return { block: "", resolvedCount: 0 };

  const block = papers
    .map((p, i) => {
      const authors =
        p.authors && p.authors.length > 0 ? p.authors.slice(0, 3).join(", ") : "unknown authors";
      const year = p.year ? ` (${p.year})` : "";
      const abstract = p.abstract
        ? p.abstract.slice(0, MAX_CITATION_ABSTRACT_LENGTH)
        : "no abstract available";
      return `${i + 1}. "${p.title}" — ${authors}${year}. Abstract: ${abstract}`;
    })
    .join("\n")
    .slice(0, MAX_CITATION_CONTEXT_LENGTH);

  return { block, resolvedCount: papers.length };
}

export interface ResearchRunResult {
  result: ResearchResult;
  attempts: number;
  warnings: string[];
  /** Kept for API compatibility; always 0 now that search grounding is disabled. */
  toolCalls: number;
}

// Removed: createFallbackResearch fabricated stub briefings when Gemini failed,
// pretending the research succeeded. We now let generateResearch throw and the
// caller surfaces the failure honestly.

function isBillingOrCreditError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b402\b|payment required|billing|credits? exhausted|insufficient credits|add credits|quota/i.test(
    msg,
  );
}

/** Robust JSON extraction. Gemini may wrap fenced JSON or prepend prose when
 *  Google Search grounding is enabled (it can't strictly enforce the
 *  response schema in that combination). */
export function extractJsonFromText(raw: string): unknown {
  if (!raw) return undefined;
  let cleaned = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
  const start = cleaned.search(/[\{\[]/);
  if (start === -1) return undefined;
  const openChar = cleaned[start];
  const closeChar = openChar === "[" ? "]" : "}";
  let end = cleaned.lastIndexOf(closeChar);
  if (end < start) {
    cleaned = cleaned + closeChar;
    end = cleaned.length - 1;
  }
  const candidate = cleaned.substring(start, end + 1);
  const attempts = [
    candidate,
    candidate.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]"),
    candidate
      .replace(/,\s*}/g, "}")
      .replace(/,\s*]/g, "]")
      .replace(/[\x00-\x1F\x7F]/g, " "),
  ];
  for (const text of attempts) {
    try {
      return JSON.parse(text);
    } catch {
      // try next repair
    }
  }
  return undefined;
}

/**
 * Minimal contract for the Gemini call we make. Lets tests inject a mock
 * without instantiating the real `GoogleGenAI` client.
 */
export type GeminiGenerateContent = (args: {
  model: string;
  contents: Array<{ role: string; parts: Array<{ text: string }> }>;
  config: Record<string, unknown>;
}) => Promise<{ text?: string }>;

function defaultGeminiImpl(apiKey: string): GeminiGenerateContent {
  const ai = new GoogleGenAI({ apiKey });
  return (args) => ai.models.generateContent(args);
}

const GEMINI_MODELS = ["gemini-3.1-flash-lite"] as const;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  required: ["summary", "keyPoints"],
  properties: {
    summary: { type: Type.STRING },
    keyPoints: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
  },
} as const;

export async function generateResearch(
  input: ResearchInput,
  opts: {
    apiKey?: string;
    maxAttempts?: number;
    generateContentImpl?: GeminiGenerateContent;
  } = {},
): Promise<ResearchRunResult> {
  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("No AI provider configured. Set GEMINI_API_KEY to use the research agent.");
  }

  const maxAttempts = Math.min(opts.maxAttempts ?? 1, 1);
  const generateContent = opts.generateContentImpl ?? defaultGeminiImpl(apiKey);

  const warnings: string[] = [];
  let lastError = "";

  // Search grounding is DISABLED — it triggered aggressive Gemini rate limiting
  // and contributed nothing the model couldn't already produce from training
  // knowledge. Pure JSON response, no tool calls.
  const baseConfig: Record<string, unknown> = {
    thinkingConfig: { thinkingLevel: "low" },
    responseMimeType: "application/json",
    responseSchema: RESPONSE_SCHEMA,
    systemInstruction: SYNTHESIS_SYSTEM,
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const modelId = GEMINI_MODELS[Math.min(attempt - 1, GEMINI_MODELS.length - 1)];
    const correction = lastError
      ? `\n\nPREVIOUS ATTEMPT FAILED: ${lastError}\nProduce a corrected JSON briefing that matches the schema exactly.`
      : "";
    const userText = `Research query: ${input.query}
${input.pdfExcerpt ? `\nThe user is reading this paper (excerpt):\n${input.pdfExcerpt.slice(0, 3500)}\n` : ""}${input.citationContext ? `\nREAL CITED PAPERS (fetched live from arXiv/Semantic Scholar for works this paper cites):\n${input.citationContext}\n` : ""}
Return a JSON object matching the schema (summary + keyPoints). No URLs or citations in the values.${correction}`;

    try {
      const { text } = await generateContent({
        model: modelId,
        contents: [{ role: "user", parts: [{ text: userText }] }],
        config: baseConfig,
      });
      // Structured output should already be JSON, but fall back to extraction
      // in case the model wraps it in prose.
      let parsed: unknown;
      try {
        parsed = JSON.parse(text ?? "");
      } catch {
        parsed = extractJsonFromText(text ?? "");
      }
      if (!parsed) {
        lastError = `model returned no parseable JSON briefing. Raw text: ${(text ?? "").slice(0, 400)}`;
        warnings.push(`attempt ${attempt} (${modelId}): no parseable JSON`);
        continue;
      }
      const normalized = normalizeResearch(parsed);
      if (!normalized.ok) {
        lastError = normalized.reason;
        warnings.push(`attempt ${attempt} (${modelId}): ${normalized.reason}`);
        continue;
      }
      return {
        result: normalized.result,
        attempts: attempt,
        warnings,
        toolCalls: 0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown generation error";
      if (isBillingOrCreditError(err)) {
        throw new Error(
          `Gemini rejected the research request as unpaid/credits exhausted or out of quota. (${msg})`,
        );
      }
      lastError = msg;
      warnings.push(`attempt ${attempt} (${modelId}): ${msg}`);
    }
  }

  throw new Error(
    `Failed to generate a valid research briefing after ${maxAttempts} attempts via Gemini. Last error: ${lastError || "unknown"}. Warnings: ${warnings.join(" | ")}`,
  );
}

export const _internals = { extractJsonFromText, GEMINI_MODELS, RESPONSE_SCHEMA };

export { Type };
