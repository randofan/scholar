import { useScholarStore, type CanvasItem } from "@/lib/scholar/store";
import { regenerateAfterRenderFailure } from "@/lib/scholar/agent-tools";
import { ChartView } from "./a2ui/ChartView";
import { MathView } from "./a2ui/MathView";
import { MermaidView } from "./a2ui/MermaidView";
import { TableView } from "./a2ui/TableView";
import { Loader2, Presentation } from "lucide-react";

function SlideCard({
  item,
  slideNumber,
  totalSlides,
  children,
}: {
  item: CanvasItem;
  slideNumber: number;
  totalSlides: number;
  children: React.ReactNode;
}) {
  return (
    <article className="slide-in-up deck-slide">
      <header className="deck-slide-header flex items-start justify-between gap-3 px-5 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-primary">
            <Presentation className="h-3 w-3" />
            <span>Slide {slideNumber} of {totalSlides}</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground font-normal tracking-normal normal-case">
              {new Date(item.createdAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
          <h3 className="mt-1 text-base font-semibold text-foreground truncate leading-tight">
            {item.title}
          </h3>
          {item.narration && !(item.status === "ready" && item.payload?.kind === "callout") && (
            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{item.narration}</p>
          )}
        </div>
      </header>
      <div className="bg-card px-5 py-5">{children}</div>
    </article>
  );
}

export function CanvasPane() {
  const items = useScholarStore((s) => s.canvasItems);

  if (items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground p-8">
        <div className="deck-slide flex h-32 w-48 items-center justify-center">
          <Presentation className="h-6 w-6 text-primary" />
        </div>
        <p className="text-sm font-semibold text-foreground">Empty slide deck</p>
        <p className="max-w-xs text-xs">
          Charts, derivations, and diagrams will appear here as new slides as the agent illustrates
          concepts in real time.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5 p-5">
      {items.map((item, idx) => (
        <SlideCard key={item.id} item={item} slideNumber={idx + 1} totalSlides={items.length}>
          {item.status === "pending" && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Generating slide…
            </div>
          )}
          {item.status === "error" && (
            <p className="text-xs text-destructive">{item.error ?? "Failed."}</p>
          )}
          {item.status === "ready" && item.payload && (
            <>
              {item.payload.kind === "chart" && <ChartView spec={item.payload.spec} />}
              {item.payload.kind === "math" && (
                <MathView steps={item.payload.spec.steps} inline={item.payload.spec.inline} />
              )}
              {item.payload.kind === "diagram" && (
                <MermaidView
                  source={item.payload.spec.mermaid}
                  onRenderError={(message) => regenerateAfterRenderFailure(item.id, message)}
                />
              )}
              {item.payload.kind === "table" && <TableView spec={item.payload.spec} />}
              {item.payload.kind === "callout" && (
                <p className="rounded-md bg-muted/60 p-3 text-sm">{item.payload.spec.body}</p>
              )}
            </>
          )}
        </SlideCard>
      ))}
    </div>
  );
}
