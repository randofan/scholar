# Voice smoke test

A manual checklist for exercising the real product loop end to end — a live
ElevenLabs voice call, a real PDF, real Groq/Gemini/arXiv/Semantic Scholar
calls. Nothing here is automated: a live voice session needs a microphone,
speaker output, and a human who can judge whether the agent's spoken answer
actually made sense, none of which Playwright can do. Everything that *can*
be checked without a human in the loop already is — `bun run verify` (unit
tests + eval harness + the no-voice Playwright suite) — so treat this doc as
the last mile on top of that, not a replacement for it. Run it before any
release/deploy that touches `agent-tools.ts`, `illustrate.server.ts`,
`research.server.ts`, `citations.server.ts`, `scholar-agent-config.ts`, or
`VoicePanel.tsx`.

## Prerequisites

Env vars (Cloudflare Worker secrets in production, plain env vars for local
`vite dev`):

| Var | Required for | Notes |
|---|---|---|
| `ELEVENLABS_API_KEY_1` (or `ELEVENLABS_API_KEY`) | Starting a voice session at all | No fallback provider — required |
| `GROQ_API_KEY` | Fast-path `visualize` | Primary provider; omit to test the Workers AI/Gemini failover instead |
| `GEMINI_API_KEY` | `research`, and `visualize` failover | Required for any research call to succeed |

Workers AI (`env.AI`) and the R2 `SKILLS` bucket (visual cache, skill
distillation) are only present under `wrangler dev`/a real deployment, not
plain `vite dev` — see "Provider failover" and "Visual cache" below for what
that means for this checklist.

Start the app:
```
bun run dev          # vite dev — no Workers AI/R2, Groq+Gemini fallback still testable
# or, for full binding coverage:
wrangler dev          # needs wrangler.jsonc bindings provisioned (R2 bucket + AI)
```
Open the app, and have `tests/fixtures/rng-paper.pdf` (already in the repo)
or any real PDF ready to upload.

## Test script

Work through these in order; each depends on state from the previous ones
(a loaded paper, an open call).

### 1. Upload + connect
- Drop a PDF on the landing page. It should parse and land you on `/session`.
- Click to start the call. **Pass**: the agent greets you within a few
  seconds and can see the paper (ask "what paper is this?").
- **If this hangs**: check the browser console for a `startScholarVoiceSession`
  error — usually a missing/invalid ElevenLabs key.

### 2. Visualize — mandatory slide + two-phase teaser
- Ask any content question ("explain the core idea of this paper").
- **Pass**: within ~1s, the canvas shows a pending card with a short
  one-line preview under the title (the Phase 5d teaser) — not a bare
  spinner. Within a few more seconds it's replaced by the full rendered
  slide (diagram/chart/table/math). The agent never says anything like
  "let me generate a diagram" (that's the silent-tool-call rule).
- Ask 2-3 more follow-up questions. **Pass**: each gets a *different* kind
  of slide (no back-to-back repeats — the no-repeat-visuals rule).

### 3. Research — general background (`scope: "web"`-ish queries)
- Ask something explicitly outside the paper ("what's the history of this
  general technique?").
- **Pass**: the agent keeps talking immediately (fire-and-forget), then a
  beat later weaves in specific, confident facts — no "let me look that
  up" narration, no hedging like "the paper doesn't mention...".

### 4. Research — citation-following (`scope: "citations"`)
- Ask about one of the paper's own references directly: "what does one of
  the papers you cite say about \<topic in the paper's related-work
  section\>?" or "how does this compare to the prior work you're building
  on?"
- **Pass**: the briefing sounds grounded in a *specific* real paper (a
  concrete technique/result), not generic training-knowledge phrasing.
- **To verify it's really hitting live citation data** (not just a
  plausible-sounding Gemini guess): check the server logs for a line like
  `research ok: ... citationsResolved=1/2` with a nonzero numerator. If
  it's always `0/0`, either the paper's reference list didn't parse (see
  `references.ts`) or nothing in it matched the query closely enough
  (`rankReferencesByQuery`) — try a query that names a concept more clearly
  present in the bibliography.

### 5. Provider failover (optional — only if you want to test past Groq)
- Temporarily unset `GROQ_API_KEY` (or set it to an invalid value) and
  restart the dev server, then repeat step 2.
- **Pass**: visualize still works, just via Workers AI (if bound) or
  Gemini — check server logs for `"Groq strict mode unavailable, failing
  over to ..."` in the warnings.
- Restore `GROQ_API_KEY` afterward.

### 6. Visual cache / speculative pre-generation (only under `wrangler dev`)
- Plain `vite dev` has no R2 binding, so `visual-cache.server.ts` and
  `dispatchSpeculativeVisual` silently no-op (by design) — this step needs
  `wrangler dev` with the `SKILLS` bucket bound.
- Right after uploading the PDF (before even connecting the call), the
  overview slide for "\<paper title\> — architecture overview" is already
  being speculatively generated in the background (Phase 5c). Ask for
  exactly that early in the call.
- **Pass**: it appears unusually fast — check server logs for
  `cached: true` in the `/api/illustrate` response, meaning it served from
  the speculative pre-generation instead of a fresh model call.

### 7. Render-failure recovery (best-effort — hard to force on demand)
- Keep talking through the whole session and watch the canvas. If a slide
  ever flashes to an error state ("Diagram failed to render..."), that's
  `regenerateAfterRenderFailure` catching a real `mermaid.render()` failure
  that slipped past server-side validation.
- **Pass**: the error is visible and readable, never a silently blank
  slide. This is rare by design (Phase 2's corpus testing exists to catch
  most of these before they ship) — don't go out of your way to force it,
  just don't ignore it if it happens.

### 8. Hang up
- End the call normally.
- **Pass**: no error toast; check server logs for a `research`/`illustrate`
  error rate that looks reasonable for the session (some transient retries
  are fine, hard failures are not).

## What "done" looks like

All of steps 1-4 and 8 passing is the bar for a normal release. Steps 5-7
are deeper/optional checks — worth doing after a change to the relevant
subsystem (provider cascade, caching, or mermaid rendering respectively),
not every time.

## Known limitations

- Real client-side PDF parsing (`pdfjs-dist`) is exercised by
  `tests/e2e/pdf-parsing.spec.ts`, which is documented as flaky in
  constrained sandboxes (resource scheduling, not an app bug — see that
  file's header comment). If upload hangs in *this* checklist on a normal
  machine/browser, that's a real bug, not the known sandbox issue.
- This doc can't (and shouldn't try to) assert exact spoken wording — voice
  synthesis and the model's phrasing both vary run to run. Judge on
  substance (grounded, on-topic, no hedging, no tool-syntax leakage), not
  exact phrasing.
