import type { Page } from "@playwright/test";
import path from "node:path";

export const RNG_PAPER_PDF = path.join(import.meta.dirname, "../../fixtures/rng-paper.pdf");

/**
 * Upload a PDF on the dev harness and wait for parsing to finish (the
 * question input becomes available). Client-side PDF parsing (pdfjs-dist,
 * on a real multi-page paper) is real CPU-bound work, and in some sandboxed
 * headless-Chromium environments its wall-clock time is highly variable —
 * usually a few seconds, occasionally much longer for reasons that traced
 * back to the test environment's scheduling, not the app (confirmed: the
 * same upload reliably succeeds in isolation; see PLAN.md Phase 4 notes).
 * Retrying with a fresh navigation on timeout is the standard mitigation for
 * a known-flaky-latency operation, and keeps the test itself simple.
 */
export async function uploadPdfAndWaitForParse(
  page: Page,
  opts: { url?: string; attempts?: number; perAttemptTimeoutMs?: number } = {},
) {
  const url = opts.url ?? "/dev-harness";
  const attempts = opts.attempts ?? 3;
  const perAttemptTimeoutMs = opts.perAttemptTimeoutMs ?? 25_000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await page.goto(url);
    await page.setInputFiles('input[type="file"]', RNG_PAPER_PDF);
    try {
      await page.waitForFunction(
        () => !!document.querySelector('[data-testid="harness-question-input"]'),
        { timeout: perAttemptTimeoutMs },
      );
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `PDF upload did not finish parsing after ${attempts} attempts (${perAttemptTimeoutMs}ms each): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
