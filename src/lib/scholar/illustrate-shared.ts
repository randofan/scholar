// Pure, isomorphic half of the visualize pipeline: schemas, validators, and
// prompt text. Deliberately imports NOTHING provider-specific (no
// @google/genai, no Groq, no Cloudflare bindings) so it can be imported from
// browser code — the on-device Gemini Nano path in on-device.ts needs
// the same validation and JSON Schemas the server path used, and pulling
// illustrate.server.ts into the client bundle would drag a server SDK with it.

// The four visual shapes, declared once here and re-exported by store.ts.
//
// These were previously a Zod schema whose only consumer was `z.infer` — the
// object was never .parse()d, so it pulled zod into the client bundle purely
// to derive a type, while store.ts declared the same four shapes again as
// plain interfaces. Runtime validation of model output is done by
// runContentValidations + STRICT_KIND_SCHEMAS (which the Prompt API enforces
// via responseConstraint), so nothing was checking against the Zod version
// anyway.

export interface ChartSpec {
  chartType: "line" | "bar" | "area" | "scatter";
  xKey: string;
  yKeys: string[];
  data: Record<string, number | string>[];
  xLabel?: string;
  yLabel?: string;
}

export interface MathSpec {
  /** KaTeX strings, one per line of derivation. */
  steps: string[];
  inline?: string;
}

export interface DiagramSpec {
  /** mermaid source */
  mermaid: string;
}

export interface TableSpec {
  columns: string[];
  rows: (string | number)[][];
}

export interface Visual {
  title: string;
  /** One short sentence summarizing what's on screen. */
  narration: string;
  kind: StrictKind;
  chart?: ChartSpec;
  math?: MathSpec;
  diagram?: DiagramSpec;
  table?: TableSpec;
}

const MERMAID_HEADERS = [
  "graph",
  "flowchart",
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "journey",
  "gantt",
  "pie",
  "mindmap",
  "timeline",
  "gitGraph",
  "quadrantChart",
];

// Edge operators recognized across flowchart/sequenceDiagram-style syntax.
// Deliberately excludes bare "--" so labeled flowchart edges ("A -- label --> B")
// still count as exactly one edge.
const EDGE_OPERATOR_RE = /-->|-\.->|==>|--x|--o|->>|-->>|-x\b|-o\b/g;

// Mindmap bodies are indentation-only; any arrow-like token means the model
// bled flowchart syntax into a mindmap — "the exact bug we keep hitting" per
// the prompt guide.
const MINDMAP_ARROW_RE = /-->|->|--|-\.|==/;

