# Voice smoke test

A manual checklist for exercising the real product loop end to end — a live
ElevenLabs voice call, a real PDF, real on-device generation, and real
Gemini/arXiv/Semantic Scholar calls. Nothing here is automated: a live voice session needs a microphone,
speaker output, and a human who can judge whether the agent's spoken answer
actually made sense, none of which Playwright can do. Everything that *can*
be checked without a human in the loop already is — `bun run verify` (unit
tests + eval harness + the no-voice Playwright suite) — so treat this doc as
the last mile on top of that, not a replacement for it. Run it before any
release/deploy that touches `agent-tools.ts`, `on-device.ts`,
`illustrate-shared.ts`, `research.server.ts`, `citations.server.ts`,
`scholar-agent-config.ts`, or `VoicePanel.tsx`.

## Prerequisites

Env vars (Cloudflare Worker secrets in production, plain env vars for local
`vite dev`):

| Var | Required for | Notes |
|---|---|---|
| `ELEVENLABS_API_KEY_1` (or `ELEVENLABS_API_KEY`) | Starting a voice session at all | No fallback — required |
| `GEMINI_API_KEY` | `research` | Required for any research call to succeed |

`visualize` needs **no API key at all** — it runs on Chrome's built-in Gemini
Nano. It does need the browser to support it:

- Desktop Chrome (no mobile, no Safari, no Firefox)
- ~22GB free disk, >4GB VRAM
- The Prompt API enabled (`chrome://flags/#prompt-api-for-gemini-nano`) or an
  origin trial token
- The model actually downloaded — first use triggers a multi-GB download, and
  until it finishes every slide reports "still downloading"

Check readiness from the devtools console before starting:
```js
await LanguageModel.availability()   // want: "available"
```
`"downloadable"`/`"downloading"` means wait; `"unavailable"` means the flag
isn't on or the machine doesn't qualify. **There is no server fallback** — if
this says anything but `"available"`, every slide will fail by design.

Workers AI (`env.AI`) and the R2 `SKILLS` bucket (skill distillation) are only
present under `wrangler dev`/a real deployment, not plain `vite dev`.

Start the app:
```
bun run dev           # vite dev — visualize works, no Workers AI/R2 bindings
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

### 2. Visualize — mandatory slide, on-device
- Ask any content question ("explain the core idea of this paper").
- **Pass**: within ~1s the canvas shows a pending card with a one-line
  preview under the title (the on-device teaser) — not a bare spinner. It's
  replaced by the full rendered slide shortly after. The agent never says
  anything like "let me generate a diagram" (silent-tool-call rule).
- Ask 2-3 more follow-ups. **Pass**: each gets a *different* kind of slide.
- **This is where the on-device quality tradeoff shows up.** Watch for
  slides that are structurally valid but generic — a diagram of
  "Input → Process → Output" rather than the paper's actual components. That
  means the agent under-filled `facts`, not that the renderer is broken:
  the on-device model cannot see the PDF and can only draw what it was
  handed. If you see this repeatedly, the fix is in the agent prompt
  (`voice-session.ts` / `scholar-agent-config.ts`), not the renderer.

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

### 5. Retry loop under a weak model
- Keep asking for diagrams (the hardest format for a small model).
- **Pass**: slides land as valid rendered SVGs. Behind the scenes the
  validator may have rejected 1-4 attempts and re-prompted with the exact
  rule violated — that's the design working, and it's cheap because
  on-device retries cost nothing. Open the devtools console; rejected
  attempts are visible as session lessons accumulating in the store
  (`__scholarStore.getState().lessons`), each tagged with its kind.
- **Fail**: "on-device generation failed after 5 attempts". Occasional is
  expected; if it's most diagram requests, the per-kind mermaid prompt needs
  work (`illustrate-shared.ts`, `FORMAT_SKILL_BY_KIND.diagram`).

### 6. Skill distillation (only under `wrangler dev`)
- Plain `vite dev` has no R2/AI binding, so `/api/skills` no-ops by design.
- After a session with some rejected attempts, end the call and check
  `GET /api/skills`.
- **Pass**: `rulesByKind` has entries under the kinds you exercised, and the
  rules read as format-specific ("balance every bracket pair") rather than
  generic. Diagram rules must not appear under `table` — that partitioning
  is what keeps each on-device prompt inside its token budget.

### 7. Render-failure recovery (best-effort — hard to force on demand)
- Keep talking through the whole session and watch the canvas. If a slide
  ever flashes to an error state ("Diagram failed to render..."), that's
  `regenerateAfterRenderFailure` catching a real `mermaid.render()` failure
  that slipped past our structural validator. Regeneration re-prompts the
  on-device model with the renderer's own error text.
- **Pass**: the error is visible and readable, never a silently blank
  slide. This is rare by design (Phase 2's corpus testing exists to catch
  most of these before they ship) — don't go out of your way to force it,
  just don't ignore it if it happens.

### 8. Hang up
- End the call normally.
- **Pass**: no error toast. Slide failures are visible in the canvas rather
  than the server log now, since generation is client-side; research errors
  still show up server-side.

## What "done" looks like

All of steps 1-4 and 8 passing is the bar for a normal release. Steps 5-7
are deeper/optional checks — worth doing after a change to the retry loop,
the skill files, or mermaid rendering respectively.

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
