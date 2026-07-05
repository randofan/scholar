import type { CanvasItem, CanvasSpec } from "./store";
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
  hint?: string;
}

interface ResearchParams {
  query: string;
  scope?: "web" | "citations" | "both";
}

interface ResearchRequestPayload {
  query: string;
  pdfExcerpt?: string;
  scope?: "web" | "citations" | "both";
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

interface IllustrateApiResponse {
  ok?: boolean;
  error?: string;
  visual?: {
    title: string;
    narration: string;
    kind: CanvasSpec["kind"];
    chart?: unknown;
    math?: unknown;
    diagram?: unknown;
    table?: unknown;
    callout?: unknown;
  };
  /** Validator-rejection reasons the server had to correct via retry. */
  warnings?: string[];
}

export async function fetchIllustration(
  payload: {
    topic: string;
    hint?: string;
    pdfExcerpt?: string;
    recentVisuals?: Array<{ title: string; kind: CanvasSpec["kind"] }>;
    renderFailure?: { source: string; error: string };
    lessons?: string[];
  },
  fetchImpl: typeof fetch = fetch,
  opts: { attempts?: number; retryDelayMs?: number } = {},
) {
  return postJsonWithRetry<IllustrateApiResponse>(
    "/api/illustrate",
    payload,
    "Illustrate service",
    fetchImpl,
    opts,
  );
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

function visualToCanvasPayload(v: NonNullable<IllustrateApiResponse["visual"]>): CanvasSpec {
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
 * Distill server-side validator rejections into session lessons. Each warning
 * looks like "attempt 1 (groq strict/diagram): <specific reason>" — the reason
 * is the lesson; the attempt prefix is noise.
 */
function harvestLessons(warnings: string[] | undefined) {
  if (!warnings?.length) return;
  const { addLesson } = useScholarStore.getState();
  for (const w of warnings) {
    addLesson(w.replace(/^attempt \d+ \([^)]*\):\s*/i, ""));
  }
}

function collectRecentVisuals(excludeId: string) {
  return useScholarStore
    .getState()
    .canvasItems.filter((c) => c.id !== excludeId && c.status === "ready" && !!c.payload)
    .slice(0, 6)
    .map((c) => ({ title: c.title, kind: c.payload!.kind }));
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
  store().addLesson(`mermaid that passed validation still failed to render: ${renderError}`);

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
      const ctx = getPdfContext();
      const json = await fetchIllustration({
        topic: item.request?.topic ?? item.title,
        hint: item.request?.hint,
        pdfExcerpt: ctx.text.slice(0, 30_000),
        recentVisuals: collectRecentVisuals(itemId),
        renderFailure: { source: failedSource, error: renderError },
        lessons: store().lessons,
      });
      if (!json.visual) throw new Error(json.error ?? "no visual");
      harvestLessons(json.warnings);
      store().patchCanvas(itemId, {
        status: "ready",
        title: json.visual.title || item.title,
        narration: json.visual.narration || item.narration,
        payload: visualToCanvasPayload(json.visual),
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
      const id = uid("vis");
      const item: CanvasItem = {
        id,
        title: params.topic,
        narration: params.hint ?? "",
        createdAt: Date.now(),
        status: "pending",
        request: { topic: params.topic, hint: params.hint },
      };
      store().upsertCanvas(item);

      // Fire-and-forget — DO NOT await; tool returns immediately.
      void (async () => {
        try {
          const ctx = getPdfContext();
          const json = await fetchIllustration({
            topic: params.topic,
            hint: params.hint,
            pdfExcerpt: ctx.text.slice(0, 30_000),
            recentVisuals: collectRecentVisuals(id),
            lessons: store().lessons,
          });
          if (!json.visual) throw new Error(json.error ?? "no visual");
          const v = json.visual;
          harvestLessons(json.warnings);

          store().patchCanvas(id, {
            status: "ready",
            title: v.title || params.topic,
            narration: v.narration || params.hint || "",
            payload: visualToCanvasPayload(v),
          });
          deliverContextualUpdate(
            host,
            `[VISUAL READY on canvas: "${v.title}" — ${v.narration}]`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : "failed";
          store().patchCanvas(id, { status: "error", error: msg });
          deliverContextualUpdate(host, `[VISUAL FAILED for "${params.topic}": ${msg}]`);
        }
      })();

      return `Visualization "${params.topic}" queued. Keep talking; it will appear on the canvas in a few seconds.`;
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
          const json = await fetchResearchBriefing({
            query: params.query,
            pdfExcerpt: ctx.text.slice(0, 12_000),
            scope: params.scope,
          }, fetch, { attempts: 1 });
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
