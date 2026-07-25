import { test, expect } from "@playwright/test";
import { seedPdfState } from "./helpers/seed-pdf";
import { installFakeLanguageModel } from "./helpers/fake-language-model";

// End-to-end coverage of the actual product loop — a paper is loaded, a tool
// call is dispatched, and it produces a rendered slide plus a background
// research item — driven through the dev harness instead of a live voice
// session.
//
// This test's subject is UI WIRING: does a tool call actually end up as a
// rendered slide and a research feed entry? It is NOT about pdfjs-dist parsing
// (covered separately in pdf-parsing.spec.ts) or model output quality (covered
// by evals/run.ts). So PDF state is seeded directly via seedPdfState(), and
// the on-device model is faked via installFakeLanguageModel() — headless
// Chromium has no real Gemini Nano. Everything between those two seams is the
// app's real code, including genuine mermaid.render().
//
// Research still crosses an HTTP boundary, so it is mocked with page.route().

const DIAGRAM_RESPONSE = JSON.stringify({
  title: "Expander graph topology",
  narration: "Edge expansion measures cut quality across the graph.",
  mermaid: "flowchart LR\n  A[Switch] --> B[Switch]\n  B --> C[Switch]\n  C --> A",
});

async function mockResearch(page: import("@playwright/test").Page) {
  await page.route("**/api/research", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        summary:
          "Expander graphs were studied extensively in spectral graph theory before their networking application.",
        keyPoints: [
          "The Hoory-Linial-Wigderson survey established the core theory.",
          "Xpander applied it to practical datacenter routing.",
        ],
      }),
    });
  });
}

test.describe("no-voice product loop (dev harness)", () => {
  test("dispatch a visualize + research tool call, get a rendered slide and a research item", async ({
    page,
  }) => {
    await installFakeLanguageModel(page, { responses: [DIAGRAM_RESPONSE] });
    await seedPdfState(page);
    await mockResearch(page);

    await page.getByTestId("harness-kind-select").selectOption("diagram");
    await page.getByTestId("harness-topic-input").fill("Expander graph topology");
    await page.getByTestId("harness-hint-input").fill("switches connected in an expander");
    await page
      .getByTestId("harness-facts-input")
      .fill("Three switches, each connected to the other two, forming a 3-regular ring.");
    await page.getByTestId("harness-visualize-button").click();

    // The slide actually rendered an SVG — i.e. real mermaid.render() succeeded
    // on model output that passed our validators, not just "a call happened".
    await expect(page.locator(".deck-slide svg").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "Expander graph topology" })).toBeVisible();

    // And the research tool call lands in the research feed.
    await page.getByTestId("harness-research-input").fill("prior work on expander graphs");
    await page.getByTestId("harness-research-button").click();

    const researchFeed = page.getByTestId("harness-research-feed");
    await expect(researchFeed.getByText("prior work on expander graphs")).toBeVisible();
    await expect(researchFeed.getByText(/spectral graph theory/i)).toBeVisible();
  });

  test("the agent-chosen kind selects the renderer, not a keyword guess", async ({ page }) => {
    await installFakeLanguageModel(page, {
      responses: [
        JSON.stringify({
          title: "Topology comparison",
          narration: "Expander beats fat-tree on links at equal bandwidth.",
          columns: ["Topology", "Links", "Bisection BW"],
          rows: [
            ["Expander", "40% fewer", "0.92"],
            ["Fat-tree", "baseline", "0.61"],
          ],
        }),
      ],
    });
    await seedPdfState(page);

    // "topology" would have been guessed as a diagram by the old keyword
    // heuristic; the explicit kind must win.
    await page.getByTestId("harness-kind-select").selectOption("table");
    await page.getByTestId("harness-topic-input").fill("Topology comparison");
    await page.getByTestId("harness-visualize-button").click();

    await expect(page.getByRole("heading", { name: "Topology comparison" })).toBeVisible();
    await expect(page.locator(".deck-slide table")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".deck-slide table td").first()).toHaveText("Expander");
    // No mermaid diagram was rendered — the explicit kind won over the
    // "topology" keyword that the old heuristic would have read as a diagram.
    // (Scoped to the slide body: the card header has a Lucide icon svg.)
    await expect(page.locator(".deck-slide .bg-card svg")).toHaveCount(0);
  });

  test("a malformed model response surfaces as a visible error, not a silent gap", async ({
    page,
  }) => {
    // Never produces valid mermaid, so every retry is rejected by the
    // validator and the loop eventually gives up.
    await installFakeLanguageModel(page, {
      responses: [JSON.stringify({ title: "Broken", narration: "n", mermaid: "not a diagram" })],
    });
    await seedPdfState(page);

    await page.getByTestId("harness-topic-input").fill("Something unrenderable");
    await page.getByTestId("harness-visualize-button").click();

    await expect(page.locator(".deck-slide").getByText(/on-device generation failed/i)).toBeVisible(
      { timeout: 20_000 },
    );
  });

  test("an unavailable on-device model explains itself instead of failing silently", async ({
    page,
  }) => {
    await installFakeLanguageModel(page, { responses: [], availability: "downloadable" });
    await seedPdfState(page);

    await page.getByTestId("harness-topic-input").fill("Anything");
    await page.getByTestId("harness-visualize-button").click();

    await expect(page.locator(".deck-slide").getByText(/still downloading/i)).toBeVisible({
      timeout: 10_000,
    });
  });
});
