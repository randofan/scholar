// A minimal stand-in for the ElevenLabs conversational LLM, used ONLY by the
// dev text harness (src/routes/dev-harness.tsx) so the product's tool-calling
// loop — "given a user question, decide whether to visualize and/or
// research, then answer" — can be exercised and tested without a live voice
// session. It reuses the exact same tool schemas the real agent is
// registered with (SCHOLAR_CLIENT_TOOLS), so a passing harness run means the
// same tool-call shapes the ElevenLabs agent would emit are handled
// correctly by buildClientTools.
//
// This mirrors production behavior faithfully in one respect that matters:
// tool calls are fire-and-forget here too (the harness dispatches them and
// moves on), since that's how the real agent uses them — it never waits for
// a tool result before continuing to speak.

import { GROQ_BASE_URL, GROQ_MODELS } from "@/lib/ai-gateway";
import { SCHOLAR_BASE_PROMPT, SCHOLAR_CLIENT_TOOLS } from "./scholar-agent-config";
import type { FetchLike } from "./illustrate.server";

export interface TextAgentInput {
  question: string;
  pdfExcerpt: string;
  recentVisuals?: Array<{ title: string; kind: string }>;
}

export interface TextAgentToolCall {
  name: "visualize" | "research";
  args: Record<string, unknown>;
}

export interface TextAgentResult {
  answer: string;
  toolCalls: TextAgentToolCall[];
}

interface GroqToolCallRaw {
  function?: { name?: string; arguments?: string };
}

interface GroqChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: GroqToolCallRaw[];
    };
  }>;
}

function toolsAsOpenAiFunctions() {
  return SCHOLAR_CLIENT_TOOLS.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

const VALID_TOOL_NAMES = new Set(SCHOLAR_CLIENT_TOOLS.map((t) => t.name));

/**
 * Ask the model, given the paper and a user question, what it would say and
 * which tools (if any) it would fire. Single-shot: the model doesn't see
 * tool results before answering, matching the real agent's "fire and keep
 * talking" behavior.
 */
export async function decideAgentTurn(
  input: TextAgentInput,
  opts: { apiKey: string; fetchImpl?: FetchLike; model?: string },
): Promise<TextAgentResult> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch.bind(globalThis) as FetchLike);
  const model = opts.model ?? GROQ_MODELS.reasoning;

  const recent = (input.recentVisuals ?? []).slice(0, 6);
  const recentBlock = recent.length
    ? `\n\nSlides already on the canvas (newest first) — avoid repeating: ${recent
        .map((r) => `${r.kind}: ${r.title}`)
        .join("; ")}`
    : "";

  const body = {
    model,
    messages: [
      {
        role: "system",
        content: `${SCHOLAR_BASE_PROMPT}\n\nPAPER EXCERPT:\n${input.pdfExcerpt.slice(0, 8000)}${recentBlock}`,
      },
      { role: "user", content: input.question },
    ],
    tools: toolsAsOpenAiFunctions(),
    tool_choice: "auto",
    temperature: 0.3,
    max_tokens: 1024,
  };

  const res = await fetchImpl(`${GROQ_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Groq agent-turn call failed: ${res.status} ${res.statusText} ${text.slice(0, 400)}`,
    );
  }
  const json = (await res.json()) as GroqChatResponse;
  const message = json.choices?.[0]?.message;

  const toolCalls: TextAgentToolCall[] = [];
  for (const raw of message?.tool_calls ?? []) {
    const name = raw.function?.name;
    if (!name || !VALID_TOOL_NAMES.has(name as "visualize" | "research")) continue;
    let args: Record<string, unknown> = {};
    try {
      args = raw.function?.arguments ? JSON.parse(raw.function.arguments) : {};
    } catch {
      // Malformed tool-call arguments from the model — skip this call rather
      // than crash the turn; the harness still shows the answer text.
      continue;
    }
    toolCalls.push({ name: name as "visualize" | "research", args });
  }

  return { answer: message?.content ?? "", toolCalls };
}