export function validateMermaid(src: string): { ok: true } | { ok: false; reason: string } {
  const lines = src
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("%%"));
  if (lines.length < 2)
    return { ok: false, reason: "needs a header line plus at least one body line" };
  const first = lines[0];
  const header = MERMAID_HEADERS.find(
    (h) => first === h || first.startsWith(`${h} `) || first.startsWith(`${h}\t`),
  );
  if (!header) {
    return {
      ok: false,
      reason: `first line must start with a mermaid diagram keyword (e.g. ${MERMAID_HEADERS.slice(0, 5).join(", ")}); got "${first}"`,
    };
  }

  const bodyLines = lines.slice(1);

  // Balance check on common bracket pairs in node labels. erDiagram relation
  // lines use "{" as part of crow's-foot cardinality notation (e.g.
  // "PAPER ||--o{ CITATION"), not as a label delimiter — those "{"/"}" tokens
  // aren't a matched pair and would false-positive a balance check, so we
  // exclude relation lines (any line containing "--") from the curly-brace
  // count for that diagram type. Confirmed against a real-render corpus test
  // (tests/e2e/mermaid-corpus.spec.ts) — without this, valid ER diagrams like
  // "PAPER ||--o{ CITATION : references" were rejected as "unbalanced {}".
  const countableLines =
    header === "erDiagram"
      ? bodyLines.map((l) => (l.includes("--") ? l.replace(/[{}]/g, "") : l))
      : bodyLines;
  const countSrc = [first, ...countableLines].join("\n");
  const pairs: Array<[string, string]> = [
    ["[", "]"],
    ["(", ")"],
    ["{", "}"],
  ];
  for (const [open, close] of pairs) {
    const o = (countSrc.match(new RegExp(`\\${open}`, "g")) ?? []).length;
    const c = (countSrc.match(new RegExp(`\\${close}`, "g")) ?? []).length;
    if (o !== c)
      return { ok: false, reason: `unbalanced ${open}${close} in mermaid source (${o} vs ${c})` };
  }

  // NOTE: we used to hard-reject a ':' inside a bracketed label ("A[Step:
  // detail]") on the theory that colons are reserved syntax there. A
  // real-render corpus test (tests/e2e/mermaid-corpus.spec.ts) disproved
  // that for this mermaid version — such labels render fine — so the check
  // was removed rather than kept as a source of false-positive rejections.
  // `sanitizeMermaid()` still normalizes colons to " - " defensively, which
  // is harmless either way.

  if (header === "mindmap") {
    for (const line of bodyLines) {
      if (MINDMAP_ARROW_RE.test(line)) {
        return {
          ok: false,
          reason: `mindmap line "${line}" contains arrow/edge syntax — mindmaps use indentation only, never --> or -- edges between siblings`,
        };
      }
    }
  } else if (header === "flowchart" || header === "graph") {
    for (const line of bodyLines) {
      const edges = line.match(EDGE_OPERATOR_RE) ?? [];
      if (edges.length > 1) {
        return {
          ok: false,
          reason: `line "${line}" chains ${edges.length} edges on one line — put each edge on its own line`,
        };
      }
      if (edges.length === 1) {
        const idx = line.indexOf(edges[0]);
        const left = line.slice(0, idx).trim();
        const right = line.slice(idx + edges[0].length).trim();
        for (const [side, seg] of [
          ["source", left],
          ["target", right],
        ] as const) {
          if (/^[[({]/.test(seg)) {
            return {
              ok: false,
              reason: `line "${line}" has a bare bracketed ${side} node with no ID — use "ID[Label]", not "[Label]"`,
            };
          }
        }
      }
    }
  }

  return { ok: true };
}

const GENERIC_AXIS_LABEL_RE =
  /^(x|y|value|label|axis|tbd|n\/a|data|series|metric|category|categories|count)$/i;
const AXIS_UNIT_HINT_RE =
  /[(%]|\b(ms|s|sec|secs|seconds|min|mins|hours?|days?|tokens?|params?|parameters?|gb|mb|kb|bytes?|usd|flops?|epochs?|steps?|iterations?)\b/i;

/** Cheap, deterministic positive quality check for a single chart axis label. */
export function validateAxisLabel(
  label: string | undefined,
  axis: "x" | "y",
): { ok: true } | { ok: false; reason: string } {
  const trimmed = (label ?? "").trim();
  if (!trimmed) {
    return {
      ok: false,
      reason: `${axis}Label is empty — provide a descriptive axis label, ideally with units`,
    };
  }
  if (trimmed.length < 4) {
    return {
      ok: false,
      reason: `${axis}Label "${trimmed}" is too short to be a descriptive axis label`,
    };
  }
  if (GENERIC_AXIS_LABEL_RE.test(trimmed)) {
    return {
      ok: false,
      reason: `${axis}Label "${trimmed}" is a generic placeholder, not a descriptive label`,
    };
  }
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount < 2 && !AXIS_UNIT_HINT_RE.test(trimmed)) {
    return {
      ok: false,
      reason: `${axis}Label "${trimmed}" is a single generic word with no unit — add units or more description (e.g. "Latency (ms)")`,
    };
  }
  return { ok: true };
}

export function validateAxisLabels(
  chart:
    | {
        xLabel?: string;
        yLabel?: string;
      }
    | undefined,
): { ok: true } | { ok: false; reason: string } {
  const x = validateAxisLabel(chart?.xLabel, "x");
  if (!x.ok) return x;
  const y = validateAxisLabel(chart?.yLabel, "y");
  if (!y.ok) return y;
  return { ok: true };
}

function sanitizeMermaid(src: string) {
  let out = src
    .replace(/\[([^\]\n]*?):\s*([^\]\n]*?)\]/g, "[$1 - $2]")
    .replace(/\(\(([^)\n]*?):\s*([^)]*?)\)\)/g, "(($1 - $2))");
  // Mindmaps cannot contain flowchart arrows; convert "a --> b" to a parent/child
  // pair so we at least produce parseable output instead of a lexer error.
  const firstLine =
    out
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  if (/^mindmap\b/.test(firstLine)) {
    out = out
      .split("\n")
      .map((line) => {
        const m = line.match(/^(\s*)(.+?)\s*-->\s*(.+?)\s*$/);
        if (!m) return line;
        const [, indent, parent, child] = m;
        const cleanParent = parent.replace(/^\[|\]$/g, "").trim();
        const cleanChild = child.replace(/^\[|\]$/g, "").trim();
        return `${indent}${cleanParent}\n${indent}  ${cleanChild}`;
      })
      .join("\n");
  }
  return out;
}

