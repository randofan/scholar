import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildClientTools,
  deliverContextualUpdate,
  fetchIllustration,
  fetchResearchBriefing,
  parseResearchResponse,
  regenerateAfterRenderFailure,
} from "./agent-tools";
import { useScholarStore } from "./store";
beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  useScholarStore.setState({
    pdf: { name: "paper.pdf", text: "Paper excerpt about sparse attention and retrieval.", pages: 3, charCount: 64 },
    canvasItems: [],
    researchItems: [],
    transcript: [],
    lessons: [],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const waitForMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("research client response handling", () => {
  it("turns the exact upstream non-JSON body into a controlled error", async () => {
    await expect(
      parseResearchResponse(
        new Response("upstream request timeout", {
          status: 502,
          statusText: "Bad Gateway",
        }),
      ),
    ).rejects.toThrow(/non-JSON response \(502 Bad Gateway\): upstream request timeout/);
  });

  it("retries transient non-JSON failures instead of crashing on Response.json", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("upstream request timeout", { status: 502 }))
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          summary: "Recovered research briefing.",
          keyPoints: ["Retry succeeded"],
        }),
      );

    const result = await fetchResearchBriefing(
      { query: "unweight 2026", pdfExcerpt: "Unweight paper excerpt" },
      fetchImpl,
      { attempts: 2, retryDelayMs: 0 },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.summary).toBe("Recovered research briefing.");
  });

  it("returns a useful final error if every retry gets non-JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response("upstream request timeout", {
        status: 503,
        statusText: "Service Unavailable",
      }),
    );

    await expect(
      fetchResearchBriefing({ query: "unweight 2026" }, fetchImpl, {
        attempts: 2,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow(/Research service returned a non-JSON response \(503 Service Unavailable\): upstream request timeout/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("illustrate client response handling (callout regression)", () => {
  it("does not crash on the exact 'upstream request timeout' body that triggered the callout bug", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("upstream request timeout", {
        status: 502,
        statusText: "Bad Gateway",
      }),
    );

    await expect(
      fetchIllustration(
        { topic: "ZipServ's Key Innovations", hint: "callout" },
        fetchImpl,
        { attempts: 1, retryDelayMs: 0 },
      ),
    ).rejects.toThrow(
      /Illustrate service returned a non-JSON response \(502 Bad Gateway\): upstream request timeout/,
    );
  });

  it("retries transient non-JSON failures and returns the recovered visual", async () => {
    const visual = {
      title: "ZipServ's Key Innovations",
      narration: "Three pillars of the system.",
      kind: "callout" as const,
      callout: { body: "Lossless. Composable. GPU-native." },
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("upstream request timeout", { status: 502 }))
      .mockResolvedValueOnce(Response.json({ ok: true, visual }));

    const result = await fetchIllustration(
      { topic: "ZipServ's Key Innovations" },
      fetchImpl,
      { attempts: 2, retryDelayMs: 0 },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.visual?.kind).toBe("callout");
    expect(result.visual?.title).toBe("ZipServ's Key Innovations");
  });
});

describe("regenerateAfterRenderFailure", () => {
  const failingMermaid = "flowchart LR\n  A[Tokenizer] --> B[Model";

  function seedRenderedDiagram(renderRetries?: number) {
    useScholarStore.setState({
      canvasItems: [
        {
          id: "vis-1",
          title: "Inference pipeline",
          narration: "Pipeline stages",
          createdAt: Date.now(),
          status: "ready" as const,
          payload: { kind: "diagram" as const, spec: { mermaid: failingMermaid } },
          request: { topic: "Inference pipeline", hint: "diagram" },
          renderRetries,
        },
      ],
    });
  }

  it("re-requests the slide with the renderer error and failing source attached", async () => {
    seedRenderedDiagram();
    const fixed = {
      title: "Inference pipeline",
      narration: "Pipeline stages",
      kind: "diagram" as const,
      diagram: { mermaid: "flowchart LR\n  A[Tokenizer] --> B[Model]" },
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true, visual: fixed }));
    vi.stubGlobal("fetch", fetchImpl);

    regenerateAfterRenderFailure("vis-1", "Parse error on line 2");
    expect(useScholarStore.getState().canvasItems[0].status).toBe("pending");

    await waitForMicrotasks();

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body.renderFailure).toEqual({ source: failingMermaid, error: "Parse error on line 2" });
    expect(body.topic).toBe("Inference pipeline");
    const item = useScholarStore.getState().canvasItems[0];
    expect(item.status).toBe("ready");
    expect(item.renderRetries).toBe(1);
    // The failure is also recorded as a session lesson for future slides.
    expect(useScholarStore.getState().lessons.join(" ")).toContain("Parse error on line 2");
  });

  it("gives up with a visible error once the retry budget is exhausted", async () => {
    seedRenderedDiagram(1);
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchImpl);

    regenerateAfterRenderFailure("vis-1", "Parse error on line 2");
    await waitForMicrotasks();

    expect(fetchImpl).not.toHaveBeenCalled();
    const item = useScholarStore.getState().canvasItems[0];
    expect(item.status).toBe("error");
    expect(item.error).toMatch(/failed to render/i);
  });
});

describe("contextual update dispatch ordering", () => {
  it("queues contextual updates instead of throwing before the voice session is connected", () => {
    const sent = vi.fn();
    const queued: string[] = [];

    const delivered = deliverContextualUpdate(
      {
        sendContextualUpdate: sent,
        canSendContextualUpdate: () => false,
        queueContextualUpdate: (text) => queued.push(text),
      },
      "[BACKGROUND RESEARCH] ready",
    );

    expect(delivered).toBe(false);
    expect(sent).not.toHaveBeenCalled();
    expect(queued).toEqual(["[BACKGROUND RESEARCH] ready"]);
  });

  it("research tasks still run and queue their result when contextual updates are not ready", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ok: true,
        summary: "Recovered background research.",
        keyPoints: ["Fetched after connection-safe dispatch"],
      }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const queued: string[] = [];
    const sent = vi.fn(() => {
      throw new Error("session not ready");
    });

    const tools = buildClientTools({
      sendContextualUpdate: sent,
      canSendContextualUpdate: () => false,
      queueContextualUpdate: (text) => queued.push(text),
    });

    const response = tools.research({ query: "related work for sparse attention", scope: "both" });
    expect(response).toMatch(/dispatched/);
    expect(useScholarStore.getState().researchItems[0]?.status).toBe("pending");

    await waitForMicrotasks();

    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/research",
      expect.objectContaining({ method: "POST" }),
    );
    expect(useScholarStore.getState().researchItems[0]?.status).toBe("ready");
    expect(sent).not.toHaveBeenCalled();
    expect(queued.join("\n")).toContain("Recovered background research.");
  });
});