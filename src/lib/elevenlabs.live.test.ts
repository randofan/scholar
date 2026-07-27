import { describe, expect, it } from "vitest";
import { fetchElevenLabsConversationSignedUrl } from "./elevenlabs.server";

const AGENT_ID = "agent_1701krmxt8bve3svarx3wz0kj1wj";

async function openConversationMetadata(signedUrl: string) {
  const separator = signedUrl.includes("?") ? "&" : "?";
  const socket = new WebSocket(`${signedUrl}${separator}source=react_sdk&version=1.6.0`, [
    "convai",
  ]);

  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for ElevenLabs conversation metadata"));
    }, 15_000);

    socket.addEventListener(
      "open",
      () => {
        socket.send(JSON.stringify({ type: "conversation_initiation_client_data" }));
      },
      { once: true },
    );
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timeout);
        socket.close(1000, "live test complete");
        resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(new Error("ElevenLabs signed WebSocket connection failed"));
      },
      { once: true },
    );
    socket.addEventListener(
      "close",
      (event) => {
        if (event.code !== 1000) {
          clearTimeout(timeout);
          reject(
            new Error(`ElevenLabs signed WebSocket closed early [${event.code}]: ${event.reason}`),
          );
        }
      },
      { once: true },
    );
  });
}

async function openSeededConversation(signedUrl: string) {
  const separator = signedUrl.includes("?") ? "&" : "?";
  const socket = new WebSocket(`${signedUrl}${separator}source=react_sdk&version=1.6.0`, [
    "convai",
  ]);

  return await new Promise<{ metadata: Record<string, unknown>; response: string }>(
    (resolve, reject) => {
      let metadata: Record<string, unknown> | null = null;
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("Timed out waiting for seeded ElevenLabs conversation response"));
      }, 15_000);

      socket.addEventListener(
        "open",
        () => {
          socket.send(JSON.stringify({ type: "conversation_initiation_client_data" }));
        },
        { once: true },
      );
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as {
          type?: string;
          conversation_initiation_metadata_event?: Record<string, unknown>;
          agent_response_event?: { agent_response?: string };
          ping_event?: { event_id?: number };
        };

        if (message.type === "conversation_initiation_metadata") {
          metadata = message.conversation_initiation_metadata_event ?? {};
          socket.send(
            JSON.stringify({
              type: "contextual_update",
              text: "SESSION CONTEXT: The uploaded PDF is live-test.pdf. PDF content marker: TEST_CONTEXT_ABC.",
              context_id: "pdf:live-test.pdf",
            }),
          );
          socket.send(
            JSON.stringify({
              type: "user_message",
              text: "What marker is in the uploaded PDF context?",
            }),
          );
          return;
        }

        if (message.type === "ping") {
          socket.send(JSON.stringify({ type: "pong", event_id: message.ping_event?.event_id }));
          return;
        }

        const response = message.agent_response_event?.agent_response;
        if (metadata && response?.includes("TEST_CONTEXT_ABC")) {
          clearTimeout(timeout);
          socket.close(1000, "live seeded test complete");
          resolve({ metadata, response });
        }
      });
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error("ElevenLabs seeded WebSocket connection failed"));
        },
        { once: true },
      );
      socket.addEventListener(
        "close",
        (event) => {
          if (event.code !== 1000) {
            clearTimeout(timeout);
            reject(
              new Error(
                `ElevenLabs seeded WebSocket closed early [${event.code}]: ${event.reason}`,
              ),
            );
          }
        },
        { once: true },
      );
    },
  );
}

