/**
 * Groq is the sole provider for visual generation (the `visualize` tool).
 * It's called via raw fetch against its OpenAI-compatible endpoint using
 * strict structured outputs — see illustrate.server.ts. Research uses
 * Gemini directly via @google/genai (research.server.ts).
 */
export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

/**
 * Groq model IDs. We bias toward the fastest models that still produce
 * usable structured JSON — diagram generation is a small-context task,
 * not a deep-reasoning one.
 */
export const GROQ_MODELS = {
  // Fastest text model. Kept for non-structured calls.
  fast: "llama-3.1-8b-instant",
  // Strong reasoning + tool calling.
  reasoning: "llama-3.3-70b-versatile",
  // Strict structured outputs (constrained decoding). Used for visual generation
  // so the schema is guaranteed and we stop wasting attempts on malformed JSON.
  // Per https://console.groq.com/docs/structured-outputs only openai/gpt-oss-*
  // support strict: true.
  structured: "openai/gpt-oss-20b",
} as const;
