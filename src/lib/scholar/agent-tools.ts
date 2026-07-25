import { rankReferencesByQuery, extractReferences } from "./references";
import { runContentValidations, type StrictKind, type Visual } from "./illustrate-shared";
import {
  generateTeaserOnDevice,
  generateVisualOnDevice,
  isOnDeviceReady,
  onDeviceAvailability,
} from "./on-device";
import type { CanvasItem, CanvasItemKind, CanvasSpec, Lesson } from "./store";
import { useScholarStore } from "./store";

export interface ToolHost {
  // Send a contextual update to the live ElevenLabs agent so it can weave the result
  // into its current response without blocking.
  sendContextualUpdate: (text: string) => void;
  canSendContextualUpdate?: () => boolean;
  queueContextualUpdate?: (text: string) => void;
}

let counter = 0;
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

interface IllustrateParams {
  topic: string;
  /** Chosen by the voice agent — selects which per-kind prompt the on-device model gets. */
  kind?: StrictKind;
  hint?: string;
  /**
   * Paper content supplied by the voice agent. The on-device model cannot see
   * the PDF, so this is the only grounding it gets.
   */
  facts?: string;
}

const STRICT_KINDS: StrictKind[] = ["diagram", "chart", "table", "math"];

/** Trust the agent's `kind` when it sent a valid one; otherwise default to diagram. */
function resolveKind(params: IllustrateParams): StrictKind {
  return params.kind && STRICT_KINDS.includes(params.kind) ? params.kind : "diagram";
}

interface ResearchParams {
  query: string;
  scope?: "web" | "citations" | "both";
}

interface ResearchRequestPayload {
  query: string;
  pdfExcerpt?: string;
  scope?: "web" | "citations" | "both";
  citationCandidates?: Array<{ arxivId?: string; titleGuess?: string }>;
}

/**
 * When the agent asks for citation grounding, narrow the paper's full
 * (often 50-70 entry) bibliography down to the handful of references
 * actually relevant to this query — extractReferences() needs the full PDF
 * text (references live at the end, well past the 12k-char excerpt sent for
 * general research), so this runs client-side where that text already
 * lives, and only the ranked candidates (not the whole reference list) go
 * over the wire.
 */
function collectCitationCandidates(query: string, scope: ResearchParams["scope"], pdfText: string) {
  if (scope === "web") return [];
  const refs = extractReferences(pdfText);
  if (refs.length === 0) return [];
  return rankReferencesByQuery(refs, query).map((r) => ({
    arxivId: r.arxivId,
    titleGuess: r.titleGuess,
  }));
}

interface ResearchApiResponse {
  ok?: boolean;
  summary?: string;
  keyPoints?: string[];
  error?: string;
}

function getPdfContext() {
  const pdf = useScholarStore.getState().pdf;
  return {
    text: pdf?.text ?? "",
    title: pdf?.name ?? "",
  };
}

function responsePreview(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 180) || "empty response body";
}

function shouldRetryTransientError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return /non-JSON|upstream|timeout|temporar|network|fetch failed|\b5\d\d\b/i.test(message);
}

// Back-compat alias used in existing tests.
export const shouldRetryResearchError = shouldRetryTransientError;

/**
 * Safely parse a fetch Response as JSON. If the body isn't JSON (e.g. the
 * upstream gateway returned plain text like "upstream request timeout"),
 * throw a controlled error that names the endpoint, status, and a preview
 * of the body — never let `res.json()` blow up with a cryptic SyntaxError.
 */
export async function parseJsonResponse<T>(res: Response, label = "service"): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `${label} returned a non-JSON response (${res.status} ${res.statusText || "unknown status"}): ${responsePreview(text)}`,
    );
  }
}

export async function parseResearchResponse(res: Response): Promise<ResearchApiResponse> {
  return parseJsonResponse<ResearchApiResponse>(res, "Research service");
}

/**
 * POST JSON to an endpoint with retry on transient/non-JSON failures. All
 * tool client fetches (illustrate, research) MUST go through this so no
 * caller ever calls `res.json()` directly on a possibly-non-JSON response.
 */
export async function postJsonWithRetry<TResp>(
  url: string,
  body: unknown,
  label: string,
  fetchImpl: typeof fetch = fetch,
  opts: { attempts?: number; retryDelayMs?: number } = {},
): Promise<TResp> {
  const attempts = opts.attempts ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 500;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await parseJsonResponse<TResp & { ok?: boolean; error?: string }>(res, label);
      if (!res.ok || json.ok === false) {
        throw new Error(json.error ?? `${label} request failed (${res.status})`);
      }
      return json;
    } catch (err) {
      lastError = err;
      if (attempt >= attempts || !shouldRetryTransientError(err)) break;
      if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
}