export function validateVisual(v: Visual): { ok: true } | { ok: false; reason: string } {
  const spec = (v as unknown as Record<string, unknown>)[v.kind];
  if (spec == null)
    return { ok: false, reason: `kind="${v.kind}" but the matching "${v.kind}" field is missing` };
  if (v.kind === "diagram" && v.diagram) {
    const m = validateMermaid(v.diagram.mermaid);
    if (!m.ok) return { ok: false, reason: `invalid mermaid: ${m.reason}` };
  }
  return { ok: true };
}

export const MERMAID_DIAGRAM_GUIDE = `MERMAID DIAGRAM SKILL — invalid mermaid is the #1 failure mode. Read every rule. Self-check before emitting.

================================================================
A. GLOBAL RULES (apply to ALL diagram types)
================================================================
A1. Line 1 must be EXACTLY one diagram header keyword and nothing else (optionally followed by direction for flowchart). No prose, no markdown fence, no "diagram:" prefix.
A2. NEVER mix syntaxes from different diagram types in one source. A "mindmap" file uses mindmap syntax only; a "flowchart" file uses flowchart syntax only; etc.
A3. Balance every bracket pair: every [ has a ], every ( has a ), every { has a }, every (( has a )), every {{ has a }}.
A4. Prefer ' - ' over ':' inside a node label for readability (e.g. "A[Step - detail]"). Colons ARE syntactically meaningful in sequenceDiagram messages, classDiagram relations, and stateDiagram transitions — keep those as-is.
A5. NEVER put commas, parentheses, or quotes inside an unquoted label. If you need them, wrap the WHOLE label in double quotes: A["Throughput (Gbps), measured"].
A6. Node IDs are short ASCII identifiers ([A-Za-z][A-Za-z0-9_]*). Labels go inside the shape brackets, not inline as bare text.
A7. One statement per line. Do NOT chain multiple edges on one line separated by spaces (e.g. "A --> B  B --> C" is INVALID — put each on its own line).
A8. Emit at least 4 substantive nodes/items; never a 2-node toy diagram.
A9. No emojis, no HTML tags, no markdown inside labels.

================================================================
B. flowchart  (use for: processes, architectures, pipelines, decision flows)
================================================================
Header: "flowchart TD" (top-down) or "flowchart LR" (left-right).

Edge syntax:
  A --> B                  // plain edge
  A -- "label" --> B        // labeled edge (quote multi-word labels)
  A -.-> B                  // dotted edge
  A ==> B                   // thick edge

Node shapes (declare label once, then reference by ID):
  A[Rectangle]
  B(Rounded)
  C((Circle))
  D{Diamond}
  E[/Parallelogram/]
  F[(Cylinder)]

CORRECT EXAMPLE — COPY THIS SHAPE:
  flowchart LR
    Q[User query] --> R{Cache hit?}
    R -- yes --> C[Return cached]
    R -- no --> M[Run model]
    M --> S[(Store result)]
    S --> C

WRONG examples to avoid:
  [WP0] --> [WP1]                       // bare brackets, no node IDs
  A --> B  B --> C                      // two edges on one line
  flowchart LR\\n  A((R1)) A -- B  A -- C  // chained edges, no -->

================================================================
C. mindmap  (use for: hierarchies, "list of N things", taxonomies, contribution maps)
================================================================
Header: "mindmap" (no direction).

Rules:
  - Hierarchy is INDENTATION ONLY (2 spaces per level). NEVER use --> arrows.
  - Root on its own line; can use shape: root((Title)) or root[Title] or plain text.
  - Children are plain text, indented under their parent. No [labels] required.
  - Do NOT chain children on one line.

CORRECT EXAMPLE — COPY THIS SHAPE:
  mindmap
    root((Paper title))
      Contribution 1
        Detail A
        Detail B
      Contribution 2
        Detail C
      Contribution 3
        Detail D
        Detail E

WRONG examples to avoid:
  mindmap\\n  root((R)) A --> B          // arrows are forbidden in mindmap
  mindmap\\n  root((R5))  A -- B  A -- C // chained siblings + edge syntax (this is the exact bug we keep hitting)

================================================================
D. sequenceDiagram  (use for: actor-to-actor message timelines)
================================================================
Header: "sequenceDiagram"

  sequenceDiagram
    participant U as User
    participant S as Server
    U->>S: request payload
    S-->>U: response payload
    Note over U,S: Optional annotation

Arrows: ->> (solid), -->> (dashed), -x (with cross).

================================================================
E. classDiagram
================================================================
  classDiagram
    class Node {
      +id: string
      +children: Node[]
      +visit() void
    }
    Node "1" --> "*" Node : children

================================================================
F. stateDiagram-v2
================================================================
  stateDiagram-v2
    [*] --> Idle
    Idle --> Running : start
    Running --> Idle : stop
    Running --> [*] : crash

================================================================
G. SELF-CHECK (run mentally before returning the mermaid string)
================================================================
1. Is line 1 exactly one valid header keyword?
2. If header is "mindmap": are there ZERO occurrences of "-->" or "--" edges?
3. Does every "[" have a matching "]"? Every "("? Every "{"?
4. Are node IDs short ASCII identifiers with labels inside shape brackets, not bare text?
5. Is every edge / child on its own line?
6. Are there at least 4 substantive nodes?
If any answer is no, FIX IT before emitting.

================================================================
H. RETRY CONTRACT
================================================================
If the user message contains a line starting with "PREVIOUS ATTEMPT FAILED:", that line names the EXACT rule your last output violated (a validator checked it mechanically). Fix ONLY that specific problem in your next output — do not regenerate the whole diagram/chart from scratch in a way that could reintroduce the same class of error.`;

