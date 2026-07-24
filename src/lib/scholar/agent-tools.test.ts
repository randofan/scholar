import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildClientTools,
  deliverContextualUpdate,
  dispatchSpeculativeVisual,
  distillSessionLessons,
  fetchIllustration,
  fetchResearchBriefing,
  guessSpeculativeVisualTopic,
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
    pdf: {
      name: "paper.pdf",
      text: "Paper excerpt about sparse attention and retrieval.",
      pages: 3,
      charCount: 64,
    },
    canvasItems: [],
    researchItems: [],
    transcript: [],
    lessons: [],
    distilledLessonCount: 0,
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
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async () =>
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
    ).rejects.toThrow(
      /Research service returned a non-JSON response \(503 Service Unavailable\): upstream request timeout/,
    );
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
      fetchIllustration({ topic: "ZipServ's Key Innovations", hint: "callout" }, fetchImpl, {
        attempts: 1,
        retryDelayMs: 0,
      }),
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

    const result = await fetchIllustration({ topic: "ZipServ's Key Innovations" }, fetchImpl, {
      attempts: 2,
      retryDelayMs: 0,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.visual?.kind).toBe("callout");
    expect(result.visual?.title).toBe("ZipServ's Key Innovations");
  });
});

describe("guessSpeculativeVisualTopic", () => {
  it("derives a human-readable title from the filename", () => {
    expect(guessSpeculativeVisualTopic("attention_is_all-you_need.pdf")).toEqual({
      topic: "attention is all you need — architecture overview",
      hint: "diagram: overall pipeline or system architecture",
    });
  });

  it("falls back to a generic title for an unhelpful filename", () => {
    expect(guessSpeculativeVisualTopic(".pdf").topic).toBe("this paper — architecture overview");
  });
});

