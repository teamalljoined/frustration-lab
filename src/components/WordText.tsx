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
}: {
  words: Word[];
  neg: number[];
  pos: number[];
  overlay?: number;
  onWordDown?: (i: number, e: RPointerEvent<HTMLSpanElement>) => void;
  interactive?: boolean;
  showInjected?: boolean;
}) {
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
                onPointerDown={onWordDown ? (e) => onWordDown(w.i, e) : undefined}
                className={
                  (interactive ? "cursor-pointer select-none rounded-md hover:bg-black/[0.04] " : "") +
                  (showInjected && w.injected ? "underline decoration-dotted decoration-2 underline-offset-4 " : "") +
                  "px-[1px] py-[2px] transition-[background] duration-75"
                }
                style={heatStyle(neg[w.i] ?? 0, pos[w.i] ?? 0, overlay)}
              >
                {w.text}
              </span>{" "}
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}
