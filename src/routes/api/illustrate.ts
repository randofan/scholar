import "@tanstack/react-start";
import { createFileRoute } from "@tanstack/react-router";
import { generateVisual, pickStrictKind } from "@/lib/scholar/illustrate.server";
import { loadSkillRulesCached } from "@/lib/scholar/skills.server";
import { loadCachedVisual, storeCachedVisual } from "@/lib/scholar/visual-cache.server";
import { getCfBindings } from "@/lib/cf-bindings";

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
          .slice(0, 6) as Array<{
          title: string;
          kind: "chart" | "math" | "diagram" | "table" | "callout";
        }>;

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

        const skillsBucket = getCfBindings().SKILLS;

        // A render failure or fresh session lessons mean the caller is
        // correcting a prior bad generation — never serve a stale cached
        // visual in that case, always regenerate.
        if (!renderFailure && lessons.length === 0) {
          const kind = pickStrictKind({ topic, hint: body.hint });
          const cached = await loadCachedVisual(
            skillsBucket,
            topic,
            body.hint,
            body.pdfExcerpt,
            kind,
          );
          if (cached) {
            return new Response(
              JSON.stringify({ ok: true, visual: cached, attempts: 0, warnings: [], cached: true }),
              { status: 200, headers: corsHeaders },
            );
          }
        }

        // Persistent rules distilled from past sessions (empty if the R2
        // bucket isn't configured — the generator works fine without them).
        const skillRules = await loadSkillRulesCached(skillsBucket);

        try {
          const result = await generateVisual({
            topic,
            hint: body.hint,
            pdfExcerpt: body.pdfExcerpt,
            recentVisuals,
            renderFailure,
            lessons,
            skillRules,
          });
          if (result.warnings.length > 0) {
            console.warn("illustrate retries", result.warnings);
          }
          if (!renderFailure && lessons.length === 0) {
            const kind = pickStrictKind({ topic, hint: body.hint });
            // Fire-and-forget: a cache-store failure must never fail the
            // request that already produced a good visual.
            void storeCachedVisual(
              skillsBucket,
              topic,
              body.hint,
              body.pdfExcerpt,
              kind,
              result.visual,
            );
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
