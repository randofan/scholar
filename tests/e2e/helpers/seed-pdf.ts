import type { Page } from "@playwright/test";

/**
 * Seed the Zustand store's `pdf` state directly via the dev-only
 * window.__scholarStore hook (see dev-harness.tsx), bypassing the real
 * upload + pdfjs-dist parse flow entirely.
 *
 * Tests whose subject is downstream UI wiring (does a tool-call decision
 * become a rendered slide?) don't need real PDF parsing to happen — and in
 * this sandbox, real parsing of a multi-page PDF under headless Chromium +
 * CDP has highly variable latency for reasons that traced back to the
 * environment, not the app (see helpers/upload-pdf.ts and PLAN.md Phase 4).
 * Seeding state directly makes those tests fast and deterministic; a
 * dedicated separate test (pdf-parsing.spec.ts) exercises the real upload
 * path so that's still covered, just decoupled from the wiring tests.
 */
export async function seedPdfState(
  page: Page,
  pdf: { name?: string; text?: string; pages?: number } = {},
) {
  const value = {
    name: pdf.name ?? "rng-paper.pdf",
    text:
      pdf.text ??
      "Expander graphs provide near-optimal bisection bandwidth with far fewer links than a fat tree. " +
        "Edge expansion h(G) measures the minimum ratio of the boundary of a vertex subset to its size.",
    pages: pdf.pages ?? 20,
  };
  await page.goto("/dev-harness");
  await page.waitForFunction(() => !!window.__scholarStore, { timeout: 15_000 });
  await page.evaluate((v) => {
    window.__scholarStore!.getState().setPdf({ ...v, charCount: v.text.length });
  }, value);
  // Wait for the harness to swap from the upload prompt to the tool-call form.
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="harness-topic-input"]'),
    { timeout: 5_000 },
  );
}