export async function fetchResearchBriefing(
  payload: ResearchRequestPayload,
  fetchImpl: typeof fetch = fetch,
  opts: { attempts?: number; retryDelayMs?: number } = {},
) {
  return postJsonWithRetry<ResearchApiResponse>(
    "/api/research",
    payload,
    "Research service",
    fetchImpl,
    { attempts: 1, ...opts },
  );
}

/**
 * Generate one visual on-device, retrying with the validator's exact rejection
 * reason fed back as a correction. Retries are affordable here in a way they
 * never were against a metered API — no network, no rate limit, no cost — so
 * the budget is higher than the old server loop's 2 attempts.
 *
 * Returns the accepted visual plus every reason rejected along the way, which
 * become kind-scoped lessons for the persistent skill file.
 */
const MAX_ATTEMPTS = 5;

export interface VisualRequest {
  topic: string;
  hint?: string;
  facts?: string;
  recentVisuals?: Array<{ title: string; kind: string }>;
  correction?: string;
}

export async function generateVisualWithRetries(
  kind: StrictKind,
  input: VisualRequest,
  opts: { skillRules?: string[]; maxAttempts?: number } = {},
): Promise<{ visual: Visual; warnings: string[] }> {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const warnings: string[] = [];
  let correction = input.correction;
  let lastError = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const visual = await generateVisualOnDevice(kind, { ...input, correction }, opts);
      const check = runContentValidations(visual);
      if (check.ok) return { visual, warnings };
      warnings.push(check.reason);
      correction = check.reason;
      lastError = check.reason;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(msg);
      correction = msg;
      lastError = msg;
    }
  }

  throw new Error(
    `on-device generation failed after ${maxAttempts} attempts (kind=${kind}). Last: ${lastError}`,
  );
}

/**
 * Two-phase reveal: while the real visual generates, patch the pending canvas
 * card with a fast one-line preview so the user sees something concrete almost
 * immediately instead of a bare spinner. Best-effort and silent on failure —
 * the real generation's narration overwrites this regardless, so a missing
 * teaser just means the spinner shows a beat longer.
 */
function dispatchVisualTeaser(id: string, params: IllustrateParams) {
  void (async () => {
    try {
      const teaser = await generateTeaserOnDevice({ topic: params.topic, hint: params.hint });
      const stillPending =
        useScholarStore.getState().canvasItems.find((c) => c.id === id)?.status === "pending";
      if (teaser && stillPending) {
        useScholarStore.getState().patchCanvas(id, { narration: teaser });
      }
    } catch {
      // Silent — see doc comment above.
    }
  })();
}

export function deliverContextualUpdate(host: ToolHost, text: string) {
  if (host.canSendContextualUpdate && !host.canSendContextualUpdate()) {
    host.queueContextualUpdate?.(text);
    return false;
  }
  try {
    host.sendContextualUpdate(text);
    return true;
  } catch (err) {
    host.queueContextualUpdate?.(text);
    if (!host.queueContextualUpdate) console.warn("contextual update dropped", err);
    return false;
  }
}

function visualToCanvasPayload(v: Visual): CanvasSpec {
  return v.kind === "chart"
    ? ({ kind: "chart", spec: v.chart } as CanvasSpec)
    : v.kind === "math"
      ? ({ kind: "math", spec: v.math } as CanvasSpec)
      : v.kind === "diagram"
        ? ({ kind: "diagram", spec: v.diagram } as CanvasSpec)
        : v.kind === "table"
          ? ({ kind: "table", spec: v.table } as CanvasSpec)
          : ({ kind: "callout", spec: v.callout } as CanvasSpec);
}

/**
 * Record this generation's validator rejections as session lessons, tagged
 * with the kind that produced them so they land in the right per-kind skill
 * file when the session ends.
 */
function harvestLessons(kind: StrictKind, warnings: string[] | undefined) {
  if (!warnings?.length) return;
  const { addLesson } = useScholarStore.getState();
  for (const w of warnings) addLesson(kind, w);
}

/** Session lessons for one kind, replayed into that kind's system prompt. */
function skillRulesForKind(kind: StrictKind): string[] {
  return useScholarStore
    .getState()
    .lessons.filter((l) => l.kind === kind)
    .map((l) => l.text);
}

