import { createServerFn } from "@tanstack/react-start";
import { ensureScholarAgentId, fetchElevenLabsConversationSignedUrl } from "./elevenlabs.server";

/**
 * Look up (or create) the auto-provisioned Scholar agent on the configured
 * ElevenLabs workspace and return both the agent ID and a fresh signed URL
 * for a WebSocket session. This is what the UI calls when the user clicks
 * "Start" — no manual agent setup required.
 */
export const startScholarVoiceSession = createServerFn({ method: "POST" }).handler(async () => {
  const agentId = await ensureScholarAgentId();
  const signedUrl = await fetchElevenLabsConversationSignedUrl(agentId);
  return { agentId, signedUrl };
});
