import { themes, type ThemeType } from "./themes";

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
let currentTheme: ThemeType | null = null;

export async function getMermaid(theme: ThemeType) {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => m.default);
  }
  const mermaid = await mermaidPromise;
  if (currentTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "loose",
      ...themes[theme].mermaidConfig,
    });
    currentTheme = theme;
  }
  return mermaid;
}

export interface MermaidRenderResult {
  ok: boolean;
  svg?: string;
  error?: string;
}

let renderCounter = 0;

/**
 * Render mermaid source to SVG using the real mermaid.render() call — shared
 * by MermaidView (production) and the dev mermaid-corpus test harness, so the
 * corpus fidelity check exercises the exact same render path users hit,
 * rather than a reimplementation of it.
 */
export async function renderMermaidToSvg(
  source: string,
  theme: ThemeType = "linearLight",
): Promise<MermaidRenderResult> {
  try {
    const mermaid = await getMermaid(theme);
    const id = `mmd-render-${Date.now()}-${renderCounter++}`;
    const { svg } = await mermaid.render(id, source);
    return { ok: true, svg };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
