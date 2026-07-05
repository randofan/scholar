import { afterEach, describe, expect, it, vi } from "vitest";
import {
  containsHedgeLanguage,
  detectRequestedKind,
  generateVisual,
  isPromptLikeVisualText,
  validateAxisLabel,
  validateMermaid,
  validateVisual,
  type Visual,
} from "./illustrate.server";

/** Build a Groq fetch mock returning the given strict-schema payloads in order (last repeats). */
function groqFetchMock(payloads: Array<Record<string, unknown>>) {
  const captured: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    captured.push({ url, body });
    const payload = payloads[Math.min(captured.length - 1, payloads.length - 1)];
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  return { fetchImpl, captured };
}

const userPromptOf = (req: { body: Record<string, unknown> }) => {
  const messages = req.body.messages as Array<{ role: string; content: string }>;
  return messages.find((m) => m.role === "user")?.content ?? "";
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("validateMermaid", () => {
  it("accepts a well-formed flowchart", () => {
    const src = `flowchart TD\n  A[Start] --> B[End]`;
    expect(validateMermaid(src)).toEqual({ ok: true });
  });
  it("accepts sequenceDiagram", () => {
    const src = `sequenceDiagram\n  Alice->>Bob: hello`;
    expect(validateMermaid(src)).toEqual({ ok: true });
  });
  it("rejects missing header", () => {
    const res = validateMermaid(`A --> B\nB --> C`);
    expect(res.ok).toBe(false);
  });
  it("rejects unbalanced brackets", () => {
    const res = validateMermaid(`graph TD\n  A[Start --> B[End]`);
    expect(res.ok).toBe(false);
  });
  it("rejects too few lines", () => {
    const res = validateMermaid(`graph TD`);
    expect(res.ok).toBe(false);
  });

  it("rejects a colon inside a bracketed label", () => {
    const res = validateMermaid(`flowchart LR\n  A[Step: detail] --> B[End]`);
    expect(res.ok).toBe(false);
  });

  it("rejects two chained edges on one flowchart line", () => {
    const res = validateMermaid(`flowchart LR\n  A --> B  B --> C`);
    expect(res.ok).toBe(false);
  });

  it("rejects a bare bracketed node with no ID on a flowchart edge", () => {
    const res = validateMermaid(`flowchart LR\n  [WP0] --> [WP1]`);
    expect(res.ok).toBe(false);
  });

  it("rejects flowchart arrows inside a mindmap", () => {
    const res = validateMermaid(`mindmap\n  root((R))\n  A --> B`);
    expect(res.ok).toBe(false);
  });

  it("rejects chained siblings with edge syntax inside a mindmap", () => {
    const res = validateMermaid(`mindmap\n  root((R5))\n  A -- B\n  A -- C`);
    expect(res.ok).toBe(false);
  });

  it("accepts a well-formed mindmap with indentation-only hierarchy", () => {
    const src = `mindmap\n  root((Paper title))\n    Contribution 1\n      Detail A\n    Contribution 2`;
    expect(validateMermaid(src)).toEqual({ ok: true });
  });

  it("accepts a labeled flowchart edge without flagging it as chained", () => {
    const src = `flowchart LR\n  Q[User query] --> R{Cache hit?}\n  R -- yes --> C[Return cached]`;
    expect(validateMermaid(src)).toEqual({ ok: true });
  });
});

describe("validateAxisLabel", () => {
  it("rejects an empty label", () => {
    expect(validateAxisLabel("", "x").ok).toBe(false);
    expect(validateAxisLabel(undefined, "y").ok).toBe(false);
  });

  it("rejects generic single-word placeholders", () => {
    for (const bad of ["X", "Y", "Value", "Axis", "Metric", "Data", "tbd", "n/a"]) {
      expect(validateAxisLabel(bad, "x").ok).toBe(false);
    }
  });

  it("rejects a single generic word with no unit hint", () => {
    expect(validateAxisLabel("Latency", "y").ok).toBe(false);
  });

  it("accepts a descriptive label with units", () => {
    expect(validateAxisLabel("Latency (ms)", "y")).toEqual({ ok: true });
    expect(validateAxisLabel("Sequence length (tokens)", "x")).toEqual({ ok: true });
  });

  it("accepts a multi-word descriptive label without explicit units", () => {
    expect(validateAxisLabel("Model size", "x")).toEqual({ ok: true });
  });
});

describe("validateVisual", () => {
  it("rejects when kind/spec mismatch", () => {
    const v = { title: "x", narration: "y", kind: "diagram" } as Visual;
    const res = validateVisual(v);
    expect(res.ok).toBe(false);
  });
  it("accepts a complete diagram visual", () => {
    const v: Visual = {
      title: "x",
      narration: "y",
      kind: "diagram",
      diagram: { mermaid: "flowchart LR\n  A --> B" },
    };
    expect(validateVisual(v)).toEqual({ ok: true });
  });

});


describe("generateVisual — provider errors", () => {
  it("throws a visible Payment Required error instead of fabricating a stub", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("Payment Required", { status: 402, statusText: "Payment Required" }),
    );

    await expect(
      generateVisual(
        { topic: "Attention sparsity tradeoff", hint: "diagram" },
        { env: { groqApiKey: "groq-token" }, maxAttempts: 2, fetchImpl },
      ),
    ).rejects.toThrow(/credits exhausted|unpaid/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws when no GROQ_API_KEY is configured", async () => {
    await expect(
      generateVisual(
        { topic: "Mathematical formalism of expander graphs", hint: "math equations" },
        { env: {}, maxAttempts: 1 },
      ),
    ).rejects.toThrow(/No AI provider configured.*GROQ_API_KEY/);
  });
});

