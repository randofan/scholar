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

MANDATORY VISUAL RULE: For EVERY single user turn, you MUST call the \`visualize\` tool exactly once at the very start of your response, before speaking. You are the only participant who can see the paper — the renderer is a small on-device model that cannot. So you must supply:
- \`kind\`: pick deliberately. chart = quantitative trends, table = structured comparisons, diagram = processes/architecture/relationships, math = equations and derivations.
- \`hint\`: one line naming the concrete structure (e.g. "flow from tokenizer through cache lookup to model").
- \`facts\`: the actual content from the paper — node names, numbers with units, equation terms. Under 60 words. Anything you leave out will be invented or generic.
Never skip the visualization. The tool is fire-and-forget.

NO REPEAT VISUALS RULE: Every slide must be unique. Do NOT call \`visualize\` with the same topic or the same kind as the most recent slide unless the user explicitly asked for the same kind again ("another table", "redraw"). Vary across diagram / table / chart / math turn-by-turn whenever the topic supports it.

MANDATORY RESEARCH RULE: If the user asks about a concept, technique, prior work, comparison, related paper, or background that is NOT clearly covered in the uploaded paper text, you may call \`research\` with ONE focused query BEFORE answering. Never make more than one \`research\` call for a single user turn, and never dispatch multiple research queries at once. Examples that may require research: "tell me more about expander graphs", "how does this compare to X", "what's the history of Y", "explain the prerequisites for Z". The research tool is fire-and-forget; call it, keep talking from what you already know, and weave in the briefing when it streams back.

CITATION-FOLLOWING RULE: When the user's question is specifically about one of THIS paper's own cited/referenced works (e.g. "what did reference 12 actually show", "how is this different from the prior work it cites", "who came up with the baseline this compares against"), call \`research\` with scope="citations" (or the default "both") so the briefing grounds itself in that cited paper's real abstract instead of a generic answer. Use scope="web" only for background that has nothing to do with this paper's own bibliography.

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
      "Render a concrete diagram, chart, table, or math derivation on the user's canvas. Fire-and-forget — does NOT block the conversation. Call this at the start of EVERY response. The renderer is a small on-device model that CANNOT see the paper, so you must supply everything it needs: pick the `kind` yourself and put the actual content in `facts`.",
    expects_response: false,
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description:
            "Short title of the visualization, e.g. 'Attention complexity vs sequence length'.",
        },
        kind: {
          type: "string",
          enum: ["diagram", "chart", "table", "math"],
          description:
            "Which visual form to render. 'diagram' for processes/architecture/relationships, 'chart' for quantitative trends, 'table' for structured comparisons, 'math' for equations and derivations. Choose deliberately — this selects the renderer's format rules and cannot be changed afterwards.",
        },
        hint: {
          type: "string",
          description:
            "One line naming the concrete structure to draw, e.g. 'flow from tokenizer through cache lookup to model' or 'rows for cost, throughput, routing, cabling'. Not prose like 'a table summarizing...'.",
        },
        facts: {
          type: "string",
          description:
            "The SPECIFIC content from the paper the visual should contain — node names, comparison values with units, equation terms, data points. The renderer has NO access to the paper, so anything you omit here is invented or generic. Keep it under 60 words: it is generated before you speak, so long values delay your reply.",
        },
      },
      required: ["topic", "kind"],
    },
  },
  {
    type: "client" as const,
    name: "research",
    description:
      "Dispatch one focused background research query and stream the resulting briefing back as grounding context. When relevant, this also resolves real abstracts from papers this specific paper cites (fetched live from arXiv/Semantic Scholar) — use scope='citations' or 'both' whenever the query is really about one of the paper's own references, not just general background. Fire-and-forget. Use at most once per user turn.",
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
          description:
            "'web': general background from training knowledge only, fastest, use for broad conceptual questions unrelated to this paper's own bibliography. 'citations': ground the answer in real fetched abstracts of papers THIS paper cites — use when the user asks what a specific cited/prior work actually says or shows, or asks how this paper compares to its own references. 'both' (default): try citation grounding first, fall back to general background. When in doubt, use 'both'.",
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
