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
  /**
   * Fresh conversation, same initialPrompts. Real sessions have this; fakes in
   * tests may not, so callers must tolerate its absence.
   */
  clone?(): Promise<LanguageModelSessionLike>;
  /** Present on real sessions; used to pre-flight the input quota. */
  measureInputUsage?(input: string): Promise<number>;
  /** Total token budget for this session. */
  inputQuota?: number;
  /** Tokens already consumed by initialPrompts + conversation history. */
  inputUsage?: number;
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

// One TEMPLATE session per kind, created lazily and never prompted directly.
// The per-kind system prompt is baked in at create() time so it is processed
// once rather than on every slide — the mermaid guide alone is ~1,600 tokens.
//
// Prompt API sessions are conversations: every prompt() appends the user turn
// AND the reply to that session's history, charged against inputQuota. Reusing
// one session across slides would therefore accumulate turns until Chrome
// starts evicting oldest-first — and the oldest thing in the session is the
// system prompt carrying all the format rules, so quality would degrade
// silently and in the worst possible way. Each generation clones instead:
// clone() keeps initialPrompts (already processed) but resets the history.
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
  const template = await getSession(kind, opts.skillRules ?? []);
  // Fresh conversation per generation — see the comment on `sessions`. Falls
  // back to the template itself for fakes that don't implement clone().
  const session = (await template.clone?.()) ?? template;
  const userPrompt = buildOnDeviceUserPrompt(kind, input);

  try {
    // Pre-flight against the budget REMAINING after initialPrompts, not the
    // total, so an oversized `facts` fails with something actionable instead
    // of a generic model error mid-voice-turn.
    if (session.measureInputUsage && typeof session.inputQuota === "number") {
      const remaining = session.inputQuota - (session.inputUsage ?? 0);
      let usage: number | undefined;
      try {
        usage = await session.measureInputUsage(userPrompt);
      } catch {
        // measureInputUsage itself failing shouldn't block the attempt.
      }
      if (usage !== undefined && usage > remaining) {
        throw new Error(
          `prompt for kind=${kind} needs ${usage} tokens but only ${remaining} remain of the on-device quota (${session.inputQuota}) — shorten \`facts\``,
        );
      }
    }

    const raw = await session.prompt(userPrompt, {
      responseConstraint: STRICT_KIND_SCHEMAS[kind],
    });
    return parseVisualJson(kind, raw);
  } finally {
    // Only destroy clones; the template is cached for reuse.
    if (session !== template) session.destroy?.();
  }
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

  const template = await teaserSession;
  const session = (await template.clone?.()) ?? template;
  try {
    const text = await session.prompt(
      `Topic: ${input.topic}${input.hint ? `\nStructure: ${input.hint}` : ""}`,
    );
    const cleaned = text.trim().replace(/^"|"$/g, "");
    if (!cleaned) throw new Error("on-device teaser returned empty content");
    return cleaned.slice(0, 200);
  } finally {
    if (session !== template) session.destroy?.();
  }
}
