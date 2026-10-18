// All timestamps are epoch milliseconds with sub-ms precision
// (performance.timeOrigin + performance.now()), so they can be aligned
// with EEG / eye-tracker / screen-recording clocks.

export type Valence = -1 | 1; // -1 = dislike (left-hold), +1 = like (right-hold)

export interface Word {
  i: number; // index within the displayed message
  text: string; // includes trailing punctuation, e.g. "misunderstanding."
  para: number; // paragraph index (for rendering line breaks)
  shownAt: number; // first time the word was rendered on screen
  injected?: boolean; // ground-truth perturbation: this word does not belong
}

export interface Hold {
  id: string;
  turn: number;
  wordIndex: number;
  word: string;
  valence: Valence;
  start: number;
  end: number;
  durationMs: number;
  intensity: number; // 0..1, derived from duration
}

export type Perturbation =
  | { kind: "none" }
  | { kind: "inject_word"; word: string; targetIndex: number }
  | { kind: "swap_prompt"; sentPrompt: string };

export interface WordRect {
  i: number;
  x: number; // document coordinates (add scrollY offset from scroll log to get viewport)
  y: number;
  w: number;
  h: number;
}

export interface Turn {
  index: number;
  userText: string;
  typingStart: number | null;
  submittedAt: number;
  perturbation: Perturbation;
  model: string;
  assistantRaw: string; // what the model actually returned
  words: Word[]; // what the participant saw (raw + any injected word)
  streamStart: number;
  streamEnd: number | null;
  error?: string;
  holds: Hold[];
  nothingNotable: boolean;
  labelSubmittedAt: number | null;
  wordRects?: { at: number; rects: WordRect[] }[];
}

export type LogEvent =
  | { t: number; type: "scroll"; scrollY: number }
  | { t: number; type: "resize"; w: number; h: number }
  | { t: number; type: "focus" | "blur" }
  | { t: number; type: "keydown"; turn: number; len: number };

export interface Condition {
  model: string;
  systemPrompt: string;
  injectEvery: number; // 0 = off; inject an out-of-place word every N turns
  swapEvery: number; // 0 = off; silently swap the user's prompt every N turns
}

export interface Session {
  id: string;
  participant: string;
  createdAt: number;
  endedAt: number | null;
  condition: Condition;
  turns: Turn[];
  events: LogEvent[];
  viewport: { w: number; h: number; dpr: number };
  // Optional externally predicted frustration series (e.g. from eye-tracking model)
  predicted?: { t: number; v: number }[];
}
