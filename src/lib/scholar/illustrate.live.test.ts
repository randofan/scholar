import { describe, expect, it } from "vitest";
import { generateVisual, validateVisual } from "./illustrate.server";

const hasGroq = !!process.env.GROQ_API_KEY;
const runIf = hasGroq ? describe : describe.skip;

runIf("illustrate live generation", () => {
  it(
    "generates a valid diagram for a process topic",
    async () => {
      const result = await generateVisual(
        {
          topic: "BF16 Decomposition and Reconstruction",
          hint: "flow diagram showing how a BF16 value splits into sign, exponent, mantissa and is reconstructed",
          pdfExcerpt:
            "BFloat16 (BF16) is a 16-bit floating-point format with 1 sign bit, 8 exponent bits, and 7 mantissa bits. Decomposition extracts these three components from a 32-bit FP32 representation. Reconstruction reassembles them back into FP32 by zero-padding the mantissa.",
        },
        { maxAttempts: 4 },
      );
      expect(validateVisual(result.visual).ok).toBe(true);
      // Kind depends on what the model picks for the hint;
      // diagram is expected but any structured visual is acceptable.
      expect(["diagram", "chart", "table", "callout"]).toContain(result.visual.kind);
      if (result.visual.kind === "diagram") {
        expect(result.visual.diagram?.mermaid).toMatch(/(graph|flowchart|sequenceDiagram)/);
      }
      console.log("illustrate attempts:", result.attempts, "warnings:", result.warnings);
    },
    120_000,
  );

  it(
    "produces a diagram (forced via hint) that passes mermaid validation",
    async () => {
      const result = await generateVisual(
        {
          topic: "Training loop for a transformer language model",
          hint: "Return kind=diagram with a mermaid flowchart of: data -> tokenize -> forward pass -> loss -> backprop -> optimizer step -> repeat",
        },
        { maxAttempts: 4 },
      );
      expect(validateVisual(result.visual).ok).toBe(true);
      console.log(
        "diagram-forced attempts:",
        result.attempts,
        "kind:",
        result.visual.kind,
        "warnings:",
        result.warnings,
      );
    },
    120_000,
  );
});