async function openOverrideAndToolConversation(signedUrl: string) {
  const separator = signedUrl.includes("?") ? "&" : "?";
  const socket = new WebSocket(`${signedUrl}${separator}source=react_sdk&version=1.6.0`, [
    "convai",
  ]);

  return await new Promise<{ overrideResponse: string; toolName: string }>((resolve, reject) => {
    let overrideResponse = "";
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for override/tool verification"));
    }, 30_000);

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          type: "conversation_initiation_client_data",
          conversation_config_override: {
            agent: {
              prompt: {
                prompt:
                  "If asked for the override marker, answer exactly OVERRIDE_MARKER_123. If asked to test the canvas, call the visualize client tool with topic SDK_TOOL_MARKER_456.",
              },
              first_message: "Override hello OVERRIDE_FIRST_789",
            },
            conversation: {
              client_events: [
                "conversation_initiation_metadata",
                "agent_response",
                "client_tool_call",
                "ping",
              ],
            },
          },
        }),
      );
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        type?: string;
        ping_event?: { event_id?: number };
        agent_response_event?: { agent_response?: string };
        client_tool_call?: {
          tool_name: string;
          tool_call_id: string;
          parameters: Record<string, unknown>;
        };
      };
      if (message.type === "conversation_initiation_metadata") {
        socket.send(JSON.stringify({ type: "user_message", text: "What is the override marker?" }));
        return;
      }
      if (message.type === "ping") {
        socket.send(JSON.stringify({ type: "pong", event_id: message.ping_event?.event_id }));
        return;
      }
      const response = message.agent_response_event?.agent_response;
      if (response?.includes("OVERRIDE_MARKER_123")) {
        overrideResponse = response;
        socket.send(
          JSON.stringify({ type: "user_message", text: "Please test the canvas tool now." }),
        );
        return;
      }
      if (message.type === "client_tool_call" && message.client_tool_call) {
        clearTimeout(timeout);
        socket.send(
          JSON.stringify({
            type: "client_tool_result",
            tool_call_id: message.client_tool_call.tool_call_id,
            result: "tool ok",
            is_error: false,
          }),
        );
        socket.close(1000, "live override/tool test complete");
        resolve({ overrideResponse, toolName: message.client_tool_call.tool_name });
      }
    });
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(new Error("ElevenLabs override/tool WebSocket connection failed"));
      },
      { once: true },
    );
    socket.addEventListener(
      "close",
      (event) => {
        if (event.code !== 1000) {
          clearTimeout(timeout);
          reject(
            new Error(
              `ElevenLabs override/tool WebSocket closed early [${event.code}]: ${event.reason}`,
            ),
          );
        }
      },
      { once: true },
    );
  });
}

describe("ElevenLabs live connector", () => {
  it.skipIf(
    process.env.RUN_ELEVENLABS_LIVE_TEST !== "true" ||
      (!process.env.ELEVENLABS_API_KEY_1 && !process.env.ELEVENLABS_API_KEY),
  )(
    "opens an authenticated signed WebSocket conversation",
    async () => {
      const signedUrl = await fetchElevenLabsConversationSignedUrl(AGENT_ID);
      const message = await openConversationMetadata(signedUrl);

      expect(message.type).toBe("conversation_initiation_metadata");
      expect(message.conversation_initiation_metadata_event).toMatchObject({
        conversation_id: expect.stringMatching(/^conv_/),
      });
    },
    20_000,
  );

  it.skipIf(
    process.env.RUN_ELEVENLABS_LIVE_TEST !== "true" ||
      (!process.env.ELEVENLABS_API_KEY_1 && !process.env.ELEVENLABS_API_KEY),
  )(
    "keeps the session open after PDF context is seeded with a contextual update",
    async () => {
      const signedUrl = await fetchElevenLabsConversationSignedUrl(AGENT_ID);
      const seeded = await openSeededConversation(signedUrl);

      expect(seeded.metadata).toMatchObject({ conversation_id: expect.stringMatching(/^conv_/) });
      expect(seeded.response).toContain("TEST_CONTEXT_ABC");
    },
    20_000,
  );

  it.skipIf(
    process.env.RUN_ELEVENLABS_LIVE_TEST !== "true" ||
      (!process.env.ELEVENLABS_API_KEY_1 && !process.env.ELEVENLABS_API_KEY),
  )(
    "accepts runtime prompt overrides and emits configured client tool calls",
    async () => {
      const signedUrl = await fetchElevenLabsConversationSignedUrl(AGENT_ID);
      const result = await openOverrideAndToolConversation(signedUrl);

      expect(result.overrideResponse).toContain("OVERRIDE_MARKER_123");
      expect(result.toolName).toBe("visualize");
    },
    35_000,
  );
});
