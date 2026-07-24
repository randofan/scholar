# Scholar — Path to Completion

The product loop we're building toward:

1. User uploads a research-paper PDF.
2. Agent opens with a short call to action.
3. User asks questions about the paper by voice.
4. Every response = realtime voice answer + a new slide with a visual aid.
5. When sensible, the agent dispatches background research — including finding
   and reading papers the uploaded paper references.
6. Repeat per question.

Constraints that shape everything below: **free tiers only** (Groq, Gemini,
ElevenLabs, Cloudflare), severe rate limits, high visualize latency, and a
development process that must be drivable by a coding agent without a human
manually voice-testing every change.

---

## Part 1 — Close the dev/test loop (highest priority)

The core problem: the only way to exercise the product today is a live voice
session, which is slow, burns ElevenLabs minutes, and hits rate limits. The fix
is to make the voice channel a *thin, separately-tested shell* and drive
everything else through automated layers.

### 1.1 Text harness mode (the keystone)

The ElevenLabs session is already just a transport around `buildClientTools`
(`visualize`, `research`) plus contextual updates. Add a dev-only text mode:

- A `?harness=text` flag (or dev route) on the session page renders a text input
  instead of requiring a voice session. Submitting text calls the same
  `buildClientTools` handlers directly with a stub `ToolHost` that logs
  contextual updates to a visible panel.
- Zero ElevenLabs usage. Exercises PDF upload → tool dispatch → slide render →
  research feed → lessons/skills, i.e. steps 1, 3, 4, 5 of the product loop.
- Gate it out of production builds (`import.meta.env.DEV` or an env flag).

### 1.2 Record/replay fixtures (free, deterministic runs)

- Both `generateVisual` and `generateResearch` already accept injected fetch /
  client impls. Add a thin cassette layer: `--record` runs live and writes
  request/response JSON to `evals/cassettes/`; default mode replays.
- The coding agent's inner loop (`bun run verify`, below) uses replay only —
  zero API calls, fully deterministic, no rate-limit exposure.

### 1.3 Mermaid truth-test corpus (kills the #1 regression class)

The structural validator can never fully match the real renderer. Add the real
thing to CI:

- `evals/mermaid-corpus/`: every mermaid source we've ever generated (record
  from eval runs + prod render failures), each labeled render-ok/render-fail.
- A Playwright test (chromium) loads a bare page, runs actual
  `mermaid.render()` over the corpus, and asserts: (a) everything our validator
  passes actually renders, (b) known-bad sources are caught by the validator
  *before* render. Divergences = a validator gap surfaced as a red test instead
  of a blank slide in prod.
- Cheap first approximation to try: `mermaid.parse()` under jsdom in vitest;
  keep the Playwright run as the fidelity backstop either way.

### 1.4 Offline eval harness with scorecard

`bun run eval` — a script, not a test, so it can be judgmental:

- ~15–25 fixed cases in `evals/cases.json`: `(topic, hint, pdfExcerpt)` triples
  drawn from 2–3 real papers (extracted text committed as fixtures).
- Runs `generateVisual` (and a few `generateResearch` cases) directly.
- Deterministic scoring per case: schema-valid, mermaid actually renders (via
  the corpus runner), axis labels pass, no hedge language, attempts used,
  latency.
- Emits `evals/report.json` + markdown summary. Baseline committed; the coding
  agent diffs scorecards before/after a change → objective regression signal.
- **Budget guards**: `--live` requires `--budget N` (max API calls), pacing
  delay between calls, exponential backoff on 429, and it aborts (not fails)
  when a provider says quota-exhausted. Default is replay mode.
- Optional `--judge` flag adds an LLM-graded content-quality score (uses free
  Gemini quota; off by default).

### 1.5 Playwright E2E of the no-voice loop

Using the text harness: upload fixture PDF → type a question → assert a slide
reaches `ready` and its SVG exists in the DOM → assert a research item appears.
Run against replay cassettes by default (route interception), `--live` variant
for pre-release. This is the "did the whole loop regress" test.

### 1.6 The coding-agent workflow

`bun run verify` = unit tests → replay eval + scorecard diff → Playwright
(replay). All free and deterministic. `bun run verify:live --budget 30` before
merging. Manual voice smoke (a 5-minute scripted checklist in
`docs/VOICE_SMOKE.md`) only at release points — that's the only place
ElevenLabs minutes get spent.

---

## Part 2 — Mermaid correctness strategy (answering the open question)

Retries vs sandbox vs skills file: **all three, arranged by where they're
cheap**, most of which already exists:

1. **Prevent (prompt + skills)** — the distilled R2 skill file already injects
   learned rules into every generation. Extend: eval failures also feed
   distillation (run `distillLessonsIntoSkill` from the eval harness), so the
   skill file improves from CI runs, not just live sessions. Skills changes
   that matter get pinned as new corpus entries so they can't silently regress.
