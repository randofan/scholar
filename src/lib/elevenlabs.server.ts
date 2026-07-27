import {
  SCHOLAR_AGENT_NAME,
  buildScholarAgentCreatePayload,
  buildScholarAgentUpdatePayload,
} from "@/lib/scholar/scholar-agent-config";

const ELEVENLABS_API_ORIGIN = "https://api.elevenlabs.io";

function getElevenLabsApiKey() {
  const apiKey = process.env.ELEVENLABS_API_KEY_1 ?? process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error("ElevenLabs connector API key is not configured");
  }
  return apiKey;
}

async function fetchElevenLabsJson<T>(
  path: string,
  label: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${ELEVENLABS_API_ORIGIN}${path}`, {
    method: init.method ?? "GET",
    ...init,
    headers: {
      "xi-api-key": getElevenLabsApiKey(),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ElevenLabs ${label} request failed [${res.status}]: ${body.slice(0, 500)}`);
  }

  return (await res.json()) as T;
}

export async function fetchElevenLabsConversationSignedUrl(agentId: string) {
  const json = await fetchElevenLabsJson<{ signed_url?: string }>(
    `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
    "signed URL",
  );
  if (!json.signed_url) {
    throw new Error("ElevenLabs returned no signed URL");
  }
  return json.signed_url;
}

// ──────────────────────────────────────────────────────────────────────
// Auto-provisioned Scholar agent
// ──────────────────────────────────────────────────────────────────────

interface ListAgentsResponse {
  agents?: Array<{ agent_id?: string; name?: string }>;
}

interface CreateAgentResponse {
  agent_id?: string;
}

// Worker-lifetime cache keyed by API key so swapping keys doesn't reuse
// an agent that lives on a different workspace.
const scholarAgentCache = new Map<string, string>();

export async function findScholarAgentId(): Promise<string | null> {
  // The list endpoint supports ?search= which fuzzy-matches the name.
  const json = await fetchElevenLabsJson<ListAgentsResponse>(
    `/v1/convai/agents?page_size=30&search=${encodeURIComponent(SCHOLAR_AGENT_NAME)}`,
    "list agents",
  );
  const match = json.agents?.find((a) => a.name === SCHOLAR_AGENT_NAME);
  return match?.agent_id ?? null;
}

export async function createScholarAgent(): Promise<string> {
  const json = await fetchElevenLabsJson<CreateAgentResponse>(
    "/v1/convai/agents/create",
    "create agent",
    {
      method: "POST",
      body: JSON.stringify(buildScholarAgentCreatePayload()),
    },
  );
  if (!json.agent_id) {
    throw new Error("ElevenLabs create-agent returned no agent_id");
  }
  return json.agent_id;
}

/**
 * Reconcile an existing agent's prompt + tools with our current code.
 * Fix for the "LLM Cascade Error: Tool not found in available tools" crash:
 * an agent created with an older tool set (e.g. no `visualize`) would
 * reject the model's tool call. We now PATCH on every cold start.
 */
export async function syncScholarAgentConfig(agentId: string): Promise<void> {
  await fetchElevenLabsJson<unknown>(
    `/v1/convai/agents/${encodeURIComponent(agentId)}`,
    "update agent",
    {
      method: "PATCH",
      body: JSON.stringify(buildScholarAgentUpdatePayload()),
    },
  );
}

/**
 * Return an auto-provisioned Scholar agent ID, creating one if none exists.
 * If an existing agent is found, its prompt + client tool definitions are
 * PATCHed to match the current code so config drift can't trigger the
 * "Tool not found in available tools" cascade error. Cached per worker per
 * API key so the sync runs at most once per cold start.
 */
export async function ensureScholarAgentId(): Promise<string> {
  const key = getElevenLabsApiKey();
  const cached = scholarAgentCache.get(key);
  if (cached) return cached;

  const existing = await findScholarAgentId();
  if (existing) {
    await syncScholarAgentConfig(existing);
    scholarAgentCache.set(key, existing);
    return existing;
  }

  const created = await createScholarAgent();
  scholarAgentCache.set(key, created);
  return created;
}

// Test-only — let tests start from a clean cache.
export function __resetScholarAgentCache() {
  scholarAgentCache.clear();
}
