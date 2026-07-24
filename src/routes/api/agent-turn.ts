import "@tanstack/react-start";
import { createFileRoute } from "@tanstack/react-router";
import { decideAgentTurn } from "@/lib/scholar/text-agent.server";

const corsHeaders = { "Content-Type": "application/json" };

interface ReqBody {
  question?: string;
  pdfExcerpt?: string;
  recentVisuals?: Array<{ title: string; kind: string }>;
}

// Dev-only: powers the text harness (src/routes/dev-harness.tsx), never
// linked from production UI. Decides which tools the agent would call for a
// typed question, without a live voice session.
export const Route = createFileRoute("/api/agent-turn")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const body = (await request.json()) as ReqBody;
        const question = body.question?.trim();
        if (!question) {
          return new Response(JSON.stringify({ error: "question required" }), {
            status: 400,
            headers: corsHeaders,
          });
        }
        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) {
          return new Response(JSON.stringify({ error: "GROQ_API_KEY missing" }), {
            status: 500,
            headers: corsHeaders,
          });
        }

        try {
          const result = await decideAgentTurn(
            { question, pdfExcerpt: body.pdfExcerpt ?? "", recentVisuals: body.recentVisuals },
            { apiKey },
          );
          return new Response(JSON.stringify({ ok: true, ...result }), {
            status: 200,
            headers: corsHeaders,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "unknown error";
          console.error("agent-turn error", msg);
          return new Response(JSON.stringify({ ok: false, error: msg }), {
            status: 500,
            headers: corsHeaders,
          });
        }
      },
    },
  },
});
