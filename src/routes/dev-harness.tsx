import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { extractPdfText } from "@/lib/scholar/pdf";
import { useScholarStore } from "@/lib/scholar/store";
import { buildClientTools, distillSessionLessons, type ToolHost } from "@/lib/scholar/agent-tools";
import { CanvasPane } from "@/components/scholar/CanvasPane";
import { ResearchFeed } from "@/components/scholar/ResearchFeed";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Loader2, Send, Upload } from "lucide-react";
import { toast } from "sonner";

// Dev-only "no-voice" harness: drives the exact same client tools
// (visualize/research) that the ElevenLabs agent calls, but from a typed
// question instead of a live voice session. A small Groq function-calling
// layer (text-agent.server.ts) stands in for the ElevenLabs LLM's tool-call
// decisions. This exists purely to make the product loop testable/iterable
// without burning ElevenLabs minutes or waiting on a live voice session —
// it is gated out of production builds.
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
  const [question, setQuestion] = useState("");
  const [thinking, setThinking] = useState(false);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const lineCounterRef = useRef(0);

  const pushLine = useCallback(
    (role: TranscriptLine["role"], text: string) =>
      setLines((prev) => [...prev, { id: `${Date.now()}-${lineCounterRef.current++}`, role, text }]),
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

  const ask = async () => {
    const q = question.trim();
    if (!q || !pdf) return;
    pushLine("user", q);
    setQuestion("");
    setThinking(true);
    try {
      const recentVisuals = useScholarStore
        .getState()
        .canvasItems.filter((c) => c.status === "ready" && !!c.payload)
        .slice(0, 6)
        .map((c) => ({ title: c.title, kind: c.payload!.kind }));

      const res = await fetch("/api/agent-turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, pdfExcerpt: pdf.text.slice(0, 30_000), recentVisuals }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        answer?: string;
        toolCalls?: Array<{ name: "visualize" | "research"; args: Record<string, unknown> }>;
        error?: string;
      };
      if (!json.ok) throw new Error(json.error ?? "agent turn failed");

      if (json.answer) pushLine("agent", json.answer);
      for (const call of json.toolCalls ?? []) {
        if (call.name === "visualize") {
          const result = tools.visualize({
            topic: String(call.args.topic ?? q),
            hint: call.args.hint ? String(call.args.hint) : undefined,
          });
          pushLine("tool", `→ visualize(${JSON.stringify(call.args)}): ${result}`);
        } else if (call.name === "research") {
          const scope = call.args.scope;
          const result = tools.research({
            query: String(call.args.query ?? q),
            scope: scope === "web" || scope === "citations" || scope === "both" ? scope : undefined,
          });
          pushLine("tool", `→ research(${JSON.stringify(call.args)}): ${result}`);
        }
      }
    } catch (err) {
      pushLine("tool", `error: ${err instanceof Error ? err.message : "failed"}`);
    } finally {
      setThinking(false);
    }
  };

  return (
    <div className="flex h-screen flex-col">
      <Toaster theme="dark" richColors />
      <header className="border-b border-border bg-card/60 px-4 py-2.5">
        <p className="text-sm font-semibold">Dev harness — no-voice product loop</p>
        <p className="text-[11px] text-muted-foreground">
          Text stand-in for the ElevenLabs agent. Dev builds only.
        </p>
      </header>

      {!pdf ? (
        <div className="flex flex-1 items-center justify-center">
          <label
            htmlFor="dev-pdf"
            className={`flex cursor-pointer flex-col items-center gap-3 rounded-xl border-2 border-dashed border-border p-12 ${parsing ? "pointer-events-none opacity-70" : ""}`}
          >
            {parsing ? <Loader2 className="h-8 w-8 animate-spin" /> : <Upload className="h-8 w-8" />}
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
            <div className="border-t border-border p-3 flex gap-2">
              <input
                data-testid="harness-question-input"
                className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                placeholder="Ask a question about the paper…"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void ask();
                }}
                disabled={thinking}
              />
              <Button
                size="sm"
                data-testid="harness-ask-button"
                onClick={() => void ask()}
                disabled={thinking || !question.trim()}
              >
                {thinking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              </Button>
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
