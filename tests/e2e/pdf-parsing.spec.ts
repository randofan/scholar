import { test, expect } from "@playwright/test";
import { uploadPdfAndWaitForParse } from "./helpers/upload-pdf";

// Exercises the REAL upload + pdfjs-dist parse path (unlike product-loop.spec.ts,
// which seeds PDF state directly to stay fast/deterministic for UI-wiring
// checks — see its header comment). This is the one place that verifies
// actual client-side PDF text extraction works end-to-end in a browser.
//
// Kept in its own file/test so parsing-latency variance can't flake the fast
// wiring tests. Known issue: in the sandboxed dev environment this was
// authored in, parsing a real multi-page PDF under headless Chromium was
// observed to sometimes take minutes or not complete at all — reproducible
// even via a bare page.goto+setInputFiles with no assertions involved, and
// unrelated to which Playwright wait API was used (ruled out toBeVisible,
// waitForSelector, and waitForFunction; all showed the same pattern). The
// same upload reliably completed in ~5s when run as an isolated single test
// with no other Playwright activity beforehand, which points at some
// resource-contention/scheduling issue in that specific constrained sandbox
// rather than an app bug — pdfjs-dist parsing a 2MB PDF is not intrinsically
// slow. If this test is flaky in your environment, that's the known failure
// mode to investigate first; the retry-with-fresh-navigation in
// uploadPdfAndWaitForParse() is the existing mitigation, not a full fix.
test("uploading a real PDF extracts its text and unlocks the question input", async ({ page }) => {
  test.setTimeout(150_000);
  await uploadPdfAndWaitForParse(page);

  await expect(page.getByTestId("harness-question-input")).toBeVisible();
  // Real extracted text made it into the store (visible via the page count,
  // which the dev-harness doesn't currently render — check via the store hook).
  const pdfState = await page.evaluate(() => window.__scholarStore?.getState().pdf);
  expect(pdfState?.pages).toBeGreaterThan(1);
  expect(pdfState?.text.length).toBeGreaterThan(1000);
  expect(pdfState?.text.toLowerCase()).toContain("expand");
});
