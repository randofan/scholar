import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type CanvasItemKind = "chart" | "math" | "diagram" | "table" | "callout";

export interface ChartSpec {
  chartType: "line" | "bar" | "area" | "scatter";
  xKey: string;
  yKeys: string[];
  data: Record<string, number | string>[];
  xLabel?: string;
  yLabel?: string;
}

export interface MathSpec {
  // KaTeX strings, one per line of derivation
  steps: string[];
  inline?: string;
}

export interface DiagramSpec {
  // mermaid source
  mermaid: string;
}

export interface TableSpec {
  columns: string[];
  rows: (string | number)[][];
}

export interface CalloutSpec {
  body: string;
  tone?: "info" | "warn" | "key";
}

export type CanvasSpec =
  | { kind: "chart"; spec: ChartSpec }
  | { kind: "math"; spec: MathSpec }
  | { kind: "diagram"; spec: DiagramSpec }
  | { kind: "table"; spec: TableSpec }
  | { kind: "callout"; spec: CalloutSpec };

export interface CanvasItem {
  id: string;
  title: string;
  narration: string;
  createdAt: number;
  status: "pending" | "ready" | "error";
  error?: string;
  payload?: CanvasSpec;
  /**
   * Original visualize request, kept so a render failure can regenerate the
   * slide. Includes `facts` because the on-device model has no other source of
   * paper content — regenerating without it would produce a generic slide.
   */
  request?: { topic: string; kind?: CanvasItemKind; hint?: string; facts?: string };
  /** How many times this slide has been regenerated after a browser render failure. */
  renderRetries?: number;
}

export interface ResearchCitation {
  title: string;
  url: string;
  snippet?: string;
}

export interface ResearchItem {
  id: string;
  query: string;
  status: "pending" | "ready" | "error";
  summary?: string;
  citations?: ResearchCitation[];
  createdAt: number;
  error?: string;
}

export interface TranscriptEntry {
  id: string;
  role: "user" | "agent" | "system";
  text: string;
  ts: number;
}

/** A generation-failure reason, tagged with the visual kind that produced it. */
export interface Lesson {
  kind: CanvasItemKind;
  text: string;
}

interface PdfState {
  name: string;
  text: string;
  pages: number;
  charCount: number;
}

interface ScholarState {
  pdf: PdfState | null;
  setPdf: (pdf: PdfState | null) => void;

  canvasItems: CanvasItem[];
  upsertCanvas: (item: CanvasItem) => void;
  patchCanvas: (id: string, patch: Partial<CanvasItem>) => void;

  researchItems: ResearchItem[];
  upsertResearch: (item: ResearchItem) => void;
  patchResearch: (id: string, patch: Partial<ResearchItem>) => void;

  transcript: TranscriptEntry[];
  appendTranscript: (entry: TranscriptEntry) => void;

  /**
   * Session-scoped "lessons" — distilled generation-failure reasons (validator
   * rejections, browser render errors) that get replayed into subsequent
   * visualize requests so the generator stops repeating the same mistake.
   * Deduped, capped, and tagged with the visual kind that produced them, since
   * the persistent skill files are per-kind (a mermaid rule is noise in a
   * table prompt).
   */
  lessons: Lesson[];
  addLesson: (kind: CanvasItemKind, lesson: string) => void;
  /** How many of `lessons` have already been distilled into the persistent skill files. */
  distilledLessonCount: number;
  markLessonsDistilled: (count: number) => void;

  reset: () => void;
}

const MAX_LESSONS = 8;

const createMemoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
};

export const useScholarStore = create<ScholarState>()(
  persist(
    (set) => ({
      pdf: null,
      setPdf: (pdf) => set({ pdf }),

      canvasItems: [],
      upsertCanvas: (item) =>
        set((s) => {
          const idx = s.canvasItems.findIndex((c) => c.id === item.id);
          if (idx >= 0) {
            const next = [...s.canvasItems];
            next[idx] = item;
            return { canvasItems: next };
          }
          return { canvasItems: [item, ...s.canvasItems] };
        }),
      patchCanvas: (id, patch) =>
        set((s) => ({
          canvasItems: s.canvasItems.map((c) => (c.id === id ? { ...c, ...patch } : c)),
        })),

      researchItems: [],
      upsertResearch: (item) =>
        set((s) => {
          const idx = s.researchItems.findIndex((c) => c.id === item.id);
          if (idx >= 0) {
            const next = [...s.researchItems];
            next[idx] = item;
            return { researchItems: next };
          }
          return { researchItems: [item, ...s.researchItems] };
        }),
      patchResearch: (id, patch) =>
        set((s) => ({
          researchItems: s.researchItems.map((c) => (c.id === id ? { ...c, ...patch } : c)),
        })),

      transcript: [],
      appendTranscript: (entry) =>
        set((s) => ({ transcript: [...s.transcript, entry].slice(-200) })),

      lessons: [],
      addLesson: (kind, lesson) =>
        set((s) => {
          const text = lesson.replace(/\s+/g, " ").trim().slice(0, 200);
          if (!text) return {};
          // Dedupe within a kind — the same reason from a different format is
          // a genuinely different lesson and belongs in that kind's skill file.
          if (s.lessons.some((l) => l.kind === kind && l.text === text)) return {};
          return { lessons: [...s.lessons, { kind, text }].slice(-MAX_LESSONS) };
        }),
      distilledLessonCount: 0,
      markLessonsDistilled: (count) => set({ distilledLessonCount: count }),

      reset: () =>
        set({
          pdf: null,
          canvasItems: [],
          researchItems: [],
          transcript: [],
          lessons: [],
          distilledLessonCount: 0,
        }),
    }),
    {
      name: "scholar-store",
      storage: createJSONStorage(() =>
        typeof window !== "undefined" ? window.sessionStorage : createMemoryStorage(),
      ),
      partialize: (s) => ({
        pdf: s.pdf,
        lessons: s.lessons,
        distilledLessonCount: s.distilledLessonCount,
      }),
    },
  ),
);
