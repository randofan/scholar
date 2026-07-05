import { generateText, Output, NoObjectGeneratedError } from "ai";
import { z } from "zod";
import {
  GROQ_BASE_URL,
  GROQ_MODELS,
  resolveAiProvider,
  type AiProviderEnv,
  type ResolvedAiProvider,
} from "@/lib/ai-gateway";

const ChartSpec = z.object({
  chartType: z.enum(["line", "bar", "area", "scatter"]),
  xKey: z.string(),
  yKeys: z.array(z.string()).min(1),
  data: z.array(z.record(z.string(), z.union([z.number(), z.string()]))).min(2),
  xLabel: z.string().optional(),
  yLabel: z.string().optional(),
});
const MathSpec = z.object({
  steps: z.array(z.string()).min(1),
  inline: z.string().optional(),
});
const DiagramSpec = z.object({ mermaid: z.string().min(5) });
const TableSpec = z.object({
  columns: z.array(z.string()).min(1),
  rows: z.array(z.array(z.union([z.string(), z.number()]))).min(1),
});
const CalloutSpec = z.object({
  body: z.string(),
  tone: z.enum(["info", "warn", "key"]).optional(),
});

// Permissive schema used during model generation — models frequently shortcut
// `diagram: { mermaid: "..." }` to `diagram: "..."`, omit title/narration, or
// emit `null` for unused spec fields. Normalize below before strict validation.
const LooseVisualSchema = z.object({
  title: z.string().optional().nullable(),
  narration: z.string().optional().nullable(),
  kind: z.enum(["chart", "math", "diagram", "table", "callout"]),
  chart: z.any().optional().nullable(),
  math: z.any().optional().nullable(),
  diagram: z.any().optional().nullable(),
  table: z.any().optional().nullable(),
  callout: z.any().optional().nullable(),
  mermaid: z.any().optional().nullable(),
  columns: z.any().optional().nullable(),
  rows: z.any().optional().nullable(),
  chartType: z.any().optional().nullable(),
  xKey: z.any().optional().nullable(),
  yKeys: z.any().optional().nullable(),
  data: z.any().optional().nullable(),
  xLabel: z.any().optional().nullable(),
  yLabel: z.any().optional().nullable(),
  steps: z.any().optional().nullable(),
  inline: z.any().optional().nullable(),
  body: z.any().optional().nullable(),
  tone: z.any().optional().nullable(),
  text: z.any().optional().nullable(),
  message: z.any().optional().nullable(),
  content: z.any().optional().nullable(),
  note: z.any().optional().nullable(),
}).passthrough();

export const VisualSchema = z.object({
  title: z.string(),
  narration: z.string().describe("One short sentence summarizing what's on screen"),
  kind: z.enum(["chart", "math", "diagram", "table", "callout"]),
  chart: ChartSpec.optional(),
  math: MathSpec.optional(),
  diagram: DiagramSpec.optional(),
  table: TableSpec.optional(),
  callout: CalloutSpec.optional(),
});

export type Visual = z.infer<typeof VisualSchema>;