describe("dispatchSpeculativeVisual", () => {
  it("fires an illustrate request for the guessed overview topic without touching the canvas", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ok: true,
        visual: {
          title: "Overview",
          narration: "n",
          kind: "diagram",
          diagram: { mermaid: "flowchart LR\n  A --> B" },
        },
      }),
    );

    dispatchSpeculativeVisual(
      "sparse-retrieval.pdf",
      "Paper body text about sparse retrieval.",
      fetchImpl,
    );
    await waitForMicrotasks();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/illustrate");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.topic).toBe("sparse retrieval — architecture overview");
    expect(body.pdfExcerpt).toContain("sparse retrieval");
    // Speculative pre-generation must stay invisible: no canvas item until a
    // real visualize call happens.
    expect(useScholarStore.getState().canvasItems).toHaveLength(0);
  });

  it("does not throw when the illustrate request fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("network down"));
    expect(() => dispatchSpeculativeVisual("paper.pdf", "text", fetchImpl)).not.toThrow();
    await waitForMicrotasks();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("visualize — two-phase teaser reveal", () => {
  it("patches the pending canvas item's narration with a fast teaser before the full visual arrives", async () => {
    let resolveIllustrate: (value: Response) => void = () => {};
    const illustratePromise = new Promise<Response>((resolve) => {
      resolveIllustrate = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>((url) => {
      if (String(url) === "/api/illustrate-teaser") {
        return Promise.resolve(Response.json({ ok: true, teaser: "A diagram of the pipeline." }));
      }
      return illustratePromise;
    });
    vi.stubGlobal("fetch", fetchImpl);

    const tools = buildClientTools({ sendContextualUpdate: vi.fn() });
    tools.visualize({ topic: "Retrieval pipeline", hint: "diagram" });
    await waitForMicrotasks();

    const pending = useScholarStore.getState().canvasItems[0];
    expect(pending.status).toBe("pending");
    expect(pending.narration).toBe("A diagram of the pipeline.");

    resolveIllustrate(
      Response.json({
        ok: true,
        visual: {
          title: "Retrieval pipeline",
          narration: "Full narration",
          kind: "diagram",
          diagram: { mermaid: "flowchart LR\n  A --> B" },
        },
      }),
    );
    await waitForMicrotasks();

    const ready = useScholarStore.getState().canvasItems[0];
    expect(ready.status).toBe("ready");
    expect(ready.narration).toBe("Full narration");
  });

  it("never overwrites an already-resolved slide if the teaser resolves late", async () => {
    let resolveTeaser: (value: Response) => void = () => {};
    const teaserPromise = new Promise<Response>((resolve) => {
      resolveTeaser = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>((url) => {
      if (String(url) === "/api/illustrate-teaser") return teaserPromise;
      return Promise.resolve(
        Response.json({
          ok: true,
          visual: {
            title: "T",
            narration: "Full narration",
            kind: "diagram",
            diagram: { mermaid: "flowchart LR\n  A --> B" },
          },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchImpl);

    const tools = buildClientTools({ sendContextualUpdate: vi.fn() });
    tools.visualize({ topic: "T" });
    await waitForMicrotasks();
    expect(useScholarStore.getState().canvasItems[0].status).toBe("ready");

    resolveTeaser(Response.json({ ok: true, teaser: "Stale teaser" }));
    await waitForMicrotasks();

    expect(useScholarStore.getState().canvasItems[0].narration).toBe("Full narration");
  });

  it("leaves the caller-supplied hint as the narration when the teaser request fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>((url) => {
      if (String(url) === "/api/illustrate-teaser") return Promise.reject(new Error("teaser down"));
      return new Promise(() => {}); // main generation never resolves in this test
    });
    vi.stubGlobal("fetch", fetchImpl);

    const tools = buildClientTools({ sendContextualUpdate: vi.fn() });
    tools.visualize({ topic: "T", hint: "diagram: pipeline" });
    await waitForMicrotasks();

    const item = useScholarStore.getState().canvasItems[0];
    expect(item.status).toBe("pending");
    expect(item.narration).toBe("diagram: pipeline");
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
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true, visual: fixed }));
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

describe("distillSessionLessons", () => {
  it("POSTs undistilled lessons to /api/skills and marks them distilled", async () => {
    useScholarStore.setState({
      lessons: ["mindmap bodies must never contain arrows", "label chart axes with units"],
      distilledLessonCount: 0,
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true, rules: ["merged rule"] }));

    await distillSessionLessons(fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/skills");
    expect(JSON.parse(String(init?.body)).lessons).toHaveLength(2);
    expect(useScholarStore.getState().distilledLessonCount).toBe(2);

    // Idempotent: nothing new to distill → no second request.
    await distillSessionLessons(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps lessons undistilled when the request fails, so a later call retries", async () => {
    useScholarStore.setState({ lessons: ["a lesson"], distilledLessonCount: 0 });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ ok: false, error: "R2 skills bucket not configured" }, { status: 503 }),
      );

    await distillSessionLessons(fetchImpl);

    expect(useScholarStore.getState().distilledLessonCount).toBe(0);
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

  it("includes ranked citation candidates from the paper's own bibliography for scope 'both' (the default)", async () => {
    useScholarStore.setState({
      pdf: {
        name: "paper.pdf",
        text: "Paper body about expander graphs for RNG. References [1] A. Author. Random number generation using expander graphs. arXiv:1901.01234 (2019). [2] B. Author. Unrelated congestion control work (2020).",
        pages: 3,
        charCount: 64,
      },
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true, summary: "s", keyPoints: [] }));
    vi.stubGlobal("fetch", fetchImpl);

    const tools = buildClientTools({ sendContextualUpdate: vi.fn() });
    tools.research({ query: "expander graphs for random number generation" });
    await waitForMicrotasks();

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body.citationCandidates).toEqual([{ arxivId: "1901.01234" }]);
  });

  it("omits citationCandidates for scope 'web' (pure training-knowledge synthesis, no citation lookups)", async () => {
    useScholarStore.setState({
      pdf: {
        name: "paper.pdf",
        text: "Paper body about expander graphs for RNG. References [1] A. Author. Random number generation using expander graphs. arXiv:1901.01234, 2019.",
        pages: 3,
        charCount: 64,
      },
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true, summary: "s", keyPoints: [] }));
    vi.stubGlobal("fetch", fetchImpl);

    const tools = buildClientTools({ sendContextualUpdate: vi.fn() });
    tools.research({ query: "expander graphs for random number generation", scope: "web" });
    await waitForMicrotasks();

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body.citationCandidates).toBeUndefined();
  });

  it("omits citationCandidates when nothing in the bibliography matches the query", async () => {
    useScholarStore.setState({
      pdf: {
        name: "paper.pdf",
        text: "Paper body. References [1] A. Author. Something entirely unrelated to the query, 2020.",
        pages: 3,
        charCount: 64,
      },
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true, summary: "s", keyPoints: [] }));
    vi.stubGlobal("fetch", fetchImpl);

    const tools = buildClientTools({ sendContextualUpdate: vi.fn() });
    tools.research({ query: "quantum entanglement in photonic circuits", scope: "citations" });
    await waitForMicrotasks();

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body.citationCandidates).toBeUndefined();
  });
});
