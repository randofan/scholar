// Chrome's built-in Gemini Nano (Prompt API) as the sole visual generator.
//
// Why on-device: `visualize` is the latency-critical path in a live voice
// session — the agent keeps talking while the slide renders, so every second
// of network round-trip is a second of the user staring at a spinner. A local
// model has no network hop, no rate limit, and no per-call cost, which also
// means retries are effectively free (see MAX_ATTEMPTS in agent-tools.ts).
//
// The tradeoff is a much smaller model with a hard input quota, which is why
// prompts are per-kind (illustrate-shared.ts) and the paper text is NOT sent:
// the ElevenLabs agent is the one holding the paper, and it passes the
// distilled content down in `facts`. Strong model extracts, weak model formats.
//
// Not named *.client.ts on purpose: every entry point degrades to
// "unavailable" when the global is absent, so this module imports cleanly in
// Node (tests, eval harness) instead of tripping TanStack's client-only
// import protection.
//
// ⚠️ The Prompt API surface has changed across Chrome releases (window.ai →
// ai.languageModel → LanguageModel) and is still gated behind a flag/origin
// trial. Everything here goes through LanguageModelLike so tests inject a fake
// and the real global is touched in exactly one place (resolveLanguageModel).

import {
  STRICT_KIND_SCHEMAS,
  buildSystemPrompt,
  strictPayloadToVisual,
  type StrictKind,
  type Visual,
} from "./illustrate-shared";

/** Minimal shape of a Chrome Prompt API session that we depend on. */
export interface LanguageModelSessionLike {
  prompt(input: string, opts?: { responseConstraint?: unknown }): Promise<string>;
  /** Present on real sessions; used to pre-flight the input quota. */
  measureInputUsage?(input: string): Promise<number>;
  inputQuota?: number;
  destroy?(): void;
}

/** Minimal shape of the `LanguageModel` global. Injectable so tests never touch Chrome. */
export interface LanguageModelLike {
  availability(): Promise<OnDeviceAvailability>;
  create(opts: {
    initialPrompts?: Array<{ role: string; content: string }>;
    temperature?: number;
    topK?: number;
  }): Promise<LanguageModelSessionLike>;
}

export type OnDeviceAvailability = "unavailable" | "downloadable" | "downloading" | "available";

declare global {
  var LanguageModel: LanguageModelLike | undefined;
}

let injected: LanguageModelLike | undefined;

/** Test seam: swap in a fake Prompt API. Pass undefined to restore the real global. */
export function __setLanguageModel(impl: LanguageModelLike | undefined) {
  injected = impl;
  resetOnDeviceSessions();
}

function resolveLanguageModel(): LanguageModelLike | undefined {
  return injected ?? (typeof globalThis !== "undefined" ? globalThis.LanguageModel : undefined);
}

/**
 * Whether on-device generation can serve a request *right now*. "downloadable"
 * and "downloading" are deliberately NOT usable: the model is multiple GB and
 * a voice turn cannot wait on it. Callers should surface those as a friendly
 * "still downloading" state rather than an error.
 */
export async function onDeviceAvailability(): Promise<OnDeviceAvailability> {
  const lm = resolveLanguageModel();
  if (!lm) return "unavailable";
  try {
    return await lm.availability();
  } catch {
    return "unavailable";
  }
}

export async function isOnDeviceReady(): Promise<boolean> {
  return (await onDeviceAvailability()) === "available";
}

// One session per kind, created lazily. The per-kind system prompt is baked in
// at create() time so it is processed once rather than on every slide — the
// mermaid guide alone is ~1,600 tokens and re-sending it per request would
// dominate generation time.
const sessions = new Map<StrictKind, Promise<LanguageModelSessionLike>>();

/** Drop cached sessions — call when skill rules change (they live in the system prompt). */
export function resetOnDeviceSessions() {
  for (const pending of sessions.values()) {
    void pending.then((s) => s.destroy?.()).catch(() => {});
  }
  sessions.clear();
}

function getSession(kind: StrictKind, skillRules: string[]): Promise<LanguageModelSessionLike> {
  const existing = sessions.get(kind);
  if (existing) return existing;

  const lm = resolveLanguageModel();
  if (!lm) return Promise.reject(new Error("on-device model unavailable"));

  const created = lm
    .create({
      initialPrompts: [{ role: "system", content: buildSystemPrompt(kind, skillRules) }],
      temperature: 0.3,
    })
    .catch((err) => {
      // Don't cache a rejected session — the next slide should retry create().
      sessions.delete(kind);
      throw err;
    });
  sessions.set(kind, created);
  return created;
}

