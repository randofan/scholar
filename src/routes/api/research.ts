import "@tanstack/react-start";
import { createFileRoute } from "@tanstack/react-router";
import { generateResearch } from "@/lib/scholar/research.server";

const corsHeaders = { "Content-Type": "application/json" };

interface ReqBody {
  query?: string;
  pdfExcerpt?: string;
  scope?: "web" | "citations" | "both";
}

export const Route = createFileRoute("/api/research")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const body = (await request.json()) as ReqBody;
        const query = body.query?.trim();
        if (!query) {
          return new Response(JSON.stringify({ error: "query required" }), {
            status: 400,
            headers: corsHeaders,
          });
        }
        try {
          const { result, attempts, warnings, toolCalls } = await generateResearch({
            query,
            pdfExcerpt: body.pdfExcerpt,
          });

          if (warnings.length > 0) {
            console.warn("research retries", warnings);
          }
          console.log(
            `research ok: attempts=${attempts} toolCalls=${toolCalls} summaryChars=${result.summary.length} keyPoints=${result.keyPoints.length}`,
          );

          return new Response(
            JSON.stringify({ ok: true, ...result, attempts, toolCalls }),
            { status: 200, headers: corsHeaders },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : "unknown error";
          console.error("research error", msg);
          // Surface failures honestly as a 500. The voice agent's research
          // tool catches this, reports "research unavailable" to the user,
          // and continues without web grounding.
          return new Response(JSON.stringify({ ok: false, error: msg }), {
            status: 500,
            headers: corsHeaders,
          });
        }
      },
    },
  },
});
