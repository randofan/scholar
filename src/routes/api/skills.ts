import "@tanstack/react-start";
import { createFileRoute } from "@tanstack/react-router";
import { distillLessonsIntoSkill, loadSkillRules } from "@/lib/scholar/skills.server";
import type { StrictKind } from "@/lib/scholar/illustrate-shared";
import { getCfBindings } from "@/lib/cf-bindings";

const corsHeaders = { "Content-Type": "application/json" };

const KINDS: StrictKind[] = ["diagram", "chart", "table", "math"];
const isKind = (v: unknown): v is StrictKind => KINDS.includes(v as StrictKind);

/** Lessons are POSTed grouped by the kind that produced them — skill files are per-kind. */
interface DistillBody {
  lessonsByKind?: Partial<Record<StrictKind, string[]>>;
}

function cleanLessons(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((l): l is string => typeof l === "string" && l.trim().length > 0)
    .slice(0, 16)
    .map((l) => l.slice(0, 300));
}

export const Route = createFileRoute("/api/skills")({
  server: {
    handlers: {
      /** Inspect the current skill files, one per kind (debugging aid). */
      GET: async () => {
        const { SKILLS } = getCfBindings();
        if (!SKILLS) {
          return new Response(
            JSON.stringify({ ok: false, error: "R2 skills bucket not configured" }),
            { status: 503, headers: corsHeaders },
          );
        }
        const entries = await Promise.all(
          KINDS.map(async (kind) => [kind, await loadSkillRules(SKILLS, kind)] as const),
        );
        return new Response(
          JSON.stringify({ ok: true, rulesByKind: Object.fromEntries(entries) }),
          {
            status: 200,
            headers: corsHeaders,
          },
        );
      },

      /**
       * Distill a session's failure lessons into the per-kind skill files.
       * Called by the client when a voice session ends. Uses Workers AI to
       * merge/generalize; deterministic merge fallback keeps lessons from
       * being lost when the AI binding is unavailable.
       */
      POST: async ({ request }: { request: Request }) => {
        const body = (await request.json().catch(() => ({}))) as DistillBody;
        const grouped = Object.entries(body.lessonsByKind ?? {})
          .filter(([kind]) => isKind(kind))
          .map(([kind, raw]) => [kind as StrictKind, cleanLessons(raw)] as const)
          .filter(([, lessons]) => lessons.length > 0);

        if (grouped.length === 0) {
          return new Response(JSON.stringify({ error: "lessonsByKind required" }), {
            status: 400,
            headers: corsHeaders,
          });
        }

        const { SKILLS, AI } = getCfBindings();
        if (!SKILLS) {
          return new Response(
            JSON.stringify({ ok: false, error: "R2 skills bucket not configured" }),
            { status: 503, headers: corsHeaders },
          );
        }

        try {
          const rulesByKind: Partial<Record<StrictKind, string[]>> = {};
          // Sequential, not parallel: each kind is a separate R2 read-modify-write
          // and a separate Workers AI call, so concurrency buys little and risks
          // rate-limiting the AI binding.
          for (const [kind, lessons] of grouped) {
            rulesByKind[kind] = await distillLessonsIntoSkill(SKILLS, AI, lessons, kind);
          }
          return new Response(JSON.stringify({ ok: true, rulesByKind }), {
            status: 200,
            headers: corsHeaders,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "unknown error";
          console.error("skills distill error", msg);
          return new Response(JSON.stringify({ ok: false, error: msg }), {
            status: 500,
            headers: corsHeaders,
          });
        }
      },
    },
  },
});