describe("detectRequestedKind", () => {
  it.each([
    ["Mathematical Formalism of Expander Graphs", undefined, "math"],
    ["Edge expansion theorem", undefined, "math"],
    ["Spraypoint routing pipeline", "diagram", "diagram"],
    ["Expander graph vs fat tree topology", undefined, "diagram"],
    ["Throughput trend across scales", "chart", "chart"],
    ["Baseline comparison matrix", undefined, "table"],
    ["Key takeaway", "callout", null],
    ["Generic topic with no signal", undefined, null],
  ])("detects kind for topic=%j hint=%j", (topic, hint, expected) => {
    expect(detectRequestedKind({ topic, hint })).toBe(expected);
  });
});

describe("containsHedgeLanguage", () => {
  it.each([
    "The paper does not provide explicit equations.",
    "Not enough information in the excerpt.",
    "No explicit formulas appear in the text.",
    "The text does not contain a diagram.",
    "Insufficient detail to derive the result.",
    "Diagram: Illustrate the concept of edge expansion.",
    "Chart: trend over time",
  ])("flags hedge text: %s", (s) => {
    expect(containsHedgeLanguage(s)).toBe(true);
  });

  it.each([
    "Three contributions: A, B, C with respective ablations.",
    "Edge expansion bounds the second eigenvalue of the adjacency matrix.",
    "BF16 splits into 1 sign, 8 exponent, 7 mantissa bits.",
  ])("does not flag concrete text: %s", (s) => {
    expect(containsHedgeLanguage(s)).toBe(false);
  });
});

describe("prompt-like visual text guardrails", () => {
  it.each([
    "A table comparing RNG and Fat Tree topologies based on cost, performance, and throughput.",
    "summarizing the core problem and solution presented in the paper.",
    "Callout summarizing the contribution list.",
  ])("flags prompt text rendered as a visual: %s", (s) => {
    expect(isPromptLikeVisualText(s)).toBe(true);
  });

  it("does not treat a prompt-ish callout hint as an explicit callout request", () => {
    expect(
      detectRequestedKind({
        topic: "RNG: Flat Datacenter Networks at Scale",
        hint: "Callout summarizing the core problem and solution presented in the paper.",
      }),
    ).toBeNull();
  });

  // Removed: deterministic fallback visuals were eliminated; generation now
  // throws on failure rather than serving hard-coded RNG/Fat-tree content.
});

