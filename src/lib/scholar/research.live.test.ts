import { describe, expect, it } from "vitest";
import { generateResearch } from "./research.server";

const hasGemini = !!process.env.GEMINI_API_KEY;
const runIf = hasGemini ? describe : describe.skip;

runIf("research live deep agent", () => {
  it("produces a grounded briefing for a real paper topic using tools", async () => {
    const { result, attempts, warnings, toolCalls } = await generateResearch(
      {
        query: "Background and prior work on lossless weight compression for LLM inference",
        pdfExcerpt:
          "Unweight: Lossless MLP Weight Compression for LLM Inference. We present a composable GPU toolkit for dense inference and MoE serving, focused on lossless compression of weight tensors via bit-level decomposition (sign, exponent, mantissa for BF16).",
      },
      { maxAttempts: 3 },
    );
    expect(result.summary.length).toBeGreaterThan(80);
    // The voice agent should never speak URLs.
    expect(result.summary).not.toMatch(/https?:\/\//);
    expect(result.summary).not.toMatch(/\]\(/); // markdown link syntax
    for (const kp of result.keyPoints) {
      expect(kp).not.toMatch(/https?:\/\//);
    }
    console.log("research attempts:", attempts, "toolCalls:", toolCalls, "warnings:", warnings);
    console.log("research summary:", result.summary);
    console.log("keyPoints:", result.keyPoints);
  }, 240_000);

  it("handles a vague topic without throwing", async () => {
    const { result, toolCalls } = await generateResearch(
      { query: "key concepts in lossless model weight compression" },
      { maxAttempts: 3 },
    );
    expect(result.summary.length).toBeGreaterThan(40);
    console.log("vague toolCalls:", toolCalls);
  }, 240_000);
});
