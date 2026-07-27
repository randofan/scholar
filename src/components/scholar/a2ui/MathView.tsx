import "katex/dist/katex.min.css";
import { useMemo } from "react";
import katex from "katex";

interface Props {
  steps: string[];
  inline?: string;
}

function renderTeX(tex: string) {
  try {
    return katex.renderToString(tex, {
      displayMode: true,
      throwOnError: false,
    });
  } catch {
    return tex;
  }
}

export function MathView({ steps, inline }: Props) {
  const rendered = useMemo(() => steps.map(renderTeX), [steps]);
  return (
    <div className="space-y-3 text-foreground">
      {inline && <p className="text-sm text-muted-foreground italic">{inline}</p>}
      {rendered.map((html, i) => (
        <div
          key={i}
          className="rounded-md bg-muted/40 p-3 overflow-x-auto"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ))}
    </div>
  );
}
