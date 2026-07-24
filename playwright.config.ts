import { defineConfig, devices } from "@playwright/test";

// Dev-server-only harness routes (dev-mermaid-harness, dev-harness) are
// gated to import.meta.env.DEV and don't exist in a production build, so
// these E2E suites run against `vite dev`, not `vite preview`. The shared
// @lovable.dev/vite-tanstack-config plugin forces server.host="::" (IPv6
// any-interface), which some sandboxes can't bind — CLI flags override that,
// which is why the command below passes --host/--port explicitly rather than
// relying on vite.config.ts.
const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 5183);
const HOST = process.env.PLAYWRIGHT_HOST ?? "127.0.0.1";

export default defineConfig({
  testDir: "./tests/e2e",
  // pdf-parsing.spec.ts overrides this via test.setTimeout() — real pdfjs-dist
  // parsing latency is highly variable in some sandboxed headless-Chromium
  // environments (see tests/e2e/helpers/upload-pdf.ts). Every other spec
  // seeds state directly instead of parsing a real file, so 60s is generous.
  timeout: 60_000,
  fullyParallel: true,
  // All specs share ONE `vite dev` instance (see webServer below). Running
  // workers in parallel means multiple browser contexts hit that single dev
  // server's cold on-demand module transform concurrently, which serializes
  // internally anyway and was observed to blow well past a 45s per-test
  // timeout. One worker avoids the contention; with ~20 total e2e tests here
  // the wall-clock cost of serial execution is small.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://${HOST}:${PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `bunx vite dev --host ${HOST} --port ${PORT} --strictPort`,
    url: `http://${HOST}:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
        },
      },
    },
  ],
});