export interface IllustrateInput {
  topic: string;
  hint?: string;
  pdfExcerpt?: string;
  /**
   * Titles + kinds of slides already on the canvas, newest first. We surface
   * these to the model so it never repeats a slide back-to-back; one of the
   * regressions we hit was the same RNG-vs-fat-tree table appearing on every
   * slide because nothing in the loop checked prior visuals.
   */
  recentVisuals?: Array<{ title: string; kind: Visual["kind"] }>;
  /**
   * A browser-side render failure from a previous generation of this same
   * request: the exact mermaid source that mermaid.render() rejected plus the
   * renderer's error message. Seeds the first attempt's correction block so
   * the model knows precisely what to fix.
   */
  renderFailure?: { source: string; error: string };
  /**
   * Rolling, session-scoped list of failure lessons harvested from earlier
   * validator rejections and render failures. Injected into the prompt as
   * "known failure modes" so the same mistake isn't repeated later in the
   * session.
   */
  lessons?: string[];
  /**
   * Persistent rules distilled from past sessions' failures (loaded from the
   * R2 skill file by the API route). Injected as "LEARNED RULES" so fixes for
   * common failure modes survive across sessions and users.
   */
  skillRules?: string[];
}

export interface IllustrateResult {
  visual: Visual;
  attempts: number;
  warnings: string[];
}