2. **Catch (validator, server-side)** — the structural validator plus retry
   with the exact failure reason (built). The corpus test (1.3) is what keeps
   the validator honest over time. A true in-Worker `mermaid.parse()` is a
   *spike, not a commitment*: mermaid's flowchart/mindmap parsers still have
   DOM-adjacent deps; try linkedom + `mermaid.parse` in the Worker, promote it
   to the validator if it works, drop it if it fights back. (The "code sandbox"
   idea is this — running the real parser at validation time. The browser
   already is the sandbox of record; we just want its verdict earlier.)
3. **Recover (browser feedback loop)** — render failure → regenerate once with
   the renderer's exact error → visible error state (built).

With 1.3 in place, every novel render failure becomes: corpus entry + validator
rule + distilled skill rule — three layers learn from one failure.

---

## Part 3 — Free-tier provider strategy + latency masking

### 3.1 Provider posture (keep the trio, add the one we already pay nothing for)

- **Groq** (visualize): keep as primary — fastest structured-output free tier.
- **Cloudflare Workers AI**: already bound for skills distillation. Add it as
  the **429 failover** for visualize (llama-3.3-70b / gpt-oss on Workers AI,
  JSON-schema mode) — ~10k neurons/day free, zero extra latency from inside
  the Worker, no new account. Failover order: Groq → Workers AI → Gemini
  flash-lite (all free). This converts rate-limit errors from user-visible
  failures into a provider hop.
- **Gemini** (research synthesis): keep. Free-tier RPD is the binding
  constraint; the eval budget guards + arXiv/S2 offload (Part 4) reduce
  pressure.
- **ElevenLabs**: keep for the product; it's the only genuinely
  metered-scarce piece, which is exactly why the test plan removes it from the
  dev loop entirely. Optional later spike: Gemini Live API as a free-tier
  voice-agent alternative — real migration, only worth it if ElevenLabs
  minutes become the blocker.

### 3.2 Latency masking for visualize

- **Two-phase reveal**: fire a ~200ms `llama-3.1-8b-instant` call for
  title + one-line teaser, render immediately as the pending card's content;
  swap in the full visual when strict-mode finishes. Perceived latency drops
  from "seconds of spinner" to "instant slide that fills in".
- **Speculative pre-generation**: on PDF upload (idle time), pre-generate 3–4
  likely slides (overview diagram, key equation, headline chart) into a
  client-side cache; first matching question gets an instant slide.
- **Topic cache**: hash (paper, topic, kind) → R2; identical asks across
  sessions reuse the stored visual. Also cuts API spend.
- Right-size `max_tokens` per kind (tables/charts don't need 8192).
- Explicitly *not* recommended: racing two providers in parallel — doubles
  quota burn for modest gains; free tiers can't afford it.

---

## Part 4 — Actually implement step 5 (reference-following research)

Today `research` is Gemini answering **from training memory** — search
grounding was disabled because it tripped rate limits. "Find the referenced
paper and read it" needs real retrieval, and the right free tools are
structured APIs, not LLM web search:

- **Extract references at upload**: parse the references section from the PDF
  text (regex/heuristics; it's the best-structured part of any paper). Store
  titles/authors/years/arXiv IDs in the store alongside the PDF.
- **Resolve via free scholarly APIs**: arXiv API (free, no key) and Semantic
  Scholar API (free tier, generous) — deterministic, structured, and their
  rate limits are trivially manageable vs LLM grounding.
- **Read**: fetch the abstract (usually sufficient) or arXiv full text for the
  cited paper; summarize with one Gemini flash-lite call scoped to the user's
  question.
- **Wire in**: `research` tool gains a `citation` scope that goes through this
  pipeline; the agent prompt tells it to use citation scope when the user asks
  about "[23]" / "the X et al. paper". Contextual-update delivery is unchanged.
- Eval cases for this land in the harness like everything else.

---

## Part 5 — Sequencing

| Phase | What | Size |
|---|---|---|
| 0 | Hygiene: `bun remove ai @ai-sdk/openai-compatible` (needs local lockfile regen), create R2 bucket, deploy, one manual smoke | XS |
| 1 | Text harness mode + record/replay cassettes | S |
| 2 | Mermaid corpus + Playwright runner; seed corpus from eval/live failures | S |
| 3 | Eval harness + scorecard + baseline + `bun run verify` | M |
| 4 | Playwright E2E (replay-first) of upload → ask → slide → research | S |
| 5 | Provider failover (Groq → Workers AI → Gemini) + latency masking (two-phase reveal, speculative pre-gen, topic cache) | M |
| 6 | Reference-following research (refs extraction, arXiv/S2, citation scope) | M |
| 7 | Eval-driven skills distillation + voice smoke checklist doc | S |

Order rationale: Phases 1–4 make every later phase cheap to build *and verify*
— that's the "coding agent iterates on itself" unlock. Phase 5 attacks the two
biggest felt problems (429s, slow slides). Phase 6 completes the last missing
product capability. Phase 7 closes the self-improvement flywheel.

**Definition of done**: `bun run verify` green in replay mode with zero API
calls; live eval scorecard ≥ committed baseline under a ≤30-call budget; E2E
passes the full no-voice loop; a 5-minute manual voice smoke passes; render
failure rate in the eval corpus ~0; a question about a cited paper returns
grounded content from the actual paper.
