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

// Diverging label colors (tokens --color-neg / --color-pos).
const negColor = (a: number) => `rgba(227,73,72,${a})`;
const posColor = (a: number) => `rgba(42,120,214,${a})`;

/** Highlighter tint plus an underline whose strength tracks |score|. */
export function heatStyle(neg: number, pos: number, overlay = 1): CSSProperties {
  const v = Math.max(neg, pos);
  if (v <= 0.001) return {};
  const color = neg >= pos ? negColor : posColor;
  const a = (0.12 + 0.38 * v) * overlay;
  return {
    background: color(a),
    boxShadow: `inset 0 -2px 0 ${color(Math.min(1, 0.4 + 0.6 * v) * overlay)}`,
    borderRadius: 4,
  };
}
