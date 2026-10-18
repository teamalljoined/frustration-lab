"use client";

import type { PointerEvent as RPointerEvent } from "react";
import { heatStyle } from "@/lib/heat";
import type { Word } from "@/lib/types";

export function WordText({
  words,
  neg,
  pos,
  overlay = 1,
  onWordDown,
  interactive = false,
  showInjected = false,
  cursor,
  badge,
  range,
}: {
  words: Word[];
  neg: number[];
  pos: number[];
  overlay?: number;
  onWordDown?: (i: number, e: RPointerEvent<HTMLSpanElement>) => void;
  interactive?: boolean;
  showInjected?: boolean;
  cursor?: number; // word currently under the participant's gaze (replay)
  badge?: { i: number; value: number }; // live score bubble above the word being held
  range?: [number, number]; // only these words are active; earlier ones are dimmed
}) {
  const inRange = (i: number) => !range || (i >= range[0] && i < range[1]);
  const paras: Word[][] = [];
  for (const w of words) (paras[w.para] ??= []).push(w);
  return (
    <div className="space-y-4 leading-[1.75]">
      {paras.filter(Boolean).map((ws, p) => (
        <p key={p}>
          {ws.map((w) => (
            <span key={w.i}>
              <span
                data-w={w.i}
                onPointerDown={onWordDown && inRange(w.i) ? (e) => onWordDown(w.i, e) : undefined}
                className={
                  (interactive && inRange(w.i) ? "cursor-pointer select-none rounded-md hover:bg-mid " : "") +
                  (inRange(w.i) ? "" : "text-muted ") +
                  (showInjected && w.injected ? "underline decoration-dotted decoration-2 underline-offset-4 " : "") +
                  "relative px-[1px] py-[2px]"
                }
                style={{
                  ...heatStyle(neg[w.i] ?? 0, pos[w.i] ?? 0, overlay),
                  ...(cursor === w.i ? { outline: "2px solid #0b0b0b", outlineOffset: 2, borderRadius: 4 } : {}),
                }}
              >
                {w.text}
                {badge?.i === w.i && (
                  <span
                    className={
                      "pointer-events-none absolute bottom-full left-1/2 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-md px-1.5 py-0.5 font-mono text-[11px] font-medium text-white shadow-sm " +
                      (badge.value < 0 ? "bg-neg" : badge.value > 0 ? "bg-pos" : "bg-ink")
                    }
                  >
                    {badge.value > 0 ? "+" : ""}
                    {badge.value.toFixed(2)}
                  </span>
                )}
              </span>{" "}
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}
