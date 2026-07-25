import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { extractPdfText } from "@/lib/scholar/pdf";
import { useScholarStore } from "@/lib/scholar/store";
import { buildClientTools, distillSessionLessons, type ToolHost } from "@/lib/scholar/agent-tools";
import type { StrictKind } from "@/lib/scholar/illustrate-shared";
import { CanvasPane } from "@/components/scholar/CanvasPane";
import { ResearchFeed } from "@/components/scholar/ResearchFeed";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Loader2, Send, Upload } from "lucide-react";
import { toast } from "sonner";

// Dev-only "no-voice" harness: drives the exact same client tools
// (visualize/research) the ElevenLabs agent calls, but from a form instead of
// a live voice session.
//
// It dispatches tool calls DIRECTLY rather than asking a stand-in LLM to
// decide them, because that now mirrors production: the voice agent's whole
// job for `visualize` is to pick a `kind` and hand over `topic`/`hint`/`facts`
// — the on-device model does the rest. Typing those four fields exercises
// exactly the same path a real tool call takes, with no server LLM involved.
// Gated out of production builds.
export const Route = createFileRoute("/dev-harness")({
  component: import.meta.env.DEV ? DevHarnessPage : ProductionGuard,
  head: () => ({ meta: [{ title: "Dev harness · Multimodal Scholar" }] }),
});

function ProductionGuard() {
  const navigate = useNavigate();
  useMemo(() => navigate({ to: "/" }), [navigate]);
  return null;
}

declare global {
  interface Window {
    __scholarStore?: typeof useScholarStore;
  }
}

interface TranscriptLine {
  id: string;
  role: "user" | "agent" | "tool";
  text: string;
}