const HEDGE_RE =
  /\b(does not (provide|contain|include|describe|specify|mention)|not (enough|sufficient) (information|detail|context)|no (explicit|specific) (equations?|formulas?|diagrams?|details?|information)|the (paper|text|excerpt|document) (does not|doesn't|lacks)|insufficient (information|detail|context)|within the provided text|in the provided (text|excerpt))\b/i;
const META_NARRATION_RE =
  /^\s*(diagram|chart|table|math|formula|equation|illustration|figure|visualization)\s*:/i;
const PROMPT_LIKE_VISUAL_TEXT_RE =
  /^\s*(a\s+)?(chart|table|diagram|graph|math derivation)\s+(comparing|summarizing|showing|illustrating|describing)\b|\bsummarizing the\b/i;

export function containsHedgeLanguage(text: string | undefined | null): boolean {
  if (!text) return false;
  return HEDGE_RE.test(text) || META_NARRATION_RE.test(text);
}

export function isPromptLikeVisualText(text: string | undefined | null): boolean {
  return Boolean(text && PROMPT_LIKE_VISUAL_TEXT_RE.test(text));
}

/**
 * Content-level checks run on every generated visual before it's accepted, so
 * a validation rule is written once and each retry attempt is held to the same
 * bar. Structural concerns (missing spec, invalid mermaid) and quality concerns
 * (axis labels, hedging, prompt-echoing) all return a precise reason string,
 * which flows straight into the "PREVIOUS ATTEMPT FAILED" retry correction.
 */
export function runContentValidations(
  visual: Visual,
): { ok: true } | { ok: false; reason: string } {
  const structural = validateVisual(visual);
  if (!structural.ok) return structural;

  if (visual.kind === "chart") {
    const axisCheck = validateAxisLabels(visual.chart);
    if (!axisCheck.ok) return axisCheck;
  }

  const hedgeSource = containsHedgeLanguage(visual.narration) ? visual.narration : undefined;
  if (hedgeSource) {
    return {
      ok: false,
      reason: `output contained hedge/meta language ("${hedgeSource.slice(0, 120)}"). Re-generate with concrete content using canonical textbook knowledge if the paper lacks specifics. No meta-commentary about the paper's contents.`,
    };
  }

  const promptLikeSource = isPromptLikeVisualText(visual.narration) ? visual.narration : undefined;
  if (promptLikeSource) {
    return {
      ok: false,
      reason: `output repeated the visualization prompt instead of rendering content ("${promptLikeSource.slice(0, 120)}"). Return concrete rows, equations, chart points, or mermaid nodes.`,
    };
  }

  return { ok: true };
}

const KIND_KEYWORDS: Array<{ kind: Visual["kind"]; re: RegExp }> = [
  {
    kind: "math",
    re: /\b(math|mathematic\w*|equation|formula|formalism|derivation|loss function|theorem|proof|complexity bound)\b/i,
  },
  { kind: "table", re: /\b(table|matrix|comparison table)\b/i },
  { kind: "chart", re: /\b(chart|plot|trend|line chart|bar chart|scatter|histogram|curve)\b/i },
  {
    kind: "diagram",
    re: /\b(diagram|flowchart|flow chart|architecture|pipeline|topology|mindmap|sequence diagram|state machine|tree structure|expander graph|fat tree)\b/i,
  },
];

export function detectRequestedKind(input: IllustrateInput): Visual["kind"] | null {
  const text = `${input.topic ?? ""} ${input.hint ?? ""}`;
  for (const { kind, re } of KIND_KEYWORDS) {
    if (re.test(text)) return kind;
  }
  return null;
}

/** The four kinds we generate. There is deliberately no text-only slide kind. */
export type StrictKind = "diagram" | "table" | "math" | "chart";

export const STRICT_KIND_SCHEMAS: Record<StrictKind, Record<string, unknown>> = {
  diagram: {
    type: "object",
    properties: {
      title: { type: "string", description: "≤60 char specific title" },
      narration: { type: "string", description: "One short sentence describing on-screen content" },
      mermaid: {
        type: "string",
        description:
          "Valid mermaid source. Line 1 is exactly one header: 'flowchart TD', 'flowchart LR', 'mindmap', 'sequenceDiagram', 'classDiagram', or 'stateDiagram-v2'. Do NOT mix syntaxes — mindmaps use indentation only and MUST NOT contain '-->' arrows or '[Label]' children. Flowcharts use 'A[Label] --> B[Label]' with short ASCII ids. Balance every [ ] ( ) { }. No ':' inside node labels.",
      },
    },
    required: ["title", "narration", "mermaid"],
    additionalProperties: false,
  },
  table: {
    type: "object",
    properties: {
      title: { type: "string" },
      narration: { type: "string" },
      columns: {
        type: "array",
        items: { type: "string" },
        description: "3-6 column headers",
      },
      rows: {
        type: "array",
        description: "3-8 rows; each row must have exactly the same length as columns",
        items: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
    required: ["title", "narration", "columns", "rows"],
    additionalProperties: false,
  },
  math: {
    type: "object",
    properties: {
      title: { type: "string" },
      narration: { type: "string" },
      inline: {
        type: "string",
        description: "Optional one-line plain English summary; empty string is OK",
      },
      steps: {
        type: "array",
        items: { type: "string" },
        description: "Each step is a KaTeX string with NO $ delimiters",
      },
    },
    required: ["title", "narration", "inline", "steps"],
    additionalProperties: false,
  },
  chart: {
    type: "object",
    properties: {
      title: { type: "string" },
      narration: { type: "string" },
      chartType: { type: "string", enum: ["line", "bar", "area", "scatter"] },
      xLabel: {
        type: "string",
        description:
          "REQUIRED non-empty descriptive x-axis label, ideally with units, e.g. 'Sequence length (tokens)'. NEVER empty, NEVER 'X' or 'value'.",
      },
      yLabel: {
        type: "string",
        description:
          "REQUIRED non-empty descriptive y-axis label, ideally with units, e.g. 'Latency (ms)'. NEVER empty, NEVER 'Y' or 'value'.",
      },
      series: {
        type: "array",
        description: "One entry per data series",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            points: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  x: { type: "string", description: "X-axis label or value as string" },
                  y: { type: "number" },
                },
                required: ["x", "y"],
                additionalProperties: false,
              },
            },
          },
          required: ["name", "points"],
          additionalProperties: false,
        },
      },
    },
    required: ["title", "narration", "chartType", "xLabel", "yLabel", "series"],
    additionalProperties: false,
  },
};

