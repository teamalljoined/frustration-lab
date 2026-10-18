// All timestamps are epoch milliseconds with sub-ms precision
// (performance.timeOrigin + performance.now()), so they can be aligned
// with EEG / eye-tracker / screen-recording clocks.

import type { TurnMode } from "./styles";

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
  stroke?: string; // holds made in one press-and-drag share a stroke id
  phase?: "chunk" | "review"; // labeled right after reading a chunk, or in the final review
  chunk?: number;
}

/**
 * A short piece of a reply, shown all at once. The participant reads it with
 * hands still (shownAt → readAt is a clean EEG window), presses Space, then
 * labels it (readAt → labeledAt).
 */
export interface Chunk {
  i: number;
  start: number; // first word index
  end: number; // exclusive
  shownAt: number | null;
  readAt: number | null;
  labeledAt: number | null;
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
  style?: TurnMode; // hidden assistant behavior for this reply (ground truth)
  model: string;
  assistantRaw: string; // what the model actually returned
  words: Word[]; // what the participant saw (raw + any injected word)
  streamStart: number;
  streamEnd: number | null;
  error?: string;
  chunks?: Chunk[];
  holds: Hold[];
  nothingNotable: boolean;
  labelSubmittedAt: number | null;
  wordRects?: { at: number; rects: WordRect[] }[];
}

export type LogEvent =
  | { t: number; type: "scroll"; scrollY: number }
  | { t: number; type: "resize"; w: number; h: number }
  | { t: number; type: "focus" | "blur" }
  | { t: number; type: "keydown"; turn: number; len: number }
  // Browser window placement, so screen-space gaze can be mapped to the page.
  | { t: number; type: "window"; sx: number; sy: number; ow: number; oh: number; iw: number; ih: number; dpr: number };

/** A gaze fixation resolved to a word (or a word-onset proxy when no gaze). */
export interface Fixation {
  turn: number;
  wordIndex: number;
  start: number;
  end: number;
}

export interface Condition {
  model: string;
  systemPrompt: string;
  injectEvery: number; // 0 = off; inject an out-of-place word every N turns
  swapEvery: number; // 0 = off; silently swap the user's prompt every N turns
  behavior?: "normal" | "frustration"; // frustration: mostly annoying replies, some great ones
  helpfulRate?: number; // frustration mode: chance a reply is genuinely helpful
  tactics?: string[]; // frustration mode: enabled tactic ids
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
  // Imported after the session (EEG-derived scalar, gaze resolved to words).
  signal?: { t: number; v: number }[];
  signalSource?: string;
  fixations?: Fixation[];
  gazeSource?: string;
  synthetic?: boolean; // demo data, not a real recording
  /** @deprecated older sessions stored the imported series here */
  predicted?: { t: number; v: number }[];
}
