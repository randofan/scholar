import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { renderMermaidToSvg, type MermaidRenderResult } from "@/lib/mermaid/render";

declare global {
  interface Window {
    __renderMermaidForTest?: (source: string) => Promise<MermaidRenderResult>;
  }
}

// Dev-only: exposes the REAL mermaid render path (the same one MermaidView
// uses in production) as a global hook so Playwright can drive it directly
// against the mermaid corpus (evals/mermaid-corpus/corpus.json) — see
// tests/e2e/mermaid-corpus.spec.ts. Never linked from production UI.
export const Route = createFileRoute("/dev-mermaid-harness")({
  component: import.meta.env.DEV ? DevMermaidHarnessPage : ProductionGuard,
});

function ProductionGuard() {
  const navigate = useNavigate();
  useMemo(() => navigate({ to: "/" }), [navigate]);
  return null;
}

function DevMermaidHarnessPage() {
  useEffect(() => {
    window.__renderMermaidForTest = renderMermaidToSvg;
    return () => {
      delete window.__renderMermaidForTest;
    };
  }, []);

  return <div data-testid="mermaid-harness-ready">mermaid render harness ready</div>;
}