export function normalizeLoose(
  raw: z.infer<typeof LooseVisualSchema>,
  fallback: { title: string; narration: string },
): { ok: true; visual: Visual } | { ok: false; reason: string } {
  const title = (raw.title ?? "").trim() || fallback.title;
  const narration = (raw.narration ?? "").trim() || fallback.narration;
  const kind = raw.kind;
  const base = { title, narration, kind } as const;

  const coerce = (
    field: "chart" | "math" | "diagram" | "table" | "callout",
  ): unknown => {
    const record = raw as Record<string, unknown>;
    const nestedCandidates = [record.spec, record.visual, record.diagramSpec, record.payload]
      .filter((v): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v)));
    const firstString = (keys: string[]) => {
      for (const key of keys) {
        if (typeof record[key] === "string") return record[key];
        for (const nested of nestedCandidates) {
          if (typeof nested[key] === "string") return nested[key];
        }
      }
      for (const value of Object.values(record)) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const obj = value as Record<string, unknown>;
          for (const key of keys) if (typeof obj[key] === "string") return obj[key];
        }
      }
      return undefined;
    };
    const v = raw[field];
    if (v == null) {
      if (field === "diagram") {
        if (typeof record.spec === "string") return { mermaid: record.spec };
        const mermaid = firstString(["mermaid", "mermaidDiagram", "mermaid_code", "diagramCode", "source", "code"]);
        if (mermaid) return { mermaid };
      }
      if (field === "table") {
        if (raw.columns && raw.rows) return { columns: raw.columns, rows: raw.rows };
        // Model often nests table under spec/payload/visual/data, or returns
        // { table: { columns, rows } } via a sibling object. Search for the
        // first nested object that has both columns and rows arrays.
        for (const nested of nestedCandidates) {
          if (Array.isArray(nested.columns) && Array.isArray(nested.rows)) {
            return { columns: nested.columns, rows: nested.rows };
          }
          if (nested.table && typeof nested.table === "object") return nested.table;
        }
        for (const value of Object.values(record)) {
          if (value && typeof value === "object" && !Array.isArray(value)) {
            const obj = value as Record<string, unknown>;
            if (Array.isArray(obj.columns) && Array.isArray(obj.rows)) {
              return { columns: obj.columns, rows: obj.rows };
            }
          }
        }
      }
      if (field === "chart" && raw.chartType && raw.xKey && raw.yKeys && raw.data) {
        return {
          chartType: raw.chartType,
          xKey: raw.xKey,
          yKeys: raw.yKeys,
          data: raw.data,
          xLabel: raw.xLabel ?? undefined,
          yLabel: raw.yLabel ?? undefined,
        };
      }
      if (field === "math" && raw.steps) return { steps: raw.steps, inline: raw.inline ?? undefined };
      if (field === "callout") {
        const body = raw.body ?? raw.text ?? raw.message ?? raw.content ?? raw.note;
        if (typeof body === "string") return { body, tone: raw.tone ?? undefined };
      }
      return undefined;
    }
    if (field === "diagram" && typeof v === "string") return { mermaid: v };
    if (field === "callout" && typeof v === "string") return { body: v };
    if (field === "math" && Array.isArray(v)) return { steps: v as string[] };
    return v;
  };

  // Callouts are pure text and the model frequently omits the `callout` field
  // entirely (putting the body in `narration`, or in misnamed fields like
  // `text` / `message` / `content` / `note` / `body`). Build a guaranteed-valid
  // spec from whatever is present so we never crash on missing structure.
  const coerceCallout = (): { body: string; tone?: "info" | "warn" | "key" } => {
    const direct = coerce("callout");
    if (direct && typeof direct === "object") {
      const o = direct as Record<string, unknown>;
      const body =
        (typeof o.body === "string" && o.body) ||
        (typeof o.text === "string" && o.text) ||
        (typeof o.message === "string" && o.message) ||
        (typeof o.content === "string" && o.content) ||
        (typeof o.note === "string" && o.note) ||
        narration ||
        title;
      const tone =
        o.tone === "info" || o.tone === "warn" || o.tone === "key"
          ? (o.tone as "info" | "warn" | "key")
          : undefined;
      return tone ? { body: String(body), tone } : { body: String(body) };
    }
    // Last resort: synthesize from narration/title so a callout always renders.
    return { body: narration || title };
  };

  try {
    if (kind === "chart") {
      const spec = ChartSpec.parse(coerce("chart"));
      return { ok: true, visual: { ...base, chart: spec } };
    }
    if (kind === "math") {
      const spec = MathSpec.parse(coerce("math"));
      return { ok: true, visual: { ...base, math: spec } };
    }
    if (kind === "diagram") {
      const parsed = DiagramSpec.parse(coerce("diagram"));
      const spec = { mermaid: sanitizeMermaid(parsed.mermaid) };
      return { ok: true, visual: { ...base, diagram: spec } };
    }
    if (kind === "table") {
      const spec = TableSpec.parse(coerce("table"));
      return { ok: true, visual: { ...base, table: spec } };
    }
    const spec = CalloutSpec.parse(coerceCallout());
    return { ok: true, visual: { ...base, callout: spec } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "spec parse failed";
    return { ok: false, reason: `kind="${kind}" spec invalid: ${msg}` };
  }
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

// A4: colons inside bracketed labels are reserved syntax in several diagram
// types (they terminate the label early or get parsed as a relation). Catch
// this regardless of diagram type since it's never valid inside a bracket.
const COLON_IN_BRACKETS_RE = /\[[^[\]]*:[^[\]]*\]|\([^()]*:[^()]*\)|\{[^{}]*:[^{}]*\}/;

// Mindmap bodies are indentation-only; any arrow-like token means the model
// bled flowchart syntax into a mindmap — "the exact bug we keep hitting" per
// the prompt guide.
const MINDMAP_ARROW_RE = /-->|->|--|-\.|==/;

export function validateMermaid(src: string): { ok: true } | { ok: false; reason: string } {
  const lines = src
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("%%"));
  if (lines.length < 2) return { ok: false, reason: "needs a header line plus at least one body line" };
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
  // Balance check on common bracket pairs in node labels.
  const pairs: Array<[string, string]> = [
    ["[", "]"],
    ["(", ")"],
    ["{", "}"],
  ];
  for (const [open, close] of pairs) {
    const o = (src.match(new RegExp(`\\${open}`, "g")) ?? []).length;
    const c = (src.match(new RegExp(`\\${close}`, "g")) ?? []).length;
    if (o !== c) return { ok: false, reason: `unbalanced ${open}${close} in mermaid source (${o} vs ${c})` };
  }

  const bodyLines = lines.slice(1);

  for (const line of bodyLines) {
    if (COLON_IN_BRACKETS_RE.test(line)) {
      return {
        ok: false,
        reason: `line "${line}" has a ':' inside a bracketed label — use ' - ' instead (e.g. "A[Step - detail]")`,
      };
    }
  }

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
    return { ok: false, reason: `${axis}Label is empty — provide a descriptive axis label, ideally with units` };
  }
  if (trimmed.length < 4) {
    return { ok: false, reason: `${axis}Label "${trimmed}" is too short to be a descriptive axis label` };
  }
  if (GENERIC_AXIS_LABEL_RE.test(trimmed)) {
    return { ok: false, reason: `${axis}Label "${trimmed}" is a generic placeholder, not a descriptive label` };
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

export function validateAxisLabels(chart: {
  xLabel?: string;
  yLabel?: string;
} | undefined): { ok: true } | { ok: false; reason: string } {
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
  const firstLine = out.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
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
  if (spec == null) return { ok: false, reason: `kind="${v.kind}" but the matching "${v.kind}" field is missing` };
  if (v.kind === "diagram" && v.diagram) {
    const m = validateMermaid(v.diagram.mermaid);
    if (!m.ok) return { ok: false, reason: `invalid mermaid: ${m.reason}` };
  }
  return { ok: true };
}

const MERMAID_DIAGRAM_GUIDE = `MERMAID DIAGRAM SKILL — invalid mermaid is the #1 failure mode. Read every rule. Self-check before emitting.

================================================================
A. GLOBAL RULES (apply to ALL diagram types)
================================================================
A1. Line 1 must be EXACTLY one diagram header keyword and nothing else (optionally followed by direction for flowchart). No prose, no markdown fence, no "diagram:" prefix.
A2. NEVER mix syntaxes from different diagram types in one source. A "mindmap" file uses mindmap syntax only; a "flowchart" file uses flowchart syntax only; etc.
A3. Balance every bracket pair: every [ has a ], every ( has a ), every { has a }, every (( has a )), every {{ has a }}.
A4. NEVER put ':' inside a node label. Use ' - ' or ' — ' instead. (Colons are syntactically reserved in many diagram types.)
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
  A[Step: detail] --> B                 // colon inside label
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
  mindmap\\n  root\\n    [Child: thing]  // colon inside label

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
4. Is every ":" outside of bracketed labels (only allowed in sequenceDiagram messages, classDiagram relations, and stateDiagram transitions)?
5. Is every edge / child on its own line?
6. Are there at least 4 substantive nodes?
If any answer is no, FIX IT before emitting.

================================================================
H. RETRY CONTRACT
================================================================
If the user message contains a line starting with "PREVIOUS ATTEMPT FAILED:", that line names the EXACT rule your last output violated (a validator checked it mechanically). Fix ONLY that specific problem in your next output — do not regenerate the whole diagram/chart from scratch in a way that could reintroduce the same class of error.`;

const SYSTEM_PROMPT = `You are a scientific visualization generator for a live research-companion slide deck. Each turn you produce ONE slide that makes the user smarter about the paper. Bias hard toward STRUCTURED, INFORMATION-DENSE visuals — never a bare restatement of the topic.

KIND SELECTION (pick the first that fits, UNLESS the topic/hint explicitly requests a specific kind — then you MUST honor it):
1. "diagram" — processes, architectures, pipelines, relationships, taxonomies, contribution maps. Lists of contributions/components/steps render as mermaid mindmap/flowchart, NOT a callout.
2. "table" — comparisons, parameters, ablations, datasets, baselines. Prefer 3-6 columns and 3-8 rows of substantive content.
3. "chart" — quantitative trends/comparisons. Include 8-15 realistic illustrative data points; mark them illustrative in the narration if inferred. ALWAYS populate xLabel and yLabel with descriptive axis labels including units (e.g. "Sequence length (tokens)", "Latency (ms)") — never leave axes unlabeled or generic. A single generic word (e.g. "Latency" alone, or "X"/"Y"/"Value"/"Metric") is NOT descriptive enough — pair it with a unit or a second word, e.g. "Latency (ms)", "Model size (params)".
4. "math" — formulas, losses, derivations, complexity, mathematical definitions. Each step is a KaTeX string (no $ delimiters).
5. "callout" — FORBIDDEN. Never return kind="callout". Slides must always contain a real visual asset (diagram, chart, table, or equations). If the topic only suggests a quote or one-line takeaway, promote it to a diagram (mindmap or flowchart) or table that decomposes the idea into concrete parts.

REQUESTED-KIND RULE (CRITICAL):
- Topic/hint mentions "math", "equation", "formula", "formalism", "derivation", "theorem" → MUST return kind="math" with real KaTeX steps.
- Mentions "diagram", "flow", "architecture", "pipeline", "graph", "topology", "tree" → MUST return kind="diagram" with valid mermaid.
- Mentions "chart", "plot", "trend" → MUST return kind="chart".
- Mentions "table", "matrix" → MUST return kind="table".
- NEVER substitute a callout when the user asked for one of the above.

NO-HEDGE RULE (CRITICAL):
- NEVER produce text like "the paper does not provide", "no explicit equations", "not enough information", "the text does not contain", "insufficient detail", or any meta-commentary about the paper's contents.
- If the paper excerpt lacks specifics, fall back to CANONICAL TEXTBOOK KNOWLEDGE of the topic (standard definitions, well-known equations, classical diagrams of the concept) and produce the visual from that. Note "illustrative" in the narration if needed, but DELIVER the visualization.
- Narration MUST describe concrete on-screen content. Never start narration with "Diagram:", "Chart:", "A summary of", "Overview of", or similar meta-labels.

QUALITY BAR:
- Add information beyond restating the title. No slides whose body is just "A summary of X".
- The topic/hint are instructions, not slide content; never render phrases like "A table comparing..." or "summarizing the..." as the visual body.
- Plural topics enumerate the actual items with substance.
- "narration" ≤20 words, references concrete content.
- "title" ≤60 chars, specific.

${MERMAID_DIAGRAM_GUIDE}

OUTPUT: Return a single JSON object. Populate ONLY the chosen kind's spec field. The "kind" field MUST match the populated spec. Respond with valid JSON only, no prose.`;

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
}

