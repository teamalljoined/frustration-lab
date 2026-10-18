import type { CSSProperties } from "react";

/**
 * Signed net score per word in [-1, 1]: holds add valence × intensity, so an
 * opposite-valence hold pulls a word back toward neutral (and past it).
 */
export function wordScores(holds: { wordIndex: number; valence: number; intensity: number }[], n: number) {
  const net = new Array(n).fill(0);
  for (const h of holds) {
    if (h.wordIndex >= n) continue;
    net[h.wordIndex] = Math.max(-1, Math.min(1, net[h.wordIndex] + h.valence * h.intensity));
  }
  return { net, neg: net.map((v) => Math.max(0, -v)), pos: net.map((v) => Math.max(0, v)) };
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
