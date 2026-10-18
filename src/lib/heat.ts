import type { CSSProperties } from "react";
import type { Hold } from "./types";

/** Sum hold intensities per word, by valence, clipped to 1. */
export function wordScores(holds: Hold[], n: number) {
  const neg = new Array(n).fill(0);
  const pos = new Array(n).fill(0);
  for (const h of holds) {
    if (h.wordIndex >= n) continue;
    if (h.valence < 0) neg[h.wordIndex] = Math.min(1, neg[h.wordIndex] + h.intensity);
    else pos[h.wordIndex] = Math.min(1, pos[h.wordIndex] + h.intensity);
  }
  return { neg, pos };
}

// Negative heat goes amber -> magenta as it intensifies (matches the replay mock).
function negColor(v: number, a: number) {
  const r = 240, g = Math.round(180 - 130 * v), b = Math.round(60 + 60 * v);
  return `rgba(${r},${g},${b},${a})`;
}
function posColor(_v: number, a: number) {
  return `rgba(34,170,120,${a})`;
}

/** Soft glow behind a word, like a highlighter blot. */
export function heatStyle(neg: number, pos: number, overlay = 1): CSSProperties {
  const v = Math.max(neg, pos);
  if (v <= 0.001) return {};
  const color = neg >= pos ? negColor : posColor;
  const a = Math.min(1, 0.25 + 0.75 * v) * overlay;
  return {
    background: `radial-gradient(ellipse at center, ${color(v, a)} 0%, ${color(v, a * 0.55)} 50%, ${color(v, 0)} 78%)`,
    borderRadius: 8,
  };
}