export interface IllustrateResult {
  visual: Visual;
  attempts: number;
  warnings: string[];
}

type GenerateTextLike = (args: Record<string, unknown>) => Promise<{
  experimental_output?: unknown;
  text?: string;
}>;

const EXPLICIT_CALLOUT_RE = /\b(quote|direct quote|definition sentence|definition|one[- ]line takeaway|single[- ]sentence takeaway|key takeaway)\b/i;
const GENERIC_VISUAL_HINT_RE = /^(chart|line chart|bar chart|area chart|scatter|math|formula|diagram|table|callout)$/i;
const HEDGE_RE = /\b(does not (provide|contain|include|describe|specify|mention)|not (enough|sufficient) (information|detail|context)|no (explicit|specific) (equations?|formulas?|diagrams?|details?|information)|the (paper|text|excerpt|document) (does not|doesn't|lacks)|insufficient (information|detail|context)|within the provided text|in the provided (text|excerpt))\b/i;
const META_NARRATION_RE = /^\s*(diagram|chart|table|math|formula|equation|illustration|figure|visualization)\s*:/i;
const PROMPT_LIKE_VISUAL_TEXT_RE = /^\s*(a\s+)?(chart|table|diagram|graph|math derivation|callout)\s+(comparing|summarizing|showing|illustrating|describing)\b|\bsummarizing the\b/i;

export function containsHedgeLanguage(text: string | undefined | null): boolean {
  if (!text) return false;
  return HEDGE_RE.test(text) || META_NARRATION_RE.test(text);
}

export function isPromptLikeVisualText(text: string | undefined | null): boolean {
  return Boolean(text && PROMPT_LIKE_VISUAL_TEXT_RE.test(text));
}

/**
 * Content-level checks shared by every generation path (Groq strict and the
 * legacy Gemini/Lovable loop), so a validation rule only has to be written
 * once and both providers get retried against the same bar. Structural
 * concerns (missing spec, invalid mermaid) and quality concerns (axis labels,
 * hedging, prompt-echoing) all return a precise reason string, which flows
 * straight into the "PREVIOUS ATTEMPT FAILED" retry correction.
 */
export function runContentValidations(visual: Visual): { ok: true } | { ok: false; reason: string } {
  const structural = validateVisual(visual);
  if (!structural.ok) return structural;

  if (visual.kind === "chart") {
    const axisCheck = validateAxisLabels(visual.chart);
    if (!axisCheck.ok) return axisCheck;
  }

  const hedgeSource = [visual.narration, visual.callout?.body].find((t) => containsHedgeLanguage(t));
  if (hedgeSource) {
    return {
      ok: false,
      reason: `output contained hedge/meta language ("${hedgeSource.slice(0, 120)}"). Re-generate with concrete content using canonical textbook knowledge if the paper lacks specifics. No meta-commentary about the paper's contents.`,
    };
  }

  const promptLikeSource = [visual.narration, visual.callout?.body].find((t) => isPromptLikeVisualText(t));
  if (promptLikeSource) {
    return {
      ok: false,
      reason: `output repeated the visualization prompt instead of rendering content ("${promptLikeSource.slice(0, 120)}"). Return concrete rows, equations, chart points, or mermaid nodes.`,
    };
  }

  return { ok: true };
}

const KIND_KEYWORDS: Array<{ kind: Visual["kind"]; re: RegExp }> = [
  { kind: "math", re: /\b(math|mathematic\w*|equation|formula|formalism|derivation|loss function|theorem|proof|complexity bound)\b/i },
  { kind: "table", re: /\b(table|matrix|comparison table)\b/i },
  { kind: "chart", re: /\b(chart|plot|trend|line chart|bar chart|scatter|histogram|curve)\b/i },
  { kind: "diagram", re: /\b(diagram|flowchart|flow chart|architecture|pipeline|topology|mindmap|sequence diagram|state machine|tree structure|expander graph|fat tree)\b/i },
];

export function detectRequestedKind(input: IllustrateInput): Visual["kind"] | null {
  const text = `${input.topic ?? ""} ${input.hint ?? ""}`;
  // Callouts are intentionally NOT detectable — we never produce text-only
  // slides, even when the user/agent asks for a quote or "key takeaway".
  // Such requests get promoted to a real visual by the model or the fallback.
  for (const { kind, re } of KIND_KEYWORDS) {
    if (re.test(text)) return kind;
  }
  return null;
}

// NOTE: Previous revisions defined `createFallbackVisual` / `hasRngContext` and
// returned hard-coded RNG / fat-tree / expander slides whenever the upstream
// model failed. That violated the "no hard-coded API workarounds" rule — it
// looked like the model was answering, when really we were serving canned
// content from regex matches on the prompt. The entire fallback family has
// been removed. If generation fails, `generateVisual` throws and the caller
// surfaces the error.

export function isBillingOrCreditError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b402\b|payment required|billing|credits? exhausted|insufficient credits|add credits/i.test(msg);
}

// ---------------------------------------------------------------------------
// Groq strict structured outputs path
//
// Groq's openai/gpt-oss-20b model supports response_format=json_schema with
// strict: true, which uses constrained decoding to GUARANTEE schema-valid JSON.
// We pre-select the visual kind from the request so the schema is a single
// concrete object (strict mode forbids optional fields / additionalProperties),
// and we stop burning retries on malformed JSON.
// ---------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type StrictKind = "diagram" | "table" | "math" | "chart";

// JSON Schemas built for strict mode (all fields required, additionalProperties: false).
const STRICT_KIND_SCHEMAS: Record<StrictKind, Record<string, unknown>> = {
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
      inline: { type: "string", description: "Optional one-line plain English summary; empty string is OK" },
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
      xLabel: { type: "string", description: "REQUIRED non-empty descriptive x-axis label, ideally with units, e.g. 'Sequence length (tokens)'. NEVER empty, NEVER 'X' or 'value'." },
      yLabel: { type: "string", description: "REQUIRED non-empty descriptive y-axis label, ideally with units, e.g. 'Latency (ms)'. NEVER empty, NEVER 'Y' or 'value'." },
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

function strictPayloadToVisual(kind: StrictKind, payload: unknown): Visual {
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

const STRICT_SYSTEM_PROMPT = `You are a scientific visualization generator for a live research-companion slide deck. Each turn you produce ONE slide that makes the user smarter about the paper. Bias hard toward STRUCTURED, INFORMATION-DENSE visuals — never a bare restatement of the topic.

The "kind" of slide has been pre-selected by the caller; fill the schema for that kind with concrete, substantive content.

NO-HEDGE RULE (CRITICAL):
- NEVER write text like "the paper does not provide", "no explicit equations", "not enough information", "the text does not contain", "insufficient detail", or any meta-commentary about the paper's contents.
- If the paper excerpt lacks specifics, fall back to CANONICAL TEXTBOOK KNOWLEDGE of the topic (standard definitions, well-known equations, classical diagrams) and produce the visual from that. Note "illustrative" in the narration if needed, but DELIVER the visualization.
- Narration MUST describe concrete on-screen content. Never start narration with "Diagram:", "Chart:", "A summary of", "Overview of", or similar meta-labels.

QUALITY BAR:
- Add information beyond restating the title.
- Plural topics enumerate the actual items with substance.
- "narration" ≤20 words, references concrete content.
- "title" ≤60 chars, specific.

JSON OUTPUT DISCIPLINE (CRITICAL — prevents validation failures):
- Keep every string TIGHT. Long strings full of backslashes blow past the token budget and produce truncated JSON that fails strict validation.
- Inside JSON strings, every backslash MUST be written as \\\\ (two source chars → one decoded backslash). Newlines MUST be written as \\n. No raw control characters in string values.

${MERMAID_DIAGRAM_GUIDE}

TABLE SHAPE (when kind=table): 3-6 columns, 3-8 rows of substantive content. Every row MUST have exactly the same number of cells as the columns array.

MATH SHAPE (when kind=math) — KATEX SKILL (study carefully):
- 3-5 steps MAXIMUM. Each step is ONE focused KaTeX expression, NOT a paragraph.
- Use proper LaTeX commands with backslashes: \\\\frac{a}{b}, \\\\sum_{i=1}^{n}, \\\\min_{x \\\\in S}, \\\\sqrt{x}, \\\\le, \\\\ge, \\\\approx, \\\\in, \\\\subseteq, \\\\setminus, \\\\cdot, \\\\lambda, \\\\alpha, \\\\bar{S}, \\\\mathbb{R}, \\\\mathcal{O}.
- Subscripts/superscripts use braces: x_{i}, n^{2}, \\\\lambda_{2}(G).
- Prefer PURE mathematical notation. AVOID \\\\text{...} blocks for prose — put English explanations in "narration" or the "inline" caption, NEVER inline inside the equations.
- Every command needs its backslashes: \\\\frac (not "frac"), \\\\setminus (not "setminus"), \\\\bar{S} (not "bar S").
- NO $ delimiters around expressions.
- "inline" is a short plain-English caption (or empty string), NOT more math.
- GOOD example (Cheeger constant), three steps:
    "h(G) = \\\\min_{S \\\\subseteq V,\\\\, 0 < |S| \\\\le |V|/2} \\\\frac{|E(S, \\\\bar{S})|}{|S|}"
    "\\\\lambda_{2}(G) \\\\le 2\\\\, h(G)"
    "h(G) \\\\ge \\\\frac{\\\\lambda_{2}(G)}{2}"
- BAD example (DO NOT emit): "\\\\text{For a }d\\\\text{-regular graph: }h(G) \\\\ge d - 2\\\\sqrt{d-1}" — strip the \\\\text wrappers, move prose to narration, keep step as "h(G) \\\\ge d - 2\\\\sqrt{d - 1}".

CHART SHAPE (when kind=chart):
- 8-15 realistic illustrative points per series.
- "xLabel" and "yLabel" are MANDATORY, non-empty, descriptive strings (e.g. "Sequence length (tokens)", "Latency (ms)"). NEVER leave them blank, NEVER use generic placeholders like "X" or "Y" or "value". Include units when applicable.
- A single generic word (e.g. "Latency" alone) is NOT enough — pair it with a unit or a second descriptive word: "Latency (ms)", "Model size (params)", "Training steps".
- The chart MUST be readable as a standalone figure: a viewer should understand what each axis measures from the labels alone.
- GOOD axis labels: "Sequence length (tokens)", "Throughput (req/s)", "Training loss", "Model size (params)".
- BAD axis labels (DO NOT emit): "X", "Y", "Value", "Axis", "Metric", "Data" — these are placeholders, not descriptions.`;

/** Pick the concrete kind to ask the strict-output model for. Never callout. */
export function pickStrictKind(input: IllustrateInput): StrictKind {
  const requested = detectRequestedKind(input);
  if (requested && requested !== "callout") return requested;
  const text = `${input.topic ?? ""} ${input.hint ?? ""}`;
  if (/\b(compare|comparison|versus|vs\.?|baseline|trade-?off|matrix)\b/i.test(text)) return "table";
  if (/\b(architecture|pipeline|flow|process|component|tree|graph|topology|mindmap)\b/i.test(text)) return "diagram";
  if (/\b(equation|formula|derivation|theorem|complexity)\b/i.test(text)) return "math";
  if (/\b(trend|plot|chart|curve|histogram)\b/i.test(text)) return "chart";
  return "diagram";
}

/**
 * Call Groq's strict structured-output endpoint once. Returns whatever Visual
 * the schema-constrained decode produced — transport/parse failures throw,
 * but content-level correctness (valid mermaid, real axis labels, no hedging)
 * is NOT checked here. That's the caller's job via `runContentValidations`,
 * so both the Groq and legacy paths retry against exactly the same bar.
 */
export async function generateVisualGroqStrict(
  input: IllustrateInput,
  opts: {
    apiKey: string;
    kind?: StrictKind;
    model?: string;
    fetchImpl?: FetchLike;
    recentBlock?: string;
    correction?: string;
    temperature?: number;
  },
): Promise<Visual> {
  const kind = opts.kind ?? pickStrictKind(input);
  const schema = STRICT_KIND_SCHEMAS[kind];
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch.bind(globalThis) as FetchLike);
  const model = opts.model ?? GROQ_MODELS.structured;
  const temperature = opts.temperature ?? 0.5;

  const userPrompt = `Topic: ${input.topic}
${input.hint ? `Hint: ${input.hint}\n` : ""}${input.pdfExcerpt ? `Paper context (excerpt):\n${input.pdfExcerpt.slice(0, 8000)}\n` : ""}${opts.recentBlock ?? ""}
Kind pre-selected by caller: ${kind}.
Produce the JSON object for this kind with concrete, information-dense content.${opts.correction ?? ""}`;

  const body = {
    model,
    messages: [
      { role: "system", content: STRICT_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: `visual_${kind}`,
        strict: true,
        schema,
      },
    },
    temperature,
    // Default Groq max_tokens is small (~1024) and routinely truncates
    // math/diagram strings full of backslashes, which then fail strict-mode
    // JSON validation with an empty `failed_generation`. Give the model
    // headroom for fully-escaped KaTeX and multi-line mermaid sources.
    max_tokens: 8192,
  };


  const res = await fetchImpl(`${GROQ_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Groq strict call failed: ${res.status} ${res.statusText} ${text.slice(0, 400)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content ?? "";
  if (!content) throw new Error("Groq strict call returned empty content");
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `Groq strict call returned non-JSON content despite strict mode: ${(err as Error).message}. Content head: ${content.slice(0, 200)}`,
    );
  }
  return strictPayloadToVisual(kind, payload);
}


// Temperature ladder for Groq strict-mode retries. Groq only has one
// structured-output-capable model (openai/gpt-oss-20b), so instead of
// escalating models like the legacy path does, we escalate down toward
// more deterministic output — keeping `strict: true` on every attempt.
const GROQ_STRICT_TEMPERATURES = [0.5, 0.2, 0.0];

export async function generateVisual(
  input: IllustrateInput,
  opts: {
    apiKey?: string;
    env?: AiProviderEnv;
    resolvedProvider?: ResolvedAiProvider;
    maxAttempts?: number;
    generateTextImpl?: GenerateTextLike;
    fetchImpl?: FetchLike;
  } = {},
): Promise<IllustrateResult> {

  const env = opts.env ?? {
    groqApiKey: process.env.GROQ_API_KEY,
    lovableApiKey: opts.apiKey || process.env.LOVABLE_API_KEY,
  };
  let resolved: ResolvedAiProvider;
  try {
    resolved = opts.resolvedProvider ?? resolveAiProvider(env);
  } catch (err) {
    // Surface the real reason — silently rendering a stub was hiding outages.
    throw err instanceof Error ? err : new Error(String(err));
  }

  const warnings: string[] = [];
  let lastError = "";

  const recent = (input.recentVisuals ?? []).slice(0, 6);
  const recentBlock = recent.length
    ? `\nSlides already on the canvas (newest first) — DO NOT repeat any of these titles, and pick a DIFFERENT "kind" than the most recent one unless the user explicitly asked for the same kind:\n${recent
        .map((r, i) => `${i + 1}. ${r.kind}: ${r.title}`)
        .join("\n")}\n`
    : "";

  // FAST PATH: Groq strict structured outputs. Constrained decoding guarantees
  // schema-valid JSON on every attempt; a self-correction retry loop here
  // catches the remaining content-level failures (invalid mermaid, missing
  // axis labels, hedge language) and re-prompts with the specific reason,
  // same contract as the legacy loop below.
  // Skipped if the caller injected a generateTextImpl (legacy test path) or
  // if there's no Groq key.
  const useGroqStrict = resolved.source === "groq" && Boolean(env.groqApiKey) && !opts.generateTextImpl;
  if (useGroqStrict) {
    const kind = pickStrictKind(input);
    const maxAttempts = opts.maxAttempts ?? 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const temperature =
        GROQ_STRICT_TEMPERATURES[Math.min(attempt - 1, GROQ_STRICT_TEMPERATURES.length - 1)];
      const correction = lastError
        ? `\n\nPREVIOUS ATTEMPT FAILED: ${lastError}\nReturn a corrected, complete JSON object that matches the schema exactly.`
        : "";
      try {
        const visual = await generateVisualGroqStrict(input, {
          apiKey: env.groqApiKey!,
          kind,
          fetchImpl: opts.fetchImpl,
          recentBlock,
          correction,
          temperature,
        });
        const check = runContentValidations(visual);
        if (!check.ok) {
          lastError = check.reason;
          warnings.push(`attempt ${attempt} (groq strict/${kind}): ${check.reason}`);
          continue;
        }
        return { visual, attempts: attempt, warnings };
      } catch (err) {
        if (isBillingOrCreditError(err)) {
          throw new Error(
            `Groq rejected the request as unpaid/credits exhausted. Add credits or switch providers. (${err instanceof Error ? err.message : String(err)})`,
          );
        }
        const msg = err instanceof Error ? err.message : String(err);
        lastError = msg;
        warnings.push(`attempt ${attempt} (groq strict/${kind}): ${msg}`);
      }
    }
    throw new Error(
      `Failed to generate a valid visual after ${maxAttempts} attempts via Groq strict mode (kind=${kind}). Last error: ${lastError || "unknown"}. Warnings: ${warnings.join(" | ")}`,
    );
  }

  const maxAttempts = opts.maxAttempts ?? 4;
  const runGenerateText = (opts.generateTextImpl ?? generateText) as GenerateTextLike;

  const models =
    resolved.source === "groq"
      ? [GROQ_MODELS.fast]
      : ["google/gemini-3-flash-preview", "google/gemini-2.5-flash", "google/gemini-2.5-pro"];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const modelId = models[Math.min(attempt - 1, models.length - 1)];
    const model = resolved.provider(modelId);
    const correction = lastError
      ? `\n\nPREVIOUS ATTEMPT FAILED: ${lastError}\nReturn a corrected, complete JSON object that matches the schema exactly.`
      : "";
    const prompt = `Topic: ${input.topic}
${input.hint ? `Hint: ${input.hint}\n` : ""}${input.pdfExcerpt ? `Paper context (excerpt):\n${input.pdfExcerpt.slice(0, 8000)}\n` : ""}${recentBlock}${correction}`;

    try {
      const { experimental_output: rawOut, text } = await runGenerateText({
        model,
        experimental_output: Output.object({ schema: LooseVisualSchema }),
        system: SYSTEM_PROMPT,
        prompt,
      });
      let loose: z.infer<typeof LooseVisualSchema> | undefined;
      const generated = LooseVisualSchema.safeParse(rawOut);
      if (generated.success) loose = generated.data;
      if (!loose && text) {
        // generateText didn't parse — try to recover from raw text.
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = LooseVisualSchema.safeParse(JSON.parse(match[0]));
          if (parsed.success) loose = parsed.data;
        }
      }
      if (!loose) {
        lastError = "model returned no parseable JSON object";
        warnings.push(`attempt ${attempt} (${modelId}): ${lastError}`);
        continue;
      }
      const normalized = normalizeLoose(loose, {
        title: input.topic,
        narration: input.hint ?? `Visualization of ${input.topic}`,
      });
      if (!normalized.ok) {
        lastError = normalized.reason;
        warnings.push(`attempt ${attempt} (${modelId}): ${normalized.reason}`);
        continue;
      }
      if (normalized.visual.kind === "callout") {
        lastError = `kind="callout" is forbidden — slides must always carry a real visual asset. Return kind="diagram" (mindmap or flowchart), "table", "chart", or "math" with concrete on-screen content.`;
        warnings.push(`attempt ${attempt} (${modelId}): rejected callout (text-only slide)`);
        continue;
      }
      const requestedKind = detectRequestedKind(input);
      if (requestedKind && requestedKind !== "callout" && normalized.visual.kind !== requestedKind) {
        lastError = `requested kind="${requestedKind}" but model returned kind="${normalized.visual.kind}". Re-generate as ${requestedKind} using canonical textbook knowledge if the paper lacks specifics.`;
        warnings.push(`attempt ${attempt} (${modelId}): ${lastError}`);
        continue;
      }
      const check = runContentValidations(normalized.visual);
      if (!check.ok) {
        lastError = check.reason;
        warnings.push(`attempt ${attempt} (${modelId}): ${check.reason}`);
        continue;
      }
      return { visual: normalized.visual, attempts: attempt, warnings };
    } catch (err) {
      const msg =
        err instanceof NoObjectGeneratedError
          ? `model returned non-conforming JSON (${err.message}). Raw text: ${(err.text ?? "").slice(0, 400)}`
          : err instanceof Error
            ? err.message
            : "unknown generation error";
      if (isBillingOrCreditError(err)) {
        // Surface visibly — silent stubs were hiding real outages.
        throw new Error(
          `${resolved.source === "groq" ? "Groq" : "Lovable AI"} rejected the request as unpaid/credits exhausted. Add credits or switch providers. (${msg})`,
        );
      }
      lastError = msg;
      warnings.push(`attempt ${attempt} (${modelId}): ${msg}`);
    }
  }

  throw new Error(
    `Failed to generate a valid visual after ${maxAttempts} attempts via ${resolved.source}. Last error: ${lastError || "unknown"}. Warnings: ${warnings.join(" | ")}`,
  );
}
