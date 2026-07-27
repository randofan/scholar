import { useScholarStore } from "@/lib/scholar/store";
import { Loader2, Search } from "lucide-react";

export function ResearchFeed() {
  const items = useScholarStore((s) => s.researchItems);

  if (items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground p-8">
        <div className="rounded-full border border-border bg-card p-4">
          <Search className="h-5 w-5 text-accent" />
        </div>
        <p className="text-sm font-medium text-foreground">Background research</p>
        <p className="max-w-xs text-xs">
          When the agent looks something up — papers, definitions, related work — findings stream in
          here without interrupting the conversation.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 p-4">
      {items.map((it) => (
        <article key={it.id} className="slide-in-up rounded-lg border border-border bg-card p-3">
          <header className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wider text-accent">
            <Search className="h-3 w-3" />
            <span>Research</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">
              {new Date(it.createdAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </header>
          <p className="text-xs font-medium text-foreground line-clamp-2">{it.query}</p>
          {it.status === "pending" && (
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Searching…
            </div>
          )}
          {it.status === "error" && <p className="mt-2 text-xs text-destructive">{it.error}</p>}
          {it.status === "ready" && (
            <>
              {it.summary && (
                <p className="mt-2 text-xs text-muted-foreground leading-relaxed">{it.summary}</p>
              )}
            </>
          )}
        </article>
      ))}
    </div>
  );
}
