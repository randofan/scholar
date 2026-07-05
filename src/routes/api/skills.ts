import "@tanstack/react-start";
import { createFileRoute } from "@tanstack/react-router";
import {
  distillLessonsIntoSkill,
  invalidateSkillCache,
  loadSkillRules,
} from "@/lib/scholar/skills.server";
import { getCfBindings } from "@/lib/cf-bindings";

const corsHeaders = { "Content-Type": "application/json" };

interface DistillBody {
  lessons?: string[];
}

export const Route = createFileRoute("/api/skills")({
  server: {
    handlers: {
      /** Inspect the current skill file (debugging aid). */
      GET: async () => {
        const { SKILLS } = getCfBindings();
        if (!SKILLS) {
          return new Response(
            JSON.stringify({ ok: false, error: "R2 skills bucket not configured" }),
            { status: 503, headers: corsHeaders },
          );
        }
        const rules = await loadSkillRules(SKILLS);
        return new Response(JSON.stringify({ ok: true, rules }), {
          status: 200,
          headers: corsHeaders,
        });
      },

      /**
       * Distill a session's failure lessons into the persistent skill file.
       * Called by the client when a voice session ends. Uses Workers AI to
       * merge/generalize; deterministic merge fallback keeps lessons from
       * being lost when the AI binding is unavailable.
       */
      POST: async ({ request }: { request: Request }) => {
        const body = (await request.json().catch(() => ({}))) as DistillBody;
        const lessons = (body.lessons ?? [])
          .filter((l): l is string => typeof l === "string" && l.trim().length > 0)
          .slice(0, 16)
          .map((l) => l.slice(0, 300));
        if (!lessons.length) {
          return new Response(JSON.stringify({ error: "lessons required" }), {
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
          const rules = await distillLessonsIntoSkill(SKILLS, AI, lessons);
          invalidateSkillCache();
          return new Response(JSON.stringify({ ok: true, rules }), {
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
