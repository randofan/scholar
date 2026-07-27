import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchElevenLabsConversationSignedUrl } from "./elevenlabs.server";

const originalApiKey = process.env.ELEVENLABS_API_KEY_1;

afterEach(() => {
  process.env.ELEVENLABS_API_KEY_1 = originalApiKey;
  vi.restoreAllMocks();
});

describe("ElevenLabs connector helpers", () => {
  it("requests a signed URL for authenticated WebSocket sessions", async () => {
    process.env.ELEVENLABS_API_KEY_1 = "test-key";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ signed_url: "wss://signed.example" }), { status: 200 }),
      );

    await expect(fetchElevenLabsConversationSignedUrl("agent_abc")).resolves.toBe(
      "wss://signed.example",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=agent_abc",
      expect.objectContaining({ headers: { "xi-api-key": "test-key" } }),
    );
  });
});