function DevHarnessPage() {
  const pdf = useScholarStore((s) => s.pdf);
  const setPdf = useScholarStore((s) => s.setPdf);
  const resetStore = useScholarStore((s) => s.reset);

  // Test-only hook: lets Playwright seed store state directly (e.g. `pdf`)
  // without going through the real upload+parse flow, for tests whose
  // subject is downstream UI wiring, not pdfjs-dist itself.
  useEffect(() => {
    window.__scholarStore = useScholarStore;
    return () => {
      delete window.__scholarStore;
    };
  }, []);

  const [parsing, setParsing] = useState(false);
  const [kind, setKind] = useState<StrictKind>("diagram");
  const [topic, setTopic] = useState("");
  const [hint, setHint] = useState("");
  const [facts, setFacts] = useState("");
  const [researchQuery, setResearchQuery] = useState("");
  const [thinking, setThinking] = useState(false);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const lineCounterRef = useRef(0);

  const pushLine = useCallback(
    (role: TranscriptLine["role"], text: string) =>
      setLines((prev) => [
        ...prev,
        { id: `${Date.now()}-${lineCounterRef.current++}`, role, text },
      ]),
    [],
  );

  const host: ToolHost = useMemo(
    () => ({
      sendContextualUpdate: (text) => pushLine("tool", text),
      canSendContextualUpdate: () => true,
    }),
    [pushLine],
  );
  const tools = useMemo(() => buildClientTools(host), [host]);

  const handleFile = async (file: File) => {
    if (file.type !== "application/pdf") {
      toast.error("Please upload a PDF");
      return;
    }
    setParsing(true);
    try {
      resetStore();
      setLines([]);
      const { text, pages } = await extractPdfText(file);
      setPdf({ name: file.name, text, pages, charCount: text.length });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to parse PDF");
    } finally {
      setParsing(false);
    }
  };

  const runVisualize = () => {
    const t = topic.trim();
    if (!t) return;
    pushLine("user", `visualize(kind=${kind}) ${t}`);
    setThinking(true);
    try {
      const result = tools.visualize({
        topic: t,
        kind,
        hint: hint.trim() || undefined,
        facts: facts.trim() || undefined,
      });
      pushLine("tool", `→ ${result}`);
    } catch (err) {
      pushLine("tool", `error: ${err instanceof Error ? err.message : "failed"}`);
    } finally {
      setThinking(false);
    }
  };

  const runResearch = () => {
    const q = researchQuery.trim();
    if (!q) return;
    pushLine("user", `research ${q}`);
    setResearchQuery("");
    try {
      const result = tools.research({ query: q, scope: "both" });
      pushLine("tool", `→ ${result}`);
    } catch (err) {
      pushLine("tool", `error: ${err instanceof Error ? err.message : "failed"}`);
    }
  };

  return (
    <div className="flex h-screen flex-col">
      <Toaster theme="dark" richColors />
      <header className="border-b border-border bg-card/60 px-4 py-2.5">
        <p className="text-sm font-semibold">Dev harness — no-voice product loop</p>
        <p className="text-[11px] text-muted-foreground">
          Direct tool-call form — same path the voice agent takes. Dev builds only.
        </p>
      </header>

      {!pdf ? (
        <div className="flex flex-1 items-center justify-center">
          <label
            htmlFor="dev-pdf"
            className={`flex cursor-pointer flex-col items-center gap-3 rounded-xl border-2 border-dashed border-border p-12 ${parsing ? "pointer-events-none opacity-70" : ""}`}
          >
            {parsing ? (
              <Loader2 className="h-8 w-8 animate-spin" />
            ) : (
              <Upload className="h-8 w-8" />
            )}
            <span className="text-sm">{parsing ? "Parsing…" : "Upload a PDF to begin"}</span>
            <input
              id="dev-pdf"
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
              }}
            />
          </label>
        </div>
      ) : (
        <div className="grid flex-1 min-h-0 grid-cols-1 lg:grid-cols-[360px_1fr_320px]">
          <aside className="flex min-h-0 flex-col border-r border-border">
            <div className="flex-1 overflow-y-auto p-3 space-y-2" data-testid="harness-transcript">
              {lines.map((l) => (
                <p
                  key={l.id}
                  data-role={l.role}
                  className={`text-xs rounded p-2 ${
                    l.role === "user"
                      ? "bg-muted/40"
                      : l.role === "agent"
                        ? "bg-primary/10"
                        : "bg-accent/10 text-muted-foreground"
                  }`}
                >
                  <span className="font-semibold uppercase text-[10px] mr-1">{l.role}</span>
                  {l.text}
                </p>
              ))}
            </div>
            <div className="border-t border-border p-3 space-y-2">
              <div className="flex gap-2">
                <select
                  data-testid="harness-kind-select"
                  className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as StrictKind)}
                >
                  <option value="diagram">diagram</option>
                  <option value="chart">chart</option>
                  <option value="table">table</option>
                  <option value="math">math</option>
                </select>
                <input
                  data-testid="harness-topic-input"
                  className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                  placeholder="topic"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                />
              </div>
              <input
                data-testid="harness-hint-input"
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                placeholder="hint — the structure to draw"
                value={hint}
                onChange={(e) => setHint(e.target.value)}
              />
              <textarea
                data-testid="harness-facts-input"
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                rows={3}
                placeholder="facts — paper content the model should use (it cannot see the PDF)"
                value={facts}
                onChange={(e) => setFacts(e.target.value)}
              />
              <Button
                size="sm"
                className="w-full"
                data-testid="harness-visualize-button"
                onClick={runVisualize}
                disabled={thinking || !topic.trim()}
              >
                {thinking ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
                <span className="ml-1.5">visualize</span>
              </Button>
              <div className="flex gap-2 pt-1">
                <input
                  data-testid="harness-research-input"
                  className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                  placeholder="research query"
                  value={researchQuery}
                  onChange={(e) => setResearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") runResearch();
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="harness-research-button"
                  onClick={runResearch}
                  disabled={!researchQuery.trim()}
                >
                  research
                </Button>
              </div>
            </div>
            <div className="border-t border-border p-2">
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                onClick={() => void distillSessionLessons()}
              >
                Distill session lessons now
              </Button>
            </div>
          </aside>
          <main className="overflow-y-auto min-h-0">
            <CanvasPane />
          </main>
          <aside
            className="overflow-y-auto border-l border-border min-h-0"
            data-testid="harness-research-feed"
          >
            <ResearchFeed />
          </aside>
        </div>
      )}
    </div>
  );
}
