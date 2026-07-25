import type { Page } from "@playwright/test";

/**
 * Install a fake Chrome Prompt API on the page before any app code runs.
 *
 * Visualize generates on-device now, so there is no HTTP boundary left to
 * intercept with page.route(). Defining `globalThis.LanguageModel` is the
 * equivalent seam: the app's real code path (session creation, per-kind
 * prompts, schema decode, content validation, retry loop, and genuine
 * mermaid.render()) all still executes — only the model itself is canned.
 *
 * Headless Chromium has no real Gemini Nano, so without this every slide
 * would fail with "unavailable" and these tests would only prove the error
 * path works.
 */
export async function installFakeLanguageModel(
  page: Page,
  opts: {
    /** JSON strings returned in order; the last one repeats. */
    responses: string[];
    availability?: "available" | "downloadable" | "downloading" | "unavailable";
  },
) {
  await page.addInitScript(
    ({ responses, availability }) => {
      let i = 0;
      const shift = () => {
        const r = responses[Math.min(i, responses.length - 1)];
        i += 1;
        return r;
      };
      (globalThis as Record<string, unknown>).LanguageModel = {
        availability: async () => availability,
        create: async () => ({
          // Teaser calls share this session shape; returning JSON for a teaser
          // is harmless because the caller only ever renders it as a string.
          prompt: async () => shift(),
        }),
      };
    },
    { responses: opts.responses, availability: opts.availability ?? "available" },
  );
}
