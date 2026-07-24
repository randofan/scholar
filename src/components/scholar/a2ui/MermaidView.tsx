import { useEffect, useRef } from "react";
import { themes, type ThemeType } from "@/lib/mermaid/themes";
import { renderMermaidToSvg } from "@/lib/mermaid/render";

interface Props {
  source: string;
  /** Theme from the modern_mermaid theme catalog. Defaults to "linearLight" (Canvas/classroom). */
  theme?: ThemeType;
  /** Called when mermaid.render() throws, so the host can surface a visible error instead of a silent blank slide. */
  onRenderError?: (message: string) => void;
}

export function MermaidView({ source, theme = "linearLight", onRenderError }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const themeCfg = themes[theme];
  // Held in a ref so a new callback identity from the parent never re-triggers
  // the render effect (which would re-fire onRenderError in a loop).
  const onRenderErrorRef = useRef(onRenderError);
  onRenderErrorRef.current = onRenderError;

  useEffect(() => {
    let cancelled = false;
    renderMermaidToSvg(source, theme).then((result) => {
      if (cancelled) return;
      if (result.ok && result.svg) {
        if (ref.current) ref.current.innerHTML = result.svg;
        return;
      }
      // Don't render mermaid's own giant red "Syntax error" blob into the
      // canvas — instead blank the diagram body and let the host (via
      // onRenderError) regenerate the slide or show a contained error state.
      if (ref.current) ref.current.innerHTML = "";
      if (typeof console !== "undefined") {
        console.warn("mermaid render failed", result.error);
      }
      onRenderErrorRef.current?.(result.error ?? "unknown render error");
    });
    return () => {
      cancelled = true;
    };
  }, [source, theme]);

  return (
    <div
      className={`flex justify-center overflow-x-auto rounded-lg p-6 ${themeCfg.bgClass}`}
      style={themeCfg.bgStyle}
    >
      <div ref={ref} className="w-full flex justify-center [&_svg]:max-w-full [&_svg]:h-auto" />
    </div>
  );
}
