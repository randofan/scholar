import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildClientTools,
  deliverContextualUpdate,
  dispatchSpeculativeVisual,
  distillSessionLessons,
  generateVisualWithRetries,
  fetchResearchBriefing,
  guessSpeculativeVisualTopic,
  parseResearchResponse,
  regenerateAfterRenderFailure,
} from "./agent-tools";
import { useScholarStore } from "./store";
import { __setLanguageModel, type LanguageModelLike } from "./on-device";

/** Fake Prompt API returning canned model output in order (last repeats). */
function fakeModel(responses: string[], onPrompt?: (p: string) => void): LanguageModelLike {
  let i = 0;
  return {
    availability: async () => "available",
    create: async () => ({
      prompt: async (input: string) => {
        onPrompt?.(input);
        const r = responses[Math.min(i, responses.length - 1)];
        i += 1;
        return r;
      },
    }),
  };
}

const DIAGRAM_JSON = JSON.stringify({
  title: "Retrieval pipeline",
  narration: "Three stages from query to ranked results.",
  mermaid: "flowchart LR\n  Q[Query] --> R[Retrieve]\n  R --> K[Rank]\n  K --> O[Output]",
});

afterEach(() => __setLanguageModel(undefined));
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

describe("generateVisualWithRetries", () => {
  it("returns the visual on the first attempt when it passes validation", async () => {
    __setLanguageModel(fakeModel([DIAGRAM_JSON]));
    const { visual, warnings } = await generateVisualWithRetries("diagram", {
      topic: "Retrieval pipeline",
    });
    expect(visual.kind).toBe("diagram");
    expect(visual.diagram?.mermaid).toContain("flowchart LR");
    expect(warnings).toEqual([]);
  });

  it("retries with the validator's exact reason and recovers", async () => {
    const prompts: string[] = [];
    const broken = JSON.stringify({
      title: "T",
      narration: "n",
      mermaid: "not a diagram header at all",
    });
    __setLanguageModel(fakeModel([broken, DIAGRAM_JSON], (p) => prompts.push(p)));

    const { visual, warnings } = await generateVisualWithRetries("diagram", { topic: "T" });

    expect(visual.diagram?.mermaid).toContain("flowchart LR");
    // The rejection reason is surfaced as a warning AND fed back as a correction.
    expect(warnings).toHaveLength(1);
    expect(prompts[1]).toContain("PREVIOUS ATTEMPT FAILED:");
    expect(prompts[1]).toContain(warnings[0]);
  });

  it("throws after exhausting attempts, naming the last failure", async () => {
    __setLanguageModel(
      fakeModel([JSON.stringify({ title: "T", narration: "n", mermaid: "junk" })]),
    );
    await expect(
      generateVisualWithRetries("diagram", { topic: "T" }, { maxAttempts: 3 }),
    ).rejects.toThrow(/failed after 3 attempts \(kind=diagram\)/);
  });

  it("sends facts (not the PDF) as the model's only grounding", async () => {
    const prompts: string[] = [];
    __setLanguageModel(fakeModel([DIAGRAM_JSON], (p) => prompts.push(p)));
    await generateVisualWithRetries("diagram", {
      topic: "Retrieval pipeline",
      hint: "query to ranked results",
      facts: "Stage 1 retrieves 1000 candidates; stage 2 reranks to 10.",
    });
    expect(prompts[0]).toContain("Stage 1 retrieves 1000 candidates");
    expect(prompts[0]).toContain("query to ranked results");
  });
});

