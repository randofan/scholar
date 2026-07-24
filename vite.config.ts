// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
// @cloudflare/vite-plugin builds from this — wrangler.jsonc main alone is insufficient.
export default defineConfig({
  tanstackStart: {
    server: { entry: "server" },
  },
  // tests/e2e/**/*.spec.ts are Playwright specs (run via `bunx playwright
  // test`), not Vitest — Vitest's default include glob matches *.spec.ts
  // too, so without this it tries to run them and fails on the incompatible
  // `test`/`describe` globals. Cast needed because the shared plugin's
  // `vite` option is typed as plain Vite `UserConfig`, which doesn't know
  // about Vitest's `test` field (Vite still merges it in at runtime).
  vite: {
    test: {
      exclude: ["**/node_modules/**", "**/dist/**", "tests/e2e/**"],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any,
});