describe("generateVisual — kind enforcement, recentVisuals, research-triggering hints", () => {
  it("uses Groq's strict structured-output endpoint with openai/gpt-oss-20b in a single call", async () => {
    const capturedRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      capturedRequests.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      const payload = {
        title: "RNG topology",
        narration: "The graph contrasts hierarchical fat-tree links with flat expander connectivity.",
        mermaid: "flowchart LR\n  A[Fat tree] --> B[Core]\n  C[Expander] --> D[Many cuts]",
      };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await generateVisual(
      { topic: "RNG expander graph topology", hint: "diagram" },
      {
        env: { groqApiKey: "groq-token" },
        maxAttempts: 2,
        fetchImpl,
      },
    );

    expect(result.visual.kind).toBe("diagram");
    expect(result.attempts).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(capturedRequests[0].url).toBe("https://api.groq.com/openai/v1/chat/completions");
    const body = capturedRequests[0].body as {
      model: string;
      response_format: { type: string; json_schema: { strict: boolean; schema: { additionalProperties: boolean } } };
    };
    expect(body.model).toBe("openai/gpt-oss-20b");
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema.additionalProperties).toBe(false);
  });

  it("throws (no deterministic fallback) when strict Mermaid is persistently invalid, retrying up to maxAttempts", async () => {
    const fetchImpl = vi.fn(async () => {
      const payload = {
        title: "RNG topology",
        narration: "The diagram maps RNG topology components.",
        mermaid: "flowchart LR",
      };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await expect(
      generateVisual(
        { topic: "RNG expander graph topology", hint: "diagram" },
        { env: { groqApiKey: "groq-token" }, maxAttempts: 2, fetchImpl },
      ),
    ).rejects.toThrow(/Failed to generate a valid visual after 2 attempts via Groq strict mode/i);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("defaults to 2 attempts on the Groq strict path when maxAttempts is not specified", async () => {
    const fetchImpl = vi.fn(async () => {
      const payload = {
        title: "RNG topology",
        narration: "The diagram maps RNG topology components.",
        mermaid: "flowchart LR",
      };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await expect(
      generateVisual(
        { topic: "RNG expander graph topology", hint: "diagram" },
        { env: { groqApiKey: "groq-token" }, fetchImpl },
      ),
    ).rejects.toThrow(/Failed to generate a valid visual after 2 attempts/i);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("recovers on retry when the first strict-mode attempt returns invalid mermaid", async () => {
    const capturedBodies: Array<Record<string, unknown>> = [];
    const badPayload = {
      title: "RNG topology",
      narration: "The diagram maps RNG topology components.",
      mermaid: "flowchart LR",
    };
    const goodPayload = {
      title: "RNG topology",
      narration: "The graph contrasts hierarchical fat-tree links with flat expander connectivity.",
      mermaid: "flowchart LR\n  A[Fat tree] --> B[Core]\n  C[Expander] --> D[Many cuts]",
    };
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      capturedBodies.push(body);
      const payload = capturedBodies.length === 1 ? badPayload : goodPayload;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await generateVisual(
      { topic: "RNG expander graph topology", hint: "diagram" },
      { env: { groqApiKey: "groq-token" }, maxAttempts: 2, fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.attempts).toBe(2);
    expect(result.visual.kind).toBe("diagram");
    // Second attempt's user message must carry the specific failure reason
    // from the first attempt, and temperature must escalate downward.
    const secondBody = capturedBodies[1] as { temperature: number; messages: Array<{ content: string }> };
    expect(secondBody.temperature).toBeLessThan(0.5);
    const userMessage = secondBody.messages.find((m) => m.content.includes("Topic:"))?.content ?? "";
    expect(userMessage).toMatch(/PREVIOUS ATTEMPT FAILED/);
  });



  it("retries when the model returns hedge language in the narration", async () => {
    const hedged = {
      title: "Mathematical Formalism",
      narration: "The paper does not provide explicit mathematical equations within the provided text.",
      inline: "",
      steps: ["h(G) = \\min \\frac{|E(S, \\bar S)|}{|S|}"],
    };
    const real = {
      title: "Edge Expansion (Math)",
      narration: "Edge expansion h(G) is the minimum boundary-to-volume ratio over small cuts.",
      inline: "",
      steps: ["h(G) = \\min_{|S| \\le |V|/2} \\frac{|E(S, \\bar S)|}{|S|}", "\\lambda_2(G) \\le 2 h(G)"],
    };
    const { fetchImpl, captured } = groqFetchMock([hedged, real]);

    const result = await generateVisual(
      {
        topic: "Mathematical Formalism of Expander Graphs",
        hint: "math equations",
        pdfExcerpt: "Edge expansion is the core property...",
      },
      { env: { groqApiKey: "groq-token" }, maxAttempts: 2, fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.visual.kind).toBe("math");
    expect(containsHedgeLanguage(result.visual.narration)).toBe(false);
    expect(userPromptOf(captured[1])).toMatch(/PREVIOUS ATTEMPT FAILED.*hedge/is);
  });

  it("includes recentVisuals in the prompt so the model can avoid repeats", async () => {
    const { fetchImpl, captured } = groqFetchMock([
      {
        title: "Spraypoint routing",
        narration: "Spraypoint distributes packets across many near-edge-disjoint paths.",
        mermaid: "flowchart LR\n  A[Packet] --> B[Spray paths]",
      },
    ]);

    await generateVisual(
      {
        topic: "Spraypoint routing",
        hint: "diagram",
        recentVisuals: [
          { title: "RNG vs Fat Tree", kind: "table" },
          { title: "Edge expansion math", kind: "math" },
        ],
      },
      { env: { groqApiKey: "groq-token" }, maxAttempts: 1, fetchImpl },
    );

    expect(userPromptOf(captured[0])).toMatch(/DO NOT repeat/);
    expect(userPromptOf(captured[0])).toMatch(/RNG vs Fat Tree/);
    expect(userPromptOf(captured[0])).toMatch(/Edge expansion math/);
  });

  it("seeds the FIRST attempt's correction with a browser render failure", async () => {
    const { fetchImpl, captured } = groqFetchMock([
      {
        title: "Fixed diagram",
        narration: "The pipeline connects tokenizer, model, and decoder stages.",
        mermaid: "flowchart LR\n  A[Tokenizer] --> B[Model]\n  B --> C[Decoder]",
      },
    ]);

    const result = await generateVisual(
      {
        topic: "Inference pipeline",
        hint: "diagram",
        renderFailure: {
          source: "flowchart LR\n  A[Tokenizer] --> B[Model",
          error: "Parse error on line 2: expecting SQE",
        },
      },
      { env: { groqApiKey: "groq-token" }, maxAttempts: 2, fetchImpl },
    );

    expect(result.visual.kind).toBe("diagram");
    const prompt = userPromptOf(captured[0]);
    expect(prompt).toMatch(/PREVIOUS ATTEMPT FAILED/);
    expect(prompt).toMatch(/failed in the browser renderer/);
    expect(prompt).toMatch(/Parse error on line 2/);
  });

  it("injects session lessons into the prompt as known failure modes", async () => {
    const { fetchImpl, captured } = groqFetchMock([
      {
        title: "Routing map",
        narration: "The mindmap groups routing strategies by locality and cost.",
        mermaid: "mindmap\n  root((Routing))\n    Local\n      ECMP\n    Global\n      Spray",
      },
    ]);

    await generateVisual(
      {
        topic: "Routing strategies",
        hint: "diagram",
        lessons: ["mindmap bodies must never contain --> arrows"],
      },
      { env: { groqApiKey: "groq-token" }, maxAttempts: 1, fetchImpl },
    );

    const prompt = userPromptOf(captured[0]);
    expect(prompt).toMatch(/KNOWN FAILURE MODES/);
    expect(prompt).toMatch(/mindmap bodies must never contain/);
  });
});