describe("visualize tool — on-device dispatch", () => {
  it("uses the agent-supplied kind and renders the slide", async () => {
    __setLanguageModel(
      fakeModel([
        JSON.stringify({
          title: "Comparison",
          narration: "Two rows.",
          columns: ["a", "b"],
          rows: [["1", "2"]],
        }),
      ]),
    );
    const tools = buildClientTools({ sendContextualUpdate: vi.fn() });
    tools.visualize({ topic: "Comparison", kind: "table", facts: "a=1, b=2" });
    await waitForMicrotasks();

    const item = useScholarStore.getState().canvasItems[0];
    expect(item.status).toBe("ready");
    expect(item.payload?.kind).toBe("table");
    expect(item.request?.facts).toBe("a=1, b=2");
  });

  it("defaults to diagram when the agent omits kind", async () => {
    __setLanguageModel(fakeModel([DIAGRAM_JSON]));
    const tools = buildClientTools({ sendContextualUpdate: vi.fn() });
    tools.visualize({ topic: "Something" });
    await waitForMicrotasks();
    expect(useScholarStore.getState().canvasItems[0].payload?.kind).toBe("diagram");
  });

  it("surfaces a visible error when the on-device model is unavailable", async () => {
    __setLanguageModel({
      availability: async () => "unavailable",
      create: async () => {
        throw new Error("should not be called");
      },
    });
    const sent = vi.fn();
    const tools = buildClientTools({ sendContextualUpdate: sent });
    tools.visualize({ topic: "Anything", kind: "diagram" });
    await waitForMicrotasks();

    const item = useScholarStore.getState().canvasItems[0];
    expect(item.status).toBe("error");
    expect(item.error).toMatch(/unavailable/i);
    expect(sent.mock.calls.flat().join(" ")).toMatch(/VISUAL FAILED/);
  });

  it("reports a still-downloading model distinctly from an unsupported browser", async () => {
    __setLanguageModel({
      availability: async () => "downloadable",
      create: async () => {
        throw new Error("should not be called");
      },
    });
    const tools = buildClientTools({ sendContextualUpdate: vi.fn() });
    tools.visualize({ topic: "Anything", kind: "diagram" });
    await waitForMicrotasks();
    expect(useScholarStore.getState().canvasItems[0].error).toMatch(/still downloading/i);
  });

  it("records validator rejections as lessons tagged with the kind that produced them", async () => {
    const broken = JSON.stringify({ title: "T", narration: "n", mermaid: "junk" });
    __setLanguageModel(fakeModel([broken, DIAGRAM_JSON]));
    const tools = buildClientTools({ sendContextualUpdate: vi.fn() });
    tools.visualize({ topic: "T", kind: "diagram" });
    await waitForMicrotasks();

    const lessons = useScholarStore.getState().lessons;
    expect(lessons.length).toBeGreaterThan(0);
    expect(lessons.every((l) => l.kind === "diagram")).toBe(true);
  });
});

describe("dispatchSpeculativeVisual", () => {
  it("warms the on-device session without touching the canvas", async () => {
    __setLanguageModel(fakeModel([DIAGRAM_JSON]));
    dispatchSpeculativeVisual("sparse-retrieval.pdf");
    await waitForMicrotasks();
    // Warming must stay invisible — no slide until a real visualize call.
    expect(useScholarStore.getState().canvasItems).toHaveLength(0);
  });

  it("does not throw when the model is unavailable", async () => {
    __setLanguageModel({
      availability: async () => "unavailable",
      create: async () => {
        throw new Error("nope");
      },
    });
    expect(() => dispatchSpeculativeVisual("paper.pdf")).not.toThrow();
    await waitForMicrotasks();
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
          request: {
            topic: "Inference pipeline",
            kind: "diagram" as const,
            hint: "diagram",
            facts: "tokenizer feeds the model",
          },
          renderRetries,
        },
      ],
    });
  }

  it("regenerates on-device, seeding attempt 1 with the renderer error and failing source", async () => {
    seedRenderedDiagram();
    const prompts: string[] = [];
    __setLanguageModel(
      fakeModel(
        [
          JSON.stringify({
            title: "Inference pipeline",
            narration: "Pipeline stages",
            mermaid: "flowchart LR\n  A[Tokenizer] --> B[Model]",
          }),
        ],
        (pr) => prompts.push(pr),
      ),
    );

    regenerateAfterRenderFailure("vis-1", "Parse error on line 2");
    expect(useScholarStore.getState().canvasItems[0].status).toBe("pending");

    await waitForMicrotasks();

    // The browser's own render error is fed back as the correction — our
    // structural validator provably cannot see these failures.
    expect(prompts[0]).toContain("PREVIOUS ATTEMPT FAILED:");
    expect(prompts[0]).toContain("Parse error on line 2");
    expect(prompts[0]).toContain(failingMermaid);
    expect(prompts[0]).toContain("Inference pipeline");

    const item = useScholarStore.getState().canvasItems[0];
    expect(item.status).toBe("ready");
    expect(item.renderRetries).toBe(1);
    // The failure is also recorded as a diagram-scoped session lesson.
    const lessons = useScholarStore.getState().lessons;
    expect(
      lessons.some((l) => l.kind === "diagram" && l.text.includes("Parse error on line 2")),
    ).toBe(true);
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
      lessons: [
        { kind: "diagram" as const, text: "mindmap bodies must never contain arrows" },
        { kind: "chart" as const, text: "label chart axes with units" },
      ],
      distilledLessonCount: 0,
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true, rules: ["merged rule"] }));

    await distillSessionLessons(fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/skills");
    const { lessonsByKind } = JSON.parse(String(init?.body));
    expect(lessonsByKind.diagram).toEqual(["mindmap bodies must never contain arrows"]);
    expect(lessonsByKind.chart).toEqual(["label chart axes with units"]);
    expect(useScholarStore.getState().distilledLessonCount).toBe(2);

    // Idempotent: nothing new to distill → no second request.
    await distillSessionLessons(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps lessons undistilled when the request fails, so a later call retries", async () => {
    useScholarStore.setState({
      lessons: [{ kind: "diagram" as const, text: "a lesson" }],
      distilledLessonCount: 0,
    });
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
