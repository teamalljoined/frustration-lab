import type { Fixation, LogEvent, Session, WordRect } from "./types";
import { wordScores } from "./heat";

export type Series = { t: number; v: number }[];
export type GazeSample = { t: number; x: number; y: number };
export type GazeCoords = "viewport" | "screen";

/**
 * Parse JSON (array of objects) or CSV with a header row. Times below 1e11 are
 * treated as seconds from `t0`; otherwise as epoch ms.
 */
export function parseRows(text: string, t0: number): Record<string, number>[] {
  const trimmed = text.trim();
  let rows: Record<string, number>[];
  if (trimmed.startsWith("[")) {
    rows = JSON.parse(trimmed);
  } else {
    const [head, ...lines] = trimmed.split(/\r?\n/);
    const cols = head.split(/[,\t]/).map((c) => c.trim().toLowerCase());
    rows = lines.filter(Boolean).map((l) => {
      const vals = l.split(/[,\t]/).map(Number);
      return Object.fromEntries(cols.map((c, i) => [c, vals[i]]));
    });
  }
  return rows
    .filter((r) => Number.isFinite(r.t))
    .map((r) => ({ ...r, t: r.t < 1e11 ? t0 + r.t * 1000 : r.t }))
    .sort((a, b) => a.t - b.t);
}

/** Last event of a type at or before t (events are appended in time order). */
function lastBefore<T extends LogEvent["type"]>(s: Session, type: T, t: number) {
  let found: Extract<LogEvent, { type: T }> | undefined;
  for (const e of s.events) {
    if (e.t > t) break;
    if (e.type === type) found = e as Extract<LogEvent, { type: T }>;
  }
  return found;
}

export const scrollAt = (s: Session, t: number) => lastBefore(s, "scroll", t)?.scrollY ?? 0;

/**
 * Word boxes per turn. Chunks are revealed one at a time, so each word takes
 * its box from the first snapshot that contains it (text above never moves).
 */
function wordBoxes(s: Session) {
  return s.turns.map((t) => {
    const byWord = new Map<number, WordRect>();
    for (const snap of t.wordRects ?? []) for (const r of snap.rects) if (!byWord.has(r.i)) byWord.set(r.i, r);
    return [...byWord.values()];
  });
}

const PAD = 4; // px tolerance around a word box

function hitWord(boxes: WordRect[][], s: Session, t: number, docX: number, docY: number) {
  for (let ti = 0; ti < boxes.length; ti++) {
    const turn = s.turns[ti];
    if (turn.submittedAt > t) break;
    for (const r of boxes[ti]) {
      if (turn.words[r.i] && turn.words[r.i].shownAt > t) continue;
      if (docX >= r.x - PAD && docX <= r.x + r.w + PAD && docY >= r.y - PAD && docY <= r.y + r.h + PAD) {
        return { turn: ti, wordIndex: r.i };
      }
    }
  }
  return null;
}

/**
 * Resolve gaze samples to words and merge consecutive hits into fixations.
 * Screen coordinates are converted with the logged window placement
 * (content area assumed to sit at the bottom of the window frame).
 */
export function gazeToFixations(s: Session, samples: GazeSample[], coords: GazeCoords, minMs = 60): Fixation[] {
  const boxes = wordBoxes(s);
  const out: Fixation[] = [];
  let cur: Fixation | null = null;
  for (const g of samples) {
    let vx = g.x, vy = g.y;
    if (coords === "screen") {
      const w = lastBefore(s, "window", g.t) ?? s.events.find((e) => e.type === "window");
      if (w && w.type === "window") {
        vx = g.x - w.sx - (w.ow - w.iw) / 2;
        vy = g.y - w.sy - (w.oh - w.ih);
      }
    }
    const hit = hitWord(boxes, s, g.t, vx, vy + scrollAt(s, g.t));
    if (cur && hit && hit.turn === cur.turn && hit.wordIndex === cur.wordIndex) {
      cur.end = g.t;
      continue;
    }
    if (cur && cur.end - cur.start >= minMs) out.push(cur);
    cur = hit ? { ...hit, start: g.t, end: g.t } : null;
  }
  if (cur && cur.end - cur.start >= minMs) out.push(cur);
  return out;
}

/** Fallback when no gaze is available: each word "fixated" for 250 ms at onset. */
export function onsetFixations(s: Session): Fixation[] {
  return s.turns.flatMap((t) => t.words.map((w) => ({ turn: t.index, wordIndex: w.i, start: w.shownAt, end: w.shownAt + 250 })));
}

/** Linear interpolation; NaN outside the series. */
export function signalAt(series: Series, t: number) {
  if (!series.length || t < series[0].t || t > series[series.length - 1].t) return NaN;
  let lo = 0, hi = series.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = series[lo], b = series[hi];
  return b.t === a.t ? a.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
}

