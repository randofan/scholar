import "@tanstack/react-start";
import { createFileRoute } from "@tanstack/react-router";
import { generateVisualTeaser } from "@/lib/scholar/illustrate.server";

const corsHeaders = { "Content-Type": "application/json" };

interface ReqBody {
  topic?: string;
  hint?: string;
}

export const Route = createFileRoute("/api/illustrate-teaser")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const body = (await request.json()) as ReqBody;
        const topic = body.topic?.trim();
        if (!topic) {
          return new Response(JSON.stringify({ ok: false, error: "topic required" }), {
            status: 400,
            headers: corsHeaders,
          });
        }

        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) {
          // No teaser without Groq — the caller treats this as a soft miss,
          // never a reason to alarm the user; the real visual still arrives.
          return new Response(JSON.stringify({ ok: false, error: "GROQ_API_KEY not configured" }), {
            status: 200,
            headers: corsHeaders,
          });
        }

        try {
          const teaser = await generateVisualTeaser({ topic, hint: body.hint }, { apiKey });
          return new Response(JSON.stringify({ ok: true, teaser }), {
            status: 200,
            headers: corsHeaders,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "unknown error";
          return new Response(JSON.stringify({ ok: false, error: msg }), {
            status: 200,
            headers: corsHeaders,
          });
        }
      },
    },
  },
});
