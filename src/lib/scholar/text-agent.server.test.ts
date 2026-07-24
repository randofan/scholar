import { describe, expect, it, vi } from "vitest";
import { decideAgentTurn } from "./text-agent.server";

function groqResponse(message: Record<string, unknown>) {
  return new Response(JSON.stringify({ choices: [{ message }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("decideAgentTurn", () => {
  it("parses visualize and research tool calls plus the spoken answer", async () => {
    const fetchImpl = vi.fn(async () =>
      groqResponse({
        content: "Great question — let me walk through the core idea.",
        tool_calls: [
          {
            function: {
              name: "visualize",
              arguments: JSON.stringify({ topic: "Attention mechanism", hint: "diagram: encoder-decoder flow" }),
            },
          },
          {
            function: {
              name: "research",
              arguments: JSON.stringify({ query: "prior work on sparse attention", scope: "both" }),
            },
          },
        ],
      }),
    );

    const result = await decideAgentTurn(
      { question: "How does attention work here?", pdfExcerpt: "The paper introduces..." },
      { apiKey: "test-key", fetchImpl },
    );

    expect(result.answer).toMatch(/core idea/);
    expect(result.toolCalls).toEqual([
      { name: "visualize", args: { topic: "Attention mechanism", hint: "diagram: encoder-decoder flow" } },
      { name: "research", args: { query: "prior work on sparse attention", scope: "both" } },
    ]);
  });

  it("returns an empty tool-call list when the model doesn't call any tools", async () => {
    const fetchImpl = vi.fn(async () => groqResponse({ content: "Simple answer, no tools needed." }));

    const result = await decideAgentTurn(
      { question: "What's the title?", pdfExcerpt: "..." },
      { apiKey: "test-key", fetchImpl },
    );

    expect(result.toolCalls).toEqual([]);
    expect(result.answer).toBe("Simple answer, no tools needed.");
  });

  it("skips a tool call with malformed JSON arguments instead of throwing", async () => {
    const fetchImpl = vi.fn(async () =>
      groqResponse({
        content: "Answering anyway.",
        tool_calls: [{ function: { name: "visualize", arguments: "{not json" } }],
      }),
    );

    const result = await decideAgentTurn(
      { question: "q", pdfExcerpt: "..." },
      { apiKey: "test-key", fetchImpl },
    );

    expect(result.toolCalls).toEqual([]);
    expect(result.answer).toBe("Answering anyway.");
  });

  it("ignores a tool call for a name outside the registered tool set", async () => {
    const fetchImpl = vi.fn(async () =>
      groqResponse({
        content: "ok",
        tool_calls: [{ function: { name: "deep_think", arguments: "{}" } }],
      }),
    );

    const result = await decideAgentTurn(
      { question: "q", pdfExcerpt: "..." },
      { apiKey: "test-key", fetchImpl },
    );

    expect(result.toolCalls).toEqual([]);
  });

  it("throws with a descriptive message on a non-2xx response", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("rate limited", { status: 429, statusText: "Too Many Requests" }),
    );

    await expect(
      decideAgentTurn({ question: "q", pdfExcerpt: "..." }, { apiKey: "test-key", fetchImpl }),
    ).rejects.toThrow(/429/);
  });

  it("includes recentVisuals in the prompt to discourage repeats", async () => {
    const captured: Array<{ body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      captured.push({ body: JSON.parse(String(init?.body ?? "{}")) });
      return groqResponse({ content: "ok" });
    });

    await decideAgentTurn(
      {
        question: "q",
        pdfExcerpt: "...",
        recentVisuals: [{ title: "Fat tree topology", kind: "diagram" }],
      },
      { apiKey: "test-key", fetchImpl },
    );

    const messages = captured[0].body.messages as Array<{ content: string }>;
    expect(messages[0].content).toMatch(/Fat tree topology/);
  });
});