/** Mean signal over [start, end] shifted by lag (EEG responds after the eyes land). */
export function meanSignal(series: Series, start: number, end: number, lagMs: number) {
  const n = Math.max(2, Math.ceil((end - start) / 20));
  let sum = 0, k = 0;
  for (let i = 0; i < n; i++) {
    const v = signalAt(series, start + lagMs + ((end - start) * i) / (n - 1));
    if (!Number.isNaN(v)) { sum += v; k++; }
  }
  return k ? sum / k : NaN;
}

export interface WordStat {
  turn: number;
  wordIndex: number;
  word: string;
  label: number; // net label in [-1, 1]
  fixations: Fixation[];
  dwellMs: number;
  meanSignal: number;
}

/** Per-word dwell + signal, for every word that was labeled or fixated. */
export function wordStats(s: Session, fixations: Fixation[], series: Series, lagMs: number): WordStat[] {
  const nets = s.turns.map((t) => wordScores(t.holds, t.words.length).net);
  const map = new Map<string, WordStat>();
  const get = (turn: number, wi: number) => {
    const key = `${turn}:${wi}`;
    let st = map.get(key);
    if (!st) {
      st = { turn, wordIndex: wi, word: s.turns[turn]?.words[wi]?.text ?? "", label: nets[turn]?.[wi] ?? 0, fixations: [], dwellMs: 0, meanSignal: NaN };
      map.set(key, st);
    }
    return st;
  };
  for (const f of fixations) {
    const st = get(f.turn, f.wordIndex);
    st.fixations.push(f);
    st.dwellMs += f.end - f.start;
  }
  nets.forEach((net, ti) => net.forEach((v, wi) => { if (Math.abs(v) >= 0.01) get(ti, wi); }));
  for (const st of map.values()) {
    const vals = st.fixations.map((f) => meanSignal(series, f.start, f.end, lagMs)).filter((v) => !Number.isNaN(v));
    st.meanSignal = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
  }
  return [...map.values()];
}

/** Mean signal on fixations grouped by the fixated word's label. */
export function groupMeans(stats: WordStat[]) {
  const groups = { disliked: [] as number[], neutral: [] as number[], liked: [] as number[] };
  for (const st of stats) {
    if (Number.isNaN(st.meanSignal)) continue;
    const g = st.label <= -0.01 ? "disliked" : st.label >= 0.01 ? "liked" : "neutral";
    groups[g].push(st.meanSignal);
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  return {
    disliked: { n: groups.disliked.length, mean: mean(groups.disliked) },
    neutral: { n: groups.neutral.length, mean: mean(groups.neutral) },
    liked: { n: groups.liked.length, mean: mean(groups.liked) },
  };
}

/**
 * SYNTHETIC demo data: gaze that reads each reply left-to-right as it streams,
 * and a noisy signal that bumps ~300 ms after fixating a disliked word.
 * For trying the replay view only — never mix with real recordings.
 */
export function syntheticData(s: Session) {
  const nets = s.turns.map((t) => wordScores(t.holds, t.words.length).net);
  const fixations: Fixation[] = [];
  for (const t of s.turns) {
    let clock = t.streamStart + 300;
    for (const w of t.words) {
      const start = Math.max(clock, w.shownAt + 40);
      const dur = 180 + Math.random() * 120 + (nets[t.index][w.i] < 0 ? 250 : 0);
      fixations.push({ turn: t.index, wordIndex: w.i, start, end: start + dur });
      clock = start + dur + 30;
    }
  }
  const lo = Math.min(...fixations.map((f) => f.start)) - 2000;
  const hi = Math.max(...fixations.map((f) => f.end), s.endedAt ?? 0) + 2000;
  const signal: Series = [];
  // Slow drift + small jitter, roughly what a smoothed EEG-derived index looks like.
  let drift = 0, jitter = 0;
  for (let t = lo; t <= hi; t += 20) {
    drift = drift * 0.998 + (Math.random() - 0.5) * 0.004;
    jitter = jitter * 0.8 + (Math.random() - 0.5) * 0.006;
    const noise = drift + jitter;
    let v = 0.12 + noise;
    for (const f of fixations) {
      const net = nets[f.turn][f.wordIndex];
      if (net >= 0) continue;
      const d = t - (f.start + 300);
      if (d > -200 && d < 1500) v += -net * 0.6 * Math.exp(-((d - 200) ** 2) / (2 * 250 ** 2));
    }
    signal.push({ t, v: Math.max(0, Math.min(1, v)) });
  }
  return { fixations, signal };
}