function collectRecentVisuals(excludeId: string) {
  return useScholarStore
    .getState()
    .canvasItems.filter((c) => c.id !== excludeId && c.status === "ready" && !!c.payload)
    .slice(0, 6)
    .map((c) => ({ title: c.title, kind: c.payload!.kind }));
}

/** The single most likely first slide for any paper: an architecture/pipeline overview. */
export function guessSpeculativeVisualTopic(pdfName: string): { topic: string; hint: string } {
  const titleGuess =
    pdfName
      .replace(/\.pdf$/i, "")
      .replace(/[_-]+/g, " ")
      .trim() || "this paper";
  return {
    topic: `${titleGuess} — architecture overview`,
    hint: "diagram: overall pipeline or system architecture",
  };
}

/**
 * Warm the on-device path as soon as a PDF loads: check availability and
 * pre-create the diagram session so its ~1,600-token system prompt is already
 * processed by the time the agent asks for the first slide. Nothing is written
 * to the canvas — the user hasn't asked for a slide yet, so this stays
 * invisible until a real `visualize` call benefits from the warm session.
 */
export function dispatchSpeculativeVisual(pdfName: string) {
  void (async () => {
    try {
      const availability = await onDeviceAvailability();
      if (availability !== "available") {
        console.warn(`on-device model not ready (${availability}); slides will fail until it is`);
        return;
      }
      // Cheap throwaway generation purely to force session creation + prompt
      // processing. Result is discarded; failures are irrelevant here.
      const { topic, hint } = guessSpeculativeVisualTopic(pdfName);
      await generateVisualOnDevice("diagram", { topic, hint }, { skillRules: [] });
    } catch {
      // Warming is best-effort; a failure just means the first real slide pays
      // the session-creation cost itself.
    }
  })();
}

/**
 * Distill this session's not-yet-distilled failure lessons into the
 * persistent R2 skill file (via Workers AI on the server). Called when a
 * voice session ends. Fire-and-forget and idempotent: the distilled count
 * guard means calling it from both stop() and onDisconnect is safe, and a
 * missing R2 bucket just no-ops server-side.
 */
export async function distillSessionLessons(fetchImpl: typeof fetch = fetch) {
  const store = useScholarStore.getState;
  const { lessons, distilledLessonCount } = store();
  if (lessons.length <= distilledLessonCount) return;

  const lessonsByKind: Partial<Record<CanvasItemKind, string[]>> = {};
  for (const l of lessons) (lessonsByKind[l.kind] ??= []).push(l.text);

  try {
    await postJsonWithRetry("/api/skills", { lessonsByKind }, "Skills service", fetchImpl, {
      attempts: 1,
    });
    store().markLessonsDistilled(lessons.length);
  } catch (err) {
    // Non-fatal: lessons stay in the session store and the next session end
    // (or reload within the tab session) retries the distill.
    console.warn("skill distillation failed", err instanceof Error ? err.message : err);
  }
}

// One client-initiated regeneration per slide. The regeneration itself gets
// the server-side retry loop too, so a single render failure buys up to
// (1 + maxAttempts) model calls total — enough to fix a syntax slip without
// risking an infinite render-fail loop.
const MAX_RENDER_RETRIES = 1;

/**
 * Called when mermaid.render() throws in the browser for a slide that passed
 * all server-side validation. Feeds the renderer's exact error message and
 * the failing source back into a fresh generation (closing the loop the
 * server-side validators can't see), and records the failure as a session
 * lesson so later slides avoid the same construct.
 */