interface StrictChartPayload {
  title: string;
  narration: string;
  chartType: "line" | "bar" | "area" | "scatter";
  xLabel: string;
  yLabel: string;
  series: Array<{ name: string; points: Array<{ x: string; y: number }> }>;
}

export function strictPayloadToVisual(kind: StrictKind, payload: unknown): Visual {
  const p = payload as Record<string, unknown>;
  const title = String(p.title ?? "").slice(0, 80);
  const narration = String(p.narration ?? "");
  if (kind === "diagram") {
    return {
      title,
      narration,
      kind: "diagram",
      diagram: { mermaid: sanitizeMermaid(String(p.mermaid ?? "")) },
    };
  }
  if (kind === "table") {
    return {
      title,
      narration,
      kind: "table",
      table: {
        columns: (p.columns as string[]) ?? [],
        rows: (p.rows as string[][]) ?? [],
      },
    };
  }
  if (kind === "math") {
    const inline = typeof p.inline === "string" && p.inline.trim() ? p.inline : undefined;
    return {
      title,
      narration,
      kind: "math",
      math: {
        steps: (p.steps as string[]) ?? [],
        ...(inline ? { inline } : {}),
      },
    };
  }
  // chart — fold {series:[{name,points:[{x,y}]}]} back into {xKey,yKeys,data[]}
  const chart = payload as StrictChartPayload;
  const xKey = "x";
  const yKeys = chart.series.map((s) => s.name);
  // Merge points by x value across series.
  const merged = new Map<string, Record<string, number | string>>();
  for (const s of chart.series) {
    for (const pt of s.points) {
      const row = merged.get(pt.x) ?? { x: pt.x };
      row[s.name] = pt.y;
      merged.set(pt.x, row);
    }
  }
  return {
    title,
    narration,
    kind: "chart",
    chart: {
      chartType: chart.chartType,
      xKey,
      yKeys,
      xLabel: chart.xLabel || undefined,
      yLabel: chart.yLabel || undefined,
      data: Array.from(merged.values()),
    },
  };
}

// ---------------------------------------------------------------------------
// Per-kind system prompts.
//
// These are sized for an on-device model (Chrome's Gemini Nano) with a hard
// input quota of a few thousand tokens, so a monolithic prompt carrying every
// format's rules is not affordable. Each kind gets ONLY the preamble plus its
// own format skill: a table request never pays for the 1,400-token mermaid
// guide, and a diagram request never pays for the KaTeX rules. Compose with
// buildSystemPrompt() so kind-scoped learned rules land in the same place.
// ---------------------------------------------------------------------------

const COMMON_PREAMBLE = `You generate ONE slide for a live research-companion deck. Output must be structured and information-dense — never a restatement of the title.

NO-HEDGE RULE (CRITICAL): NEVER write "the paper does not provide", "not enough information", "insufficient detail", or any meta-commentary about the source. If the supplied facts lack specifics, use CANONICAL TEXTBOOK KNOWLEDGE of the topic and deliver the visual anyway.

QUALITY BAR: add information beyond the title; enumerate real items; "narration" is ≤20 words describing concrete on-screen content (never starts with "Diagram:", "Chart:", "Overview of"); "title" is ≤60 chars and specific.

RETRY CONTRACT: if the user message contains "PREVIOUS ATTEMPT FAILED:", that line names the exact rule a validator caught. Fix ONLY that problem — do not regenerate from scratch.`;

const TABLE_SKILL = `TABLE SKILL: 3-6 columns, 3-8 rows of substantive content. Every row MUST have exactly the same number of cells as the columns array. Cells are short values or phrases, not sentences.`;

