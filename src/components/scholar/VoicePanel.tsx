import { useEffect, useMemo, useRef, useState } from "react";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useServerFn } from "@tanstack/react-start";
import { useScholarStore } from "@/lib/scholar/store";
import { buildClientTools, distillSessionLessons } from "@/lib/scholar/agent-tools";
import {
  buildScholarContextUpdate,
  buildScholarVoiceSessionOptions,
} from "@/lib/scholar/voice-session";
import { startScholarVoiceSession } from "@/lib/elevenlabs.functions";
import { Button } from "@/components/ui/button";
import { Mic, MicOff, Loader2, PhoneOff, Phone } from "lucide-react";
import { toast } from "sonner";

export function VoicePanel() {
  return (
    <ConversationProvider>
      <VoicePanelContent />
    </ConversationProvider>
  );
}

function VoicePanelContent() {
  const pdf = useScholarStore((s) => s.pdf);
  const appendTranscript = useScholarStore((s) => s.appendTranscript);

  const transcript = useScholarStore((s) => s.transcript);
  const [startRequested, setStartRequested] = useState(false);

  const conversationRef = useRef<ReturnType<typeof useConversation> | null>(null);
  const sentPdfContextRef = useRef<string | null>(null);
  const preemptiveResearchRef = useRef<string | null>(null);
  const contextualUpdateQueueRef = useRef<string[]>([]);

  const flushContextualUpdates = () => {
    const liveConversation = conversationRef.current;
    if (liveConversation?.status !== "connected") return;
    const queued = contextualUpdateQueueRef.current.splice(0);
    for (const text of queued) liveConversation.sendContextualUpdate(text);
  };

  const clientTools = useMemo(
    () =>
      buildClientTools({
        sendContextualUpdate: (text) => {
          conversationRef.current?.sendContextualUpdate(text);
        },
        canSendContextualUpdate: () => conversationRef.current?.status === "connected",
        queueContextualUpdate: (text) => {
          contextualUpdateQueueRef.current.push(text);
        },
      }),
    [],
  );

  // Pre-emptively dispatch background research on the paper so factual context
  // is ready (or streaming in) by the time the agent needs to ground a response.
  const dispatchPreemptiveResearch = (pdfName: string, pdfText: string) => {
    if (preemptiveResearchRef.current === pdfName) return;
    preemptiveResearchRef.current = pdfName;
    const titleGuess = pdfName
      .replace(/\.pdf$/i, "")
      .replace(/[_-]+/g, " ")
      .trim();
    const excerpt = pdfText.slice(0, 1500).replace(/\s+/g, " ").trim();
    const queries = [
      `Background and prior work related to: ${titleGuess}. Context excerpt: ${excerpt.slice(0, 400)}`,
      `Key concepts, definitions, and competing approaches discussed in "${titleGuess}"`,
    ];
    for (const q of queries) {
      try {
        clientTools.research({ query: q, scope: "both" });
      } catch (err) {
        console.warn("preemptive research dispatch failed", err);
      }
    }
  };

  const conversation = useConversation({
    clientTools,
    onConnect: () => {
      setStartRequested(false);
      flushContextualUpdates();
      toast.success("Connected to Scholar");
    },
    onDisconnect: (details) => {
      setStartRequested(false);
      // Session over — fold this session's failure lessons into the
      // persistent skill file (idempotent, fire-and-forget).
      void distillSessionLessons();
      if (details?.reason === "error") {
        console.error("convo disconnected", details);
        toast.error(details.message || "Voice agent disconnected");
        return;
      }
      toast.message("Conversation ended");
    },
    onError: (message, error) => {
      setStartRequested(false);
      console.error("convo error", message, error);
      toast.error(typeof message === "string" ? message : "Voice agent error");
    },
    onUnhandledClientToolCall: (toolCall) => {
      console.error("unhandled ElevenLabs client tool", toolCall);
      toast.error(`Unhandled client tool: ${toolCall.tool_name}`);
    },
    onMessage: (m: {
      type?: string;
      source?: string;
      message?: string;
      user_transcription_event?: { user_transcript?: string };
      agent_response_event?: { agent_response?: string };
      agent_response_correction_event?: { corrected_agent_response?: string };
    }) => {
      const userText = m.user_transcription_event?.user_transcript;
      const agentText =
        m.agent_response_event?.agent_response ??
        m.agent_response_correction_event?.corrected_agent_response;
      const text = userText ?? agentText ?? m.message;
      if (text) {
        appendTranscript({
          id: `${Date.now()}-${Math.random()}`,
          role: userText || m.source === "user" ? "user" : "agent",
          text,
          ts: Date.now(),
        });
      }
    },
  });
  conversationRef.current = conversation;

  const status = conversation.status;
  const isSpeaking = conversation.isSpeaking;
  const connected = status === "connected";
  const connecting = status === "connecting" || startRequested;

  const startSession = useServerFn(startScholarVoiceSession);

  const start = () => {
    setStartRequested(true);
    void (async () => {
      try {
        if (!pdf) throw new Error("Upload a PDF before starting the voice agent");
        // Auto-provisions the Scholar agent on the workspace if it doesn't
        // exist yet, then returns a fresh signed URL.
        const { signedUrl } = await startSession({ data: undefined });
        await conversation.startSession({
          ...buildScholarVoiceSessionOptions(signedUrl, pdf),
          clientTools,
          onConversationCreated: (liveConversation) => {
            sentPdfContextRef.current = pdf.name;
            liveConversation.sendContextualUpdate(buildScholarContextUpdate(pdf), {
              contextId: `pdf:${pdf.name}`,
            });
            dispatchPreemptiveResearch(pdf.name, pdf.text);
          },
        });
        flushContextualUpdates();
      } catch (err) {
        setStartRequested(false);
        const msg = err instanceof Error ? err.message : "Failed to start";
        toast.error(msg);
      }
    })();
  };

  const stop = async () => {
    await conversation.endSession();
    void distillSessionLessons();
  };

  useEffect(() => {
    if (!connected || !pdf) return;
    if (sentPdfContextRef.current === pdf.name) return;
    sentPdfContextRef.current = pdf.name;
    conversation.sendContextualUpdate(buildScholarContextUpdate(pdf), {
      contextId: `pdf:${pdf.name}`,
    });
    dispatchPreemptiveResearch(pdf.name, pdf.text);
  }, [connected, conversation, pdf]);

  useEffect(() => () => { try { void conversation.endSession(); } catch { /* noop */ } }, []); // eslint-disable-line

  return (
    <div className="flex h-full flex-col">
      {/* Status card */}
      <div className="border-b border-border bg-card/60 p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
              {connected ? (
                <>
                  <span className="pulse-dot inline-block h-2 w-2 rounded-full bg-primary" />
                  Live
                </>
              ) : (
                <>
                  <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground/40" />
                  Idle
                </>
              )}
            </div>
            <p className="mt-1 text-sm font-semibold">
              {connected ? (isSpeaking ? "Scholar is speaking" : "Listening…") : "Voice agent"}
            </p>
          </div>

          {connected ? (
            <Button size="sm" variant="destructive" onClick={stop}>
              <PhoneOff className="mr-1.5 h-3.5 w-3.5" /> End
            </Button>
          ) : (
            <Button size="sm" onClick={start} disabled={connecting || !pdf} className="ring-glow">
              {connecting ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Phone className="mr-1.5 h-3.5 w-3.5" />
              )}
              {connecting ? "Connecting" : "Start"}
            </Button>
          )}
        </div>

        {connected && (
          <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            {isSpeaking ? <Mic className="h-3 w-3 text-primary" /> : <MicOff className="h-3 w-3" />}
            <span>{isSpeaking ? "Agent voice active" : "Mic open — speak naturally"}</span>
          </div>
        )}
      </div>

      {/* Transcript */}
      <div className="scroll-fade-mask flex-1 overflow-y-auto p-4">
        {transcript.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Transcript will appear here as the conversation progresses.
          </p>
        ) : (
          <ul className="space-y-3">
            {transcript.map((t) => (
              <li key={t.id} className="text-xs">
                <div className="mb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  {t.role === "user" ? "You" : "Scholar"}
                </div>
                <p
                  className={
                    t.role === "user"
                      ? "rounded-md bg-muted/40 p-2 text-foreground"
                      : "rounded-md bg-primary/10 p-2 text-foreground"
                  }
                >
                  {t.text}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
