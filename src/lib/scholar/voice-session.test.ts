import { describe, expect, it } from "vitest";
import {
  buildScholarContextUpdate,
  buildScholarFirstMessage,
  buildScholarPrompt,
  buildScholarVoiceSessionOptions,
} from "./voice-session";

describe("Scholar voice session options", () => {
  it("passes prompt and first-message overrides through signed WebSocket sessions", () => {
    const options = buildScholarVoiceSessionOptions(
      "wss://api.elevenlabs.io/v1/convai/conversation?signed=1",
      {
        name: "paper.pdf",
        pages: 7,
        text: "TEST_CONTEXT_ABC",
      },
    );

    expect(options).toMatchObject({
      signedUrl: "wss://api.elevenlabs.io/v1/convai/conversation?signed=1",
      connectionType: "websocket",
      overrides: {
        agent: {
          prompt: { prompt: expect.stringContaining("TEST_CONTEXT_ABC") },
          firstMessage: "I've loaded paper.pdf. What would you like to unpack first?",
        },
      },
    });
    expect(options).not.toHaveProperty("conversationToken");
  });

  it("includes bounded PDF context in agent overrides", () => {
    const prompt = buildScholarPrompt({ name: "paper.pdf", pages: 7, text: "x".repeat(31_000) });

    expect(prompt).toContain('The user uploaded "paper.pdf" (7 pages)');
    expect(prompt).toContain("PAPER CONTENT");
    expect(prompt.length).toBeLessThan(32_000);
  });

  it("also builds PDF context as a contextual update after connect", () => {
    const context = buildScholarContextUpdate({
      name: "paper.pdf",
      pages: 2,
      text: "TEST_CONTEXT_ABC",
    });

    expect(context).toContain("session instructions and uploaded PDF context");
    expect(context).toContain('The user uploaded "paper.pdf" (2 pages)');
    expect(context).toContain("TEST_CONTEXT_ABC");
  });

  it("builds a PDF-aware first message override", () => {
    expect(buildScholarFirstMessage({ name: "paper.pdf", pages: 2, text: "" })).toBe(
      "I've loaded paper.pdf. What would you like to unpack first?",
    );
  });
});
