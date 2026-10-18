import { intensityFromMs } from "./store";
import type { Hold, Session, Turn } from "./types";

const DECAY_MS = 4000;

/** Contribution of one hold at time t: ramps while held, decays after release. */
export function holdAt(h: Hold, t: number) {
  if (t < h.start) return 0;
  if (t <= h.end) return intensityFromMs(t - h.start);
  return h.intensity * Math.exp(-(t - h.end) / DECAY_MS);
}

export function sessionBounds(s: Session) {
  const t0 = s.turns[0]?.submittedAt ?? s.createdAt;
  const lastTurn = s.turns[s.turns.length - 1];
  const t1 = Math.max(
    t0 + 1000,
    s.endedAt ?? 0,
    lastTurn?.labelSubmittedAt ?? 0,
    lastTurn?.streamEnd ?? 0,
    ...s.turns.flatMap((t) => t.holds.map((h) => h.end + DECAY_MS)),
  );
  return { t0: t0 - 1000, t1 };
}

export const allHolds = (s: Session) => s.turns.flatMap((t) => t.holds);

/**
 * Frustration index derived from labels: negative holds push it up, positive
 * holds pull it down. A predicted series (eye-tracking model) overrides this.
 */
export function frustrationSeries(s: Session, n = 600) {
  if (s.predicted?.length) return s.predicted;
  const { t0, t1 } = sessionBounds(s);
  const holds = allHolds(s);
  const out: { t: number; v: number }[] = [];
  for (let k = 0; k < n; k++) {
    const t = t0 + ((t1 - t0) * k) / (n - 1);
    let v = 0;
    for (const h of holds) v += (h.valence < 0 ? 1 : -0.5) * holdAt(h, t);
    out.push({ t, v: Math.max(0, Math.min(1, v)) });
  }
  return out;
}

export function turnBands(s: Session) {
  return s.turns.map((t) => ({
    label: `T${t.index + 1}`,
    start: t.submittedAt,
    end: t.labelSubmittedAt ?? t.streamEnd ?? t.submittedAt,
  }));
}

export const displayedText = (t: Turn) => t.words.map((w) => w.text).join(" ");

/** Merge adjacent same-valence word labels into spans. */
export function spans(t: Turn) {
  const byWord = new Map<number, { valence: number; intensity: number; holds: Hold[] }>();
  for (const h of t.holds) {
    const cur = byWord.get(h.wordIndex) ?? { valence: 0, intensity: 0, holds: [] };
    cur.valence += h.valence * h.intensity;
    cur.holds.push(h);
    cur.intensity = Math.min(1, cur.holds.reduce((a, x) => a + x.intensity, 0));
    byWord.set(h.wordIndex, cur);
  }
  const idx = [...byWord.keys()].sort((a, b) => a - b);
  const out: {
    start_word: number; end_word: number; text: string; valence: -1 | 1; intensity: number;
    hold_start: number; hold_end: number; n_holds: number;
  }[] = [];
  for (const i of idx) {
    const w = byWord.get(i)!;
    const valence = w.valence < 0 ? -1 : 1;
    const prev = out[out.length - 1];
    const hs = Math.min(...w.holds.map((h) => h.start));
    const he = Math.max(...w.holds.map((h) => h.end));
    if (prev && prev.end_word === i - 1 && prev.valence === valence) {
      prev.end_word = i;
      prev.intensity = Math.max(prev.intensity, w.intensity);
      prev.hold_start = Math.min(prev.hold_start, hs);
      prev.hold_end = Math.max(prev.hold_end, he);
      prev.n_holds += w.holds.length;
    } else {
      out.push({ start_word: i, end_word: i, text: "", valence, intensity: w.intensity, hold_start: hs, hold_end: he, n_holds: w.holds.length });
    }
  }
  for (const sp of out) sp.text = t.words.slice(sp.start_word, sp.end_word + 1).map((w) => w.text).join(" ");
  return out;
}

/** One JSONL record per labeled turn — the RLHF-facing format. */
export function rlhfRecords(s: Session) {
  return s.turns
    .filter((t) => t.labelSubmittedAt !== null)
    .map((t) => ({
      session_id: s.id,
      participant: s.participant,
      turn: t.index,
      model: t.model,
      context: s.turns.slice(0, t.index).flatMap((p) => [
        { role: "user", content: p.userText },
        { role: "assistant", content: displayedText(p) },
      ]),
      prompt_shown: t.userText,
      prompt_sent: t.perturbation.kind === "swap_prompt" ? t.perturbation.sentPrompt : t.userText,
      response: displayedText(t),
      response_raw: t.assistantRaw,
      words: t.words.map((w) => ({ i: w.i, text: w.text, shown_at: w.shownAt })),
      spans: spans(t),
      word_reward: wordReward(t),
      nothing_notable: t.nothingNotable,
      perturbation: t.perturbation,
      timing: { submitted_at: t.submittedAt, stream_start: t.streamStart, stream_end: t.streamEnd, label_submitted_at: t.labelSubmittedAt },
    }));
}

/** Dense per-word reward in [-1, 1]: positive intensity minus negative intensity. */
export function wordReward(t: Turn) {
  const r = new Array(t.words.length).fill(0);
  for (const h of t.holds) if (h.wordIndex < r.length) r[h.wordIndex] += h.valence * h.intensity;
  return r.map((v) => Math.max(-1, Math.min(1, +v.toFixed(3))));
}

/** Label-quality evals against hidden ground-truth perturbations. */
export function groundTruthEvals(sessions: Session[]) {
  const turns = sessions.flatMap((s) => s.turns.filter((t) => t.labelSubmittedAt !== null));
  const inject = turns.filter((t) => t.perturbation.kind === "inject_word");
  const hit = (t: Turn, tol: number) => {
    const k = t.words.findIndex((w) => w.injected);
    return t.holds.some((h) => h.valence < 0 && Math.abs(h.wordIndex - k) <= tol);
  };
  const negMass = (t: Turn) => t.holds.filter((h) => h.valence < 0).reduce((a, h) => a + h.intensity, 0);
  const swap = turns.filter((t) => t.perturbation.kind === "swap_prompt");
  const clean = turns.filter((t) => t.perturbation.kind === "none");
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  return {
    labeledTurns: turns.length,
    injectTurns: inject.length,
    injectExactHit: mean(inject.map((t) => +hit(t, 0))),
    injectNearHit: mean(inject.map((t) => +hit(t, 1))),
    swapTurns: swap.length,
    swapNegMass: mean(swap.map(negMass)),
    cleanTurns: clean.length,
    cleanNegMass: mean(clean.map(negMass)),
  };
}
