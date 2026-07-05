import "@tanstack/react-start";
import { createFileRoute } from "@tanstack/react-router";
import { generateVisual } from "@/lib/scholar/illustrate.server";

const corsHeaders = { "Content-Type": "application/json" };

interface ReqBody {
  topic?: string;
  hint?: string;
  pdfExcerpt?: string;
  recentVisuals?: Array<{ title: string; kind: string }>;
  /** Browser-side mermaid.render() failure from a prior generation of this request. */
  renderFailure?: { source?: string; error?: string };
  /** Session-scoped failure lessons harvested by the client. */
  lessons?: string[];
}

export const Route = createFileRoute("/api/illustrate")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const body = (await request.json()) as ReqBody;
        const topic = body.topic?.trim();
        if (!topic) {
          return new Response(JSON.stringify({ error: "topic required" }), {
            status: 400,
            headers: corsHeaders,
          });
        }
        const allowedKinds = new Set(["chart", "math", "diagram", "table", "callout"]);
        const recentVisuals = (body.recentVisuals ?? [])
          .filter((r) => r && typeof r.title === "string" && allowedKinds.has(r.kind))
          .slice(0, 6) as Array<{ title: string; kind: "chart" | "math" | "diagram" | "table" | "callout" }>;

        const renderFailure =
          body.renderFailure &&
          typeof body.renderFailure.source === "string" &&
          typeof body.renderFailure.error === "string"
            ? {
                source: body.renderFailure.source.slice(0, 4000),
                error: body.renderFailure.error.slice(0, 500),
              }
            : undefined;
        const lessons = (body.lessons ?? [])
          .filter((l): l is string => typeof l === "string" && l.trim().length > 0)
          .slice(0, 8)
          .map((l) => l.slice(0, 200));

        try {
          const result = await generateVisual({
            topic,
            hint: body.hint,
            pdfExcerpt: body.pdfExcerpt,
            recentVisuals,
            renderFailure,
            lessons,
          });
          if (result.warnings.length > 0) {
            console.warn("illustrate retries", result.warnings);
          }
          // warnings are returned so the client can harvest them as session
          // lessons (each one is a specific validator rejection the model
          // already had to correct once).
          return new Response(
            JSON.stringify({
              ok: true,
              visual: result.visual,
              attempts: result.attempts,
              warnings: result.warnings,
            }),
            { status: 200, headers: corsHeaders },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : "unknown error";
          console.error("illustrate error", msg);
          return new Response(JSON.stringify({ ok: false, error: msg }), {
            status: 500,
            headers: corsHeaders,
          });
        }
      },
    },
  },
});
