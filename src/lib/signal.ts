import { wordScores } from "./heat";
import type { Hold, Session, Turn } from "./types";

export function sessionBounds(s: Session) {
  const t0 = s.turns[0]?.submittedAt ?? s.createdAt;
  const lastTurn = s.turns[s.turns.length - 1];
  const t1 = Math.max(
    t0 + 1000,
    s.endedAt ?? 0,
    lastTurn?.labelSubmittedAt ?? 0,
    lastTurn?.streamEnd ?? 0,
    ...s.turns.flatMap((t) => t.holds.map((h) => h.end)),
  );
  return { t0: t0 - 1000, t1 };
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
    cur.holds.push(h);
    byWord.set(h.wordIndex, cur);
  }
  const net = wordScores(t.holds, t.words.length).net;
  for (const [i, w] of byWord) {
    w.valence = net[i];
    w.intensity = Math.abs(net[i]);
  }
  // Words whose opposite holds cancelled out carry no label.
  const idx = [...byWord.keys()].filter((i) => Math.abs(net[i]) >= 0.01).sort((a, b) => a - b);
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
      style: t.style ?? { mode: "normal" },
      timing: { submitted_at: t.submittedAt, stream_start: t.streamStart, stream_end: t.streamEnd, label_submitted_at: t.labelSubmittedAt },
    }));
}

/** Dense per-word reward in [-1, 1]: positive intensity minus negative intensity. */
export function wordReward(t: Turn) {
  return wordScores(t.holds, t.words.length).net.map((v) => +v.toFixed(3));
}

/** Label-quality evals against hidden ground-truth perturbations. */
export function groundTruthEvals(sessions: Session[]) {
  const turns = sessions.flatMap((s) => s.turns.filter((t) => t.labelSubmittedAt !== null));
  const inject = turns.filter((t) => t.perturbation.kind === "inject_word");
  const hit = (t: Turn, tol: number) => {
    const k = t.words.findIndex((w) => w.injected);
    return wordScores(t.holds, t.words.length).net.some((v, i) => v < 0 && Math.abs(i - k) <= tol);
  };
  const negMass = (t: Turn) => wordScores(t.holds, t.words.length).neg.reduce((a, v) => a + v, 0);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const posMass = (t: Turn) => wordScores(t.holds, t.words.length).pos.reduce((a, v) => a + v, 0);
  const summarize = (ts: Turn[]) => ({
    turns: ts.length,
    negMass: mean(ts.map(negMass)),
    posMass: mean(ts.map(posMass)),
    nothing: mean(ts.map((t) => +t.nothingNotable)),
  });
  const byMode = (["frustrating", "helpful"] as const).map((m) => ({
    key: m,
    ...summarize(turns.filter((t) => t.style?.mode === m)),
  }));
  const tacticIds = [...new Set(turns.flatMap((t) => (t.style?.mode === "frustrating" ? [t.style.tactic] : [])))];
  const byTactic = tacticIds.map((id) => ({
    key: id,
    ...summarize(turns.filter((t) => t.style?.mode === "frustrating" && t.style.tactic === id)),
  }));
  const swap = turns.filter((t) => t.perturbation.kind === "swap_prompt");
  const clean = turns.filter((t) => t.perturbation.kind === "none");
  return {
    labeledTurns: turns.length,
    injectTurns: inject.length,
    injectExactHit: mean(inject.map((t) => +hit(t, 0))),
    injectNearHit: mean(inject.map((t) => +hit(t, 1))),
    swapTurns: swap.length,
    swapNegMass: mean(swap.map(negMass)),
    cleanTurns: clean.length,
    cleanNegMass: mean(clean.map(negMass)),
    byMode,
    byTactic,
  };
}
