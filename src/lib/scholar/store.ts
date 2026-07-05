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
  /** Original visualize request, kept so a render failure can regenerate the slide. */
  request?: { topic: string; hint?: string };
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
   * rejections, browser render errors) that get replayed into every visualize
   * request so the generator stops repeating the same mistake. Deduped, capped.
   */
  lessons: string[];
  addLesson: (lesson: string) => void;

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
      addLesson: (lesson) =>
        set((s) => {
          const normalized = lesson.replace(/\s+/g, " ").trim().slice(0, 200);
          if (!normalized || s.lessons.includes(normalized)) return {};
          return { lessons: [...s.lessons, normalized].slice(-MAX_LESSONS) };
        }),

      reset: () =>
        set({ pdf: null, canvasItems: [], researchItems: [], transcript: [], lessons: [] }),
    }),
    {
      name: "scholar-store",
      storage: createJSONStorage(() =>
        typeof window !== "undefined" ? window.sessionStorage : createMemoryStorage(),
      ),
      partialize: (s) => ({ pdf: s.pdf, lessons: s.lessons }),
    },
  ),
);

