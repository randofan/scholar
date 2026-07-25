import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { extractPdfText } from "@/lib/scholar/pdf";
import { dispatchSpeculativeVisual } from "@/lib/scholar/agent-tools";
import { useScholarStore } from "@/lib/scholar/store";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";

export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [
      { title: "Multimodal Scholar — drop a PDF to start learning" },
      {
        name: "description",
        content:
          "Drop a PDF and have a voice conversation with an AI scholar that visualizes and researches in real time.",
      },
    ],
  }),
});

function Index() {
  const navigate = useNavigate();
  const setPdf = useScholarStore((s) => s.setPdf);
  const resetStore = useScholarStore((s) => s.reset);

  const [parsing, setParsing] = useState(false);
  const [progress, setProgress] = useState<string>("");
  const [dragging, setDragging] = useState(false);

  const handleFile = async (file: File) => {
    if (file.type !== "application/pdf") {
      toast.error("Please upload a PDF");
      return;
    }
    setParsing(true);
    try {
      // Clear any prior session state (transcript, canvas, research, prior PDF)
      // so a freshly uploaded PDF starts with no leftover context.
      resetStore();
      const { text, pages } = await extractPdfText(file, (p, t) =>
        setProgress(`Parsing page ${p}/${t}…`),
      );
      setPdf({ name: file.name, text, pages, charCount: text.length });
      // Warm the on-device model in the background while the user reads the
      // /session screen and connects the voice agent, so the first slide
      // doesn't pay session-creation + system-prompt processing cost.
      dispatchSpeculativeVisual(file.name);
      navigate({ to: "/session" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to parse PDF");
    } finally {
      setParsing(false);
      setProgress("");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <Toaster theme="dark" richColors />
      <div className="w-full max-w-2xl">
        <label
          htmlFor="pdf"
          onDragOver={(e) => {
            e.preventDefault();
            if (!parsing) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files?.[0];
            if (f) void handleFile(f);
          }}
          className={`group flex cursor-pointer flex-col items-center justify-center gap-5 rounded-2xl border-2 border-dashed bg-card p-16 text-center transition-all ${
            dragging
              ? "border-primary bg-primary/5 scale-[1.01]"
              : "border-border hover:border-primary/60 hover:bg-card/80"
          } ${parsing ? "pointer-events-none opacity-70" : ""} ring-glow`}
        >
          {parsing ? (
            <>
              <Loader2 className="h-10 w-10 animate-spin text-primary" />
              <p className="text-base">{progress || "Parsing PDF…"}</p>
            </>
          ) : (
            <>
              <Upload className="h-10 w-10 text-primary" />
              <div className="space-y-1.5">
                <p className="text-xl font-semibold tracking-tight">Drop a PDF to start learning</p>
                <p className="text-sm text-muted-foreground">
                  Drag &amp; drop your paper here, or click anywhere in this box
                </p>
              </div>
            </>
          )}
          <input
            id="pdf"
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
    </div>
  );
}
