import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useScholarStore } from "@/lib/scholar/store";
import { VoicePanel } from "@/components/scholar/VoicePanel";
import { CanvasPane } from "@/components/scholar/CanvasPane";
import { ResearchFeed } from "@/components/scholar/ResearchFeed";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { ArrowLeft, FlaskConical } from "lucide-react";

export const Route = createFileRoute("/session")({
  component: SessionPage,
  ssr: false,
  head: () => ({
    meta: [{ title: "Session · Multimodal Scholar" }],
  }),
});

function SessionPage() {
  const pdf = useScholarStore((s) => s.pdf);
  const researchItems = useScholarStore((s) => s.researchItems);
  const navigate = useNavigate();
  const [researchOpen, setResearchOpen] = useState(false);

  const pendingCount = researchItems.filter((r) => r.status === "pending").length;
  const readyCount = researchItems.filter((r) => r.status === "ready").length;

  useEffect(() => {
    const t = setTimeout(() => {
      if (!useScholarStore.getState().pdf) navigate({ to: "/" });
    }, 50);
    return () => clearTimeout(t);
  }, [navigate]);

  if (!pdf)
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        Loading session…
      </div>
    );

  return (
    <div className="flex h-screen flex-col">
      <Toaster theme="dark" richColors />
      <header className="flex items-center justify-between border-b border-border bg-card/60 px-4 py-2.5 backdrop-blur">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            to="/"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Back"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{pdf.name}</p>
            <p className="text-[11px] text-muted-foreground">
              {pdf.pages} pages · {(pdf.charCount / 1000).toFixed(0)}k chars in context
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setResearchOpen(true)}
            className="gap-1.5"
          >
            <FlaskConical className="h-3.5 w-3.5" />
            <span className="text-xs">Research</span>
            {pendingCount > 0 ? (
              <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent/20 px-1 text-[10px] text-accent">
                {pendingCount}…
              </span>
            ) : readyCount > 0 ? (
              <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/20 px-1 text-[10px] text-primary">
                {readyCount}
              </span>
            ) : null}
          </Button>
          <h1 className="hidden md:block text-xs uppercase tracking-widest text-muted-foreground">
            Multimodal Scholar
          </h1>
        </div>
      </header>

      <div className="grid flex-1 min-h-0 grid-cols-1 lg:grid-cols-[320px_1fr]">
        <aside className="border-r border-border bg-card/30 min-h-0">
          <VoicePanel />
        </aside>
        <main className="overflow-y-auto bg-background min-h-0">
          <CanvasPane />
        </main>
      </div>

      <Sheet open={researchOpen} onOpenChange={setResearchOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto p-0">
          <SheetHeader className="border-b border-border p-4">
            <SheetTitle>Background research</SheetTitle>
            <SheetDescription className="text-xs">
              Debug view of what the research agent is fetching behind the scenes. These briefings
              are fed to the voice agent as factual grounding (not spoken verbatim).
            </SheetDescription>
          </SheetHeader>
          <ResearchFeed />
        </SheetContent>
      </Sheet>
    </div>
  );
}