export interface OnDeviceVisualInput {
  topic: string;
  /** One line naming the structure to draw. */
  hint?: string;
  /** Paper content supplied by the voice agent — this replaces the old pdfExcerpt. */
  facts?: string;
  /** Titles+kinds already on the canvas, so the model doesn't repeat one. */
  recentVisuals?: Array<{ title: string; kind: string }>;
  /** Validator reason from the previous attempt, fed back verbatim. */
  correction?: string;
}

/** The user-turn prompt. Deliberately tiny — everything static lives in the system prompt. */
export function buildOnDeviceUserPrompt(kind: StrictKind, input: OnDeviceVisualInput): string {
  const recent = (input.recentVisuals ?? [])
    .slice(0, 3)
    .map((r) => `${r.kind}: ${r.title}`)
    .join("; ");
  return [
    `Topic: ${input.topic}`,
    input.hint ? `Structure: ${input.hint}` : "",
    input.facts ? `Facts to use:\n${input.facts.slice(0, 1200)}` : "",
    recent ? `Already on screen (do not repeat): ${recent}` : "",
    `Produce the ${kind} JSON now.`,
    input.correction ? `\nPREVIOUS ATTEMPT FAILED: ${input.correction}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function parseVisualJson(kind: StrictKind, raw: string): Visual {
  const text = raw.trim();
  // responseConstraint should guarantee bare JSON, but small models sometimes
  // still wrap it in a fence or a sentence — recover instead of failing.
  const start = text.search(/[{[]/);
  const candidate = start >= 0 ? text.slice(start, text.lastIndexOf("}") + 1) : text;
  let payload: unknown;
  try {
    payload = JSON.parse(candidate);
  } catch (err) {
    throw new Error(
      `on-device model returned non-JSON for kind=${kind}: ${(err as Error).message}. Head: ${text.slice(0, 160)}`,
    );
  }
  return strictPayloadToVisual(kind, payload);
}

/**
 * One on-device generation attempt. Throws on transport/parse failure; content
 * quality (valid mermaid, real axis labels, no hedging) is NOT checked here —
 * that's the caller's retry loop via runContentValidations, matching how the
 * server path used to work.
 */
export async function generateVisualOnDevice(
  kind: StrictKind,
  input: OnDeviceVisualInput,
  opts: { skillRules?: string[] } = {},
): Promise<Visual> {
  const session = await getSession(kind, opts.skillRules ?? []);
  const userPrompt = buildOnDeviceUserPrompt(kind, input);

  // Pre-flight the quota so an oversized prompt fails with something
  // actionable instead of a generic model error mid-voice-turn.
  if (session.measureInputUsage && typeof session.inputQuota === "number") {
    try {
      const usage = await session.measureInputUsage(userPrompt);
      if (usage > session.inputQuota) {
        throw new Error(
          `prompt for kind=${kind} needs ${usage} tokens but the on-device quota is ${session.inputQuota} — shorten \`facts\``,
        );
      }
    } catch (err) {
      // Only re-throw our own quota error; a failure inside measureInputUsage
      // itself shouldn't block the attempt.
      if (err instanceof Error && err.message.includes("on-device quota")) throw err;
    }
  }

  const raw = await session.prompt(userPrompt, {
    responseConstraint: STRICT_KIND_SCHEMAS[kind],
  });
  return parseVisualJson(kind, raw);
}

const TEASER_SYSTEM_PROMPT = `You write ONE short sentence (under 14 words) previewing a visual that is about to appear. Describe concretely what the viewer will see, e.g. "A flowchart of the three-stage retrieval pipeline". No quotes, no trailing filler like "Loading...", just the preview.`;

let teaserSession: Promise<LanguageModelSessionLike> | undefined;

/**
 * Fast one-line preview shown on the pending slide card while the real visual
 * generates. Best-effort: callers swallow failures, since a missing teaser
 * just means the spinner shows a beat longer.
 */
export async function generateTeaserOnDevice(input: {
  topic: string;
  hint?: string;
}): Promise<string> {
  const lm = resolveLanguageModel();
  if (!lm) throw new Error("on-device model unavailable");
  teaserSession ??= lm
    .create({
      initialPrompts: [{ role: "system", content: TEASER_SYSTEM_PROMPT }],
      temperature: 0.4,
    })
    .catch((err) => {
      teaserSession = undefined;
      throw err;
    });

  const session = await teaserSession;
  const text = await session.prompt(
    `Topic: ${input.topic}${input.hint ? `\nStructure: ${input.hint}` : ""}`,
  );
  const cleaned = text.trim().replace(/^"|"$/g, "");
  if (!cleaned) throw new Error("on-device teaser returned empty content");
  return cleaned.slice(0, 200);
}
