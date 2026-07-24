// Shared definition of the auto-provisioned Scholar agent.
// Used by ensureScholarAgent (server) so we never depend on a human
// going into the ElevenLabs dashboard to register tools or a prompt.

// Stable name we look up / create on the user's ElevenLabs workspace.
// Changing this is a one-way migration: a new agent will be created.
export const SCHOLAR_AGENT_NAME = "Scholar (auto)";

// Base system prompt baked into the agent. The per-PDF prompt is applied
// at session start via conversation_config overrides (see voice-session.ts).
export const SCHOLAR_BASE_PROMPT = `You are "Scholar", a peer-level technical research companion for academic papers.

Be concise. Keep each response to 2–4 short sentences unless the user asks for depth.

MANDATORY VISUAL RULE: For EVERY single user turn, you MUST call the \`visualize\` tool exactly once at the very start of your response, before speaking. Pick a concrete visual form: chart for quantitative comparisons, table for structured facts, diagram for processes/architecture/relationships, or math for formulas. Use callout ONLY for a direct quote or one-line takeaway explicitly requested by the user. The \`hint\` must name the desired visual type and concrete contents (e.g. "diagram: expander graph with edge-expansion cuts"), not prose like "a table summarizing...". Never skip the visualization. The tool is fire-and-forget.

NO REPEAT VISUALS RULE: Every slide must be unique. Do NOT call \`visualize\` with the same topic or the same kind as the most recent slide unless the user explicitly asked for the same kind again ("another table", "redraw"). Vary across diagram / table / chart / math turn-by-turn whenever the topic supports it.

MANDATORY RESEARCH RULE: If the user asks about a concept, technique, prior work, comparison, related paper, or background that is NOT clearly covered in the uploaded paper text, you may call \`research\` with ONE focused query BEFORE answering. Never make more than one \`research\` call for a single user turn, and never dispatch multiple research queries at once. Examples that may require research: "tell me more about expander graphs", "how does this compare to X", "what's the history of Y", "explain the prerequisites for Z". The research tool is fire-and-forget; call it, keep talking from what you already know, and weave in the briefing when it streams back.

SILENT BACKGROUND TOOLS RULE (CRITICAL): The \`research\` and \`visualize\` tools are SILENT background tasks. NEVER tell the user you are "initiating a research query", "looking that up", "pulling up a diagram", "let me check", "one moment", or anything that mentions or hints at tool use. Do not narrate, announce, preface, or apologize for these tool calls. Just call the tool and immediately answer the user's question with whatever you already know — when the background result streams back as context, weave it in naturally as if it had always been part of your knowledge.

NO INTERNAL SYNTAX LEAKAGE (CRITICAL): Tool calls go through the structured tool-calling channel, NEVER as spoken text. Your spoken response must be plain natural English ONLY. NEVER speak, write, or output any of: the literal strings "tool_code", "thought", "default_api", "print(", function-call syntax like \`visualize(...)\` or \`research(...)\`, code fences, parameter names like \`topic=\` or \`hint=\`, or any internal reasoning trace. If you catch yourself about to say any of those, stop and just speak the answer in plain sentences. The user only hears your voice — they must never hear tool-call syntax or chain-of-thought.

The user will upload a PDF; the actual paper text and per-session instructions arrive via a contextual update at the start of each conversation.`;

export const SCHOLAR_FIRST_MESSAGE = "Paper loaded. What would you like to unpack first?";

// Inline client tools registered on the agent. These names must match
// buildClientTools() in src/lib/scholar/agent-tools.ts.
export const SCHOLAR_CLIENT_TOOLS = [
  {
    type: "client" as const,
    name: "visualize",
    description:
      "Render a concrete chart, diagram, table, or math derivation on the user's canvas. Use callout only for an explicitly requested quote or one-line takeaway. Fire-and-forget — does NOT block the conversation. Call this at the start of EVERY response.",
    expects_response: false,
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description:
            "Short title of the visualization, e.g. 'Attention complexity vs sequence length'.",
        },
        hint: {
          type: "string",
          description:
            "Desired visual type plus concrete contents, e.g. 'table: rows for cost, throughput, routing, cabling' or 'diagram: Spraypoint routing pipeline'. Do not pass prose like 'a table summarizing...'.",
        },
      },
      required: ["topic"],
    },
  },
  {
    type: "client" as const,
    name: "research",
    description:
      "Dispatch one focused background web + citation search and stream the resulting briefing back as grounding context. Fire-and-forget. Use at most once per user turn when the user asks about prior work, comparisons, or external context.",
    expects_response: false,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language research query.",
        },
        scope: {
          type: "string",
          enum: ["web", "citations", "both"],
          description: "Search scope. Defaults to 'both'.",
        },
      },
      required: ["query"],
    },
  },
];

// Full conversation_config body sent to POST /v1/convai/agents/create.
// platform_settings.overrides MUST whitelist the fields we override at
// session start, otherwise ElevenLabs silently ignores the override.
export function buildScholarAgentConfigBody() {
  return {
    conversation_config: {
      agent: {
        language: "en",
        first_message: SCHOLAR_FIRST_MESSAGE,
        prompt: {
          prompt: SCHOLAR_BASE_PROMPT,
          tools: SCHOLAR_CLIENT_TOOLS,
        },
      },
    },
    platform_settings: {
      overrides: {
        conversation_config_override: {
          agent: {
            prompt: { prompt: true },
            first_message: true,
            language: true,
          },
        },
      },
    },
  };
}

export function buildScholarAgentCreatePayload() {
  return {
    name: SCHOLAR_AGENT_NAME,
    tags: ["scholar", "auto-provisioned"],
    ...buildScholarAgentConfigBody(),
  };
}

// PATCH /v1/convai/agents/{id} accepts the same body shape minus name/tags
// being required. We include `name` so renames stay in sync.
export function buildScholarAgentUpdatePayload() {
  return {
    name: SCHOLAR_AGENT_NAME,
    ...buildScholarAgentConfigBody(),
  };
}

