import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { validateMermaid } from "@/lib/scholar/illustrate-shared";

interface CorpusEntry {
  name: string;
  expected: "ok" | "fail";
  source: string;
}

const corpus: CorpusEntry[] = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "../../evals/mermaid-corpus/corpus.json"), "utf-8"),
);

test.describe("mermaid corpus — real render fidelity", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/dev-mermaid-harness");
    // Wait for the hook itself (not just the static ready div) — on a cold
    // dev-server hit, hydration + the mermaid module warm-up can lag behind
    // the initial (SSR'd) DOM paint.
    await page.waitForFunction(
      () =>
        typeof window.__renderMermaidForTest === "function" &&
        typeof window.__parseMermaidForTest === "function",
      { timeout: 15_000 },
    );
  });

  for (const entry of corpus) {
    test(`${entry.name}: our validator predicts the real mermaid.render() outcome`, async ({
      page,
    }) => {
      const realResult = await page.evaluate(
        (source) => window.__renderMermaidForTest!(source),
        entry.source,
      );

      // Ground truth sanity: is the corpus entry labeled correctly against
      // what mermaid itself actually does?
      expect(
        realResult.ok,
        `corpus entry "${entry.name}" is labeled expected="${entry.expected}" but real mermaid.render() ${
          realResult.ok ? "succeeded" : `failed: ${realResult.error}`
        }`,
      ).toBe(entry.expected === "ok");

      // The real assertion this test exists for: our structural validator's
      // verdict must match what the real renderer does. A mismatch here is a
      // validator gap — either a false "ok" (bad diagram slips through to
      // production) or a false "fail" (a valid diagram gets rejected).
      const validatorResult = validateMermaid(entry.source);
      expect(
        validatorResult.ok,
        `validateMermaid() disagrees with the real renderer for "${entry.name}": validator says ${
          validatorResult.ok ? "ok" : `fail (${validatorResult.reason})`
        }, real render says ${realResult.ok ? "ok" : `fail (${realResult.error})`}`,
      ).toBe(realResult.ok);

      // And the generation loop's second gate — mermaid's own parser — must
      // agree with the renderer too. This is the gate that makes the loop
      // able to *guarantee* renderable output rather than merely probable
      // output, so a disagreement here would silently reopen that gap.
      const parseResult = await page.evaluate(
        (source) => window.__parseMermaidForTest!(source),
        entry.source,
      );
      expect(
        parseResult.checked,
        `parseMermaid() did not actually run for "${entry.name}" — the loop's parser gate would be a no-op`,
      ).toBe(true);
      expect(
        parseResult.ok,
        `parseMermaid() disagrees with the real renderer for "${entry.name}": parser says ${
          parseResult.ok ? "ok" : `fail (${"reason" in parseResult ? parseResult.reason : ""})`
        }, real render says ${realResult.ok ? "ok" : `fail (${realResult.error})`}`,
      ).toBe(realResult.ok);
    });
  }
});