export function regenerateAfterRenderFailure(itemId: string, renderError: string) {
  const store = useScholarStore.getState;
  const item = store().canvasItems.find((c) => c.id === itemId);
  if (!item || item.status !== "ready" || item.payload?.kind !== "diagram") return;

  const failedSource = item.payload.spec.mermaid;
  const retries = item.renderRetries ?? 0;
  store().addLesson(
    "diagram",
    `mermaid that passed validation still failed to render: ${renderError}`,
  );

  if (retries >= MAX_RENDER_RETRIES) {
    store().patchCanvas(itemId, {
      status: "error",
      error: `Diagram failed to render${retries > 0 ? " after a retry" : ""}: ${renderError}`,
    });
    return;
  }

  store().patchCanvas(itemId, { status: "pending", renderRetries: retries + 1 });

  void (async () => {
    try {
      const { visual, warnings } = await generateVisualWithRetries(
        "diagram",
        {
          topic: item.request?.topic ?? item.title,
          hint: item.request?.hint,
          facts: item.request?.facts,
          recentVisuals: collectRecentVisuals(itemId),
          // Seed attempt 1 with the renderer's own error — the browser sees
          // failures our structural validator provably cannot.
          correction: `mermaid.render() rejected this source with "${renderError}". Failing source:\n${failedSource.slice(0, 600)}`,
        },
        { skillRules: skillRulesForKind("diagram") },
      );
      harvestLessons("diagram", warnings);
      store().patchCanvas(itemId, {
        status: "ready",
        title: visual.title || item.title,
        narration: visual.narration || item.narration,
        payload: visualToCanvasPayload(visual),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "regeneration failed";
      store().patchCanvas(itemId, {
        status: "error",
        error: `Diagram failed to render and regeneration failed: ${msg}`,
      });
    }
  })();
}

export function buildClientTools(host: ToolHost) {
  const store = useScholarStore.getState;

  return {
    visualize: (params: IllustrateParams) => {
      const kind = resolveKind(params);
      const id = uid("vis");
      const item: CanvasItem = {
        id,
        title: params.topic,
        narration: params.hint ?? "",
        createdAt: Date.now(),
        status: "pending",
        request: { topic: params.topic, kind, hint: params.hint, facts: params.facts },
      };
      store().upsertCanvas(item);
      dispatchVisualTeaser(id, params);

      // Fire-and-forget — DO NOT await; tool returns immediately.
      void (async () => {
        try {
          if (!(await isOnDeviceReady())) {
            const availability = await onDeviceAvailability();
            throw new Error(
              availability === "downloadable" || availability === "downloading"
                ? "Chrome's on-device model is still downloading — slides will work once it finishes."
                : "Chrome's on-device model is unavailable in this browser.",
            );
          }

          const { visual, warnings } = await generateVisualWithRetries(
            kind,
            {
              topic: params.topic,
              hint: params.hint,
              facts: params.facts,
              recentVisuals: collectRecentVisuals(id),
            },
            { skillRules: skillRulesForKind(kind) },
          );
          harvestLessons(kind, warnings);

          store().patchCanvas(id, {
            status: "ready",
            title: visual.title || params.topic,
            narration: visual.narration || params.hint || "",
            payload: visualToCanvasPayload(visual),
          });
          deliverContextualUpdate(
            host,
            `[VISUAL READY on canvas: "${visual.title}" — ${visual.narration}]`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : "failed";
          store().patchCanvas(id, { status: "error", error: msg });
          deliverContextualUpdate(host, `[VISUAL FAILED for "${params.topic}": ${msg}]`);
        }
      })();

      return `Visualization "${params.topic}" queued. Keep talking; it will appear on the canvas shortly.`;
    },

    research: (params: ResearchParams) => {
      const activeResearch = store().researchItems.find((item) => item.status === "pending");
      if (activeResearch) {
        return `Research already in progress. Continue speaking; do not dispatch another research query for this turn.`;
      }

      const id = uid("res");
      store().upsertResearch({
        id,
        query: params.query,
        status: "pending",
        createdAt: Date.now(),
      });

      void (async () => {
        try {
          const ctx = getPdfContext();
          const citationCandidates = collectCitationCandidates(
            params.query,
            params.scope,
            ctx.text,
          );
          const json = await fetchResearchBriefing(
            {
              query: params.query,
              pdfExcerpt: ctx.text.slice(0, 12_000),
              scope: params.scope,
              citationCandidates: citationCandidates.length > 0 ? citationCandidates : undefined,
            },
            fetch,
            { attempts: 1 },
          );
          store().patchResearch(id, {
            status: "ready",
            summary: json.summary,
          });
          // Stream the FULL briefing back as grounding for the voice agent.
          // No URLs/citations — those would only get spoken aloud awkwardly.
          const bullets =
            json.keyPoints && json.keyPoints.length > 0
              ? `\nKey facts:\n- ${json.keyPoints.join("\n- ")}`
              : "";
          deliverContextualUpdate(
            host,
            `[BACKGROUND RESEARCH on "${params.query}" — use this as factual grounding, do not read it verbatim]\n${json.summary ?? ""}${bullets}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : "failed";
          store().patchResearch(id, { status: "error", error: msg });
          deliverContextualUpdate(host, `[RESEARCH FAILED for "${params.query}": ${msg}]`);
        }
      })();

      return `Research query "${params.query}" dispatched. Continue speaking; findings will arrive shortly.`;
    },
  };
}
