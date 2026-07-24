import { test, expect } from "@playwright/test";
import { seedPdfState } from "./helpers/seed-pdf";

// End-to-end coverage of the actual product loop — a paper is loaded, a
// question is asked, and it produces a rendered slide plus a background
// research item — driven through the dev text harness instead of a live
// voice session (see PLAN.md Phase 4/1a).
//
// This test's subject is UI WIRING: does a tool-call decision actually end
// up as a rendered slide and a research feed entry? It is NOT about pdfjs-dist
// parsing (covered separately and more slowly in pdf-parsing.spec.ts) or
// model output quality (covered by the eval harness, evals/run.ts, against
// real validators). So PDF state is seeded directly via seedPdfState()
// rather than uploading and parsing a real file — that keeps this test fast
// and deterministic, decoupled from parsing-latency variance.
//
// The three network calls the harness makes (/api/agent-turn, /api/illustrate,
// /api/research) are mocked at the HTTP boundary via page.route().
test.describe("no-voice product loop (dev harness)", () => {
  test("ask a question, get a rendered slide and a research item", async ({ page }) => {
    await seedPdfState(page);
    const input = page.getByTestId("harness-question-input");

    await page.route("**/api/agent-turn", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          answer: "Expander graphs trade fewer links for near-optimal bisection bandwidth.",
          toolCalls: [
            {
              name: "visualize",
              args: { topic: "Expander graph topology", hint: "diagram: edge expansion" },
            },
            { name: "research", args: { query: "prior work on expander graphs", scope: "both" } },
          ],
        }),
      });
    });

    await page.route("**/api/illustrate", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          attempts: 1,
          warnings: [],
          visual: {
            title: "Expander graph topology",
            narration: "Edge expansion measures cut quality across the graph.",
            kind: "diagram",
            diagram: {
              mermaid: "flowchart LR\n  A[Switch] --> B[Switch]\n  B --> C[Switch]\n  C --> A",
            },
          },
        }),
      });
    });

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

    await input.fill("Tell me about the network topology used here.");
    await page.getByTestId("harness-ask-button").click();

    // The agent's spoken answer lands in the transcript.
    await expect(page.getByText(/near-optimal bisection bandwidth/i)).toBeVisible();

    // The visualize tool call produced a slide that actually rendered an SVG
    // (i.e. real mermaid.render() succeeded, not just "the API call happened").
    await expect(page.locator(".deck-slide svg").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "Expander graph topology" })).toBeVisible();

    // The research tool call landed in the research feed.
    const researchFeed = page.getByTestId("harness-research-feed");
    await expect(researchFeed.getByText("prior work on expander graphs")).toBeVisible();
    await expect(researchFeed.getByText(/spectral graph theory/i)).toBeVisible();
  });

  test("a malformed visualize response surfaces as a visible error, not a silent gap", async ({
    page,
  }) => {
    await seedPdfState(page);

    await page.route("**/api/agent-turn", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          answer: "Let me show that.",
          toolCalls: [{ name: "visualize", args: { topic: "Broken slide" } }],
        }),
      });
    });
    await page.route("**/api/illustrate", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: "Failed to generate a valid visual after 2 attempts",
        }),
      });
    });

    await page.getByTestId("harness-question-input").fill("Show me something.");
    await page.getByTestId("harness-ask-button").click();

    await expect(page.getByText(/VISUAL FAILED/i)).toBeVisible({ timeout: 10_000 });
  });
});