const CHART_SKILL = `CHART SKILL:
- 8-15 realistic illustrative points per series.
- "xLabel" and "yLabel" are MANDATORY and descriptive. Include units where applicable.
- A single generic word ("Latency") is NOT enough — pair it with a unit or a second word: "Latency (ms)", "Model size (params)", "Training steps".
- The chart must be readable standalone: the axes alone should say what is measured.
- GOOD: "Sequence length (tokens)", "Throughput (req/s)", "Training loss".
- BAD (never emit): "X", "Y", "Value", "Axis", "Metric", "Data".`;

const MATH_SKILL = `KATEX SKILL:
- 3-5 steps MAXIMUM. Each step is ONE focused KaTeX expression, not a paragraph.
- Inside JSON strings every backslash is written \\\\ and newlines as \\n. No raw control characters.
- Use real commands: \\\\frac{a}{b}, \\\\sum_{i=1}^{n}, \\\\min_{x \\\\in S}, \\\\sqrt{x}, \\\\le, \\\\approx, \\\\subseteq, \\\\cdot, \\\\lambda, \\\\bar{S}, \\\\mathcal{O}.
- Subscripts/superscripts use braces: x_{i}, n^{2}, \\\\lambda_{2}(G).
- PURE notation only. Never use \\\\text{...} for prose — English belongs in "narration" or "inline".
- No $ delimiters. "inline" is a short plain-English caption or empty, never more math.
- GOOD (Cheeger constant): "h(G) = \\\\min_{S \\\\subseteq V} \\\\frac{|E(S, \\\\bar{S})|}{|S|}" then "\\\\lambda_{2}(G) \\\\le 2\\\\, h(G)".
- BAD: "\\\\text{For a }d\\\\text{-regular graph: }h(G) \\\\ge d" — strip \\\\text, move prose to narration.`;

/** The format-specific half of each system prompt. Diagram carries the full mermaid guide; the others are far smaller. */
export const FORMAT_SKILL_BY_KIND: Record<StrictKind, string> = {
  diagram: MERMAID_DIAGRAM_GUIDE,
  table: TABLE_SKILL,
  chart: CHART_SKILL,
  math: MATH_SKILL,
};

/** Base system prompt per kind, before any learned rules are appended. */
export const SYSTEM_PROMPT_BY_KIND: Record<StrictKind, string> = {
  diagram: `${COMMON_PREAMBLE}\n\n${FORMAT_SKILL_BY_KIND.diagram}`,
  table: `${COMMON_PREAMBLE}\n\n${FORMAT_SKILL_BY_KIND.table}`,
  chart: `${COMMON_PREAMBLE}\n\n${FORMAT_SKILL_BY_KIND.chart}`,
  math: `${COMMON_PREAMBLE}\n\n${FORMAT_SKILL_BY_KIND.math}`,
};

/**
 * System prompt for one kind, with that kind's distilled learned rules folded
 * in. Rules are kind-scoped (see skills.server.ts) because they come from
 * validator rejections and render errors, which are inherently format-specific
 * — a mermaid bracket rule is noise in a table prompt.
 */
export function buildSystemPrompt(kind: StrictKind, skillRules: string[] = []): string {
  const base = SYSTEM_PROMPT_BY_KIND[kind];
  const rules = skillRules
    .map((r) => r.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (rules.length === 0) return base;
  return `${base}\n\nLEARNED RULES (from past failures on this exact format — follow ALL):\n${rules
    .map((r) => `- ${r.slice(0, 200)}`)
    .join("\n")}`;
}

/** Fallback kind picker, used when a caller has no explicit kind (evals). */
export function pickStrictKind(input: IllustrateInput): StrictKind {
  const requested = detectRequestedKind(input);
  if (requested) return requested;
  const text = `${input.topic ?? ""} ${input.hint ?? ""}`;
  if (/\b(compare|comparison|versus|vs\.?|baseline|trade-?off|matrix)\b/i.test(text))
    return "table";
  if (/\b(architecture|pipeline|flow|process|component|tree|graph|topology|mindmap)\b/i.test(text))
    return "diagram";
  if (/\b(equation|formula|derivation|theorem|complexity)\b/i.test(text)) return "math";
  if (/\b(trend|plot|chart|curve|histogram)\b/i.test(text)) return "chart";
  return "diagram";
}
