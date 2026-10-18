"use client";

import { Suspense, useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { WordText } from "@/components/WordText";
import { wordScores } from "@/lib/heat";
import {
  ODD_WORDS, SWAP_PROMPTS, getSession, intensityFromMs, now, saveSession, tokenize, uid,
} from "@/lib/store";
import { chunkWords, phaseOf, type Phase } from "@/lib/chunks";
import type { Chunk, Hold, Perturbation, Session, Turn, Valence, Word } from "@/lib/types";
import { modeInstruction, pickMode, type TurnMode } from "@/lib/styles";

/**
 * A press, optionally dragged across words. Each word under the pointer gets
 * its own hold (segment); time spent on a word sets its intensity.
 */
type Stroke = {
  id: string;
  turn: number;
  valence: Valence;
  wordIndex: number;
  start: number;
  moved: boolean;
  range: [number, number]; // words this stroke may touch (the current chunk, or all in review)
  phase: "chunk" | "review";
  chunk?: number;
};

/** Words swept over in a drag get at least this much, so a quick sweep still marks them. */
const DRAG_MIN = 0.25;
const segIntensity = (ms: number, moved: boolean) => (moved ? Math.max(DRAG_MIN, intensityFromMs(ms)) : intensityFromMs(ms));

export default function ChatPage() {
  return (
    <Suspense>
      <Chat />
    </Suspense>
  );
}

const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

/** Holds made in the phase the participant is currently in. */
const inPhase = (h: Hold, p: Phase) =>
  p.kind === "review" ? h.phase !== "chunk" : p.kind === "label" ? h.phase === "chunk" && h.chunk === p.chunk.i : false;

function Chat() {
  const id = useSearchParams().get("id");
  const router = useRouter();
  const sref = useRef<Session | null>(null);
  const [, setVersion] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [active, setActive] = useState<Stroke | null>(null);
  const [liveMs, setLiveMs] = useState(0);
  const [focus, setFocus] = useState<{ turn: number; wordIndex: number } | null>(null);
  const [nudge, setNudge] = useState(0); // flashes the "finish reading first" hint
  const typingStart = useRef<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bump = useCallback((persist: "now" | "soon" | "no" = "soon") => {
    setVersion((v) => v + 1);
    const s = sref.current;
    if (!s || persist === "no") return;
    if (persist === "now") return saveSession(s);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveSession(s), 400);
  }, []);

  useEffect(() => {
    if (!id) return;
    sref.current = getSession(id);
    setLoaded(true);
    bump("no");
  }, [id, bump]);

  // ---- passive logging for gaze / screen-recording alignment ----
  useEffect(() => {
    let last = 0;
    const log = (e: Session["events"][number]) => sref.current?.events.push(e);
    const onScroll = () => {
      const t = now();
      if (t - last < 100) return;
      last = t;
      log({ t, type: "scroll", scrollY: window.scrollY });
    };
    const onResize = () => log({ t: now(), type: "resize", w: innerWidth, h: innerHeight });
    // No event fires when the window moves, so poll its placement.
    let lastWin = "";
    const logWindow = () => {
      const w = { sx: screenX, sy: screenY, ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio };
      const key = JSON.stringify(w);
      if (key === lastWin) return;
      lastWin = key;
      log({ t: now(), type: "window", ...w });
    };
    logWindow();
    const winTimer = setInterval(logWindow, 500);
    const onFocus = () => log({ t: now(), type: "focus" });
    const onBlur = () => log({ t: now(), type: "blur" });
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", onResize);
    addEventListener("focus", onFocus);
    addEventListener("blur", onBlur);
    return () => {
      removeEventListener("scroll", onScroll);
      removeEventListener("resize", onResize);
      removeEventListener("focus", onFocus);
      removeEventListener("blur", onBlur);
      clearInterval(winTimer);
    };
  }, []);

  /** Snapshot word boxes (document coords) once the browser has laid them out. */
  const recordRects = useCallback((turn: Turn) => {
    requestAnimationFrame(() => {
      const els = document.querySelectorAll<HTMLElement>(`[data-turn="${turn.index}"] [data-w]`);
      const rects = Array.from(els).map((el) => {
        const r = el.getBoundingClientRect();
        return { i: Number(el.dataset.w), x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height };
      });
      (turn.wordRects ??= []).push({ at: now(), rects });
      bump("soon");
    });
  }, [bump]);

  // ---- holds ----
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const tick = () => {
      setLiveMs(now() - active.start);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const commit = (t: number, moved: boolean) => {
      const turn = sref.current?.turns[active.turn];
      if (!turn) return;
      const durationMs = t - active.start;
      turn.holds.push({
        id: uid(),
        stroke: active.id,
        phase: active.phase,
        chunk: active.chunk,
        turn: active.turn,
        wordIndex: active.wordIndex,
        word: turn.words[active.wordIndex]?.text ?? "",
        valence: active.valence,
        start: active.start,
        end: t,
        durationMs,
        intensity: segIntensity(durationMs, moved),
      });
    };
    const move = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-w]");
      if (!el || el.closest<HTMLElement>("[data-turn]")?.dataset.turn !== String(active.turn)) return;
      const wi = Number(el.dataset.w);
      if (wi === active.wordIndex || wi < active.range[0] || wi >= active.range[1]) return;
      const t = now();
      commit(t, true);
      setActive({ ...active, wordIndex: wi, start: t, moved: true });
      setFocus({ turn: active.turn, wordIndex: wi });
    };
    const end = () => {
      commit(now(), active.moved);
      setActive(null);
      setLiveMs(0);
      bump("now");
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", end);
    addEventListener("pointercancel", end);
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", end);
      removeEventListener("pointercancel", end);
    };
  }, [active, bump]);

  // ---- current turn / phase ----
  const s = sref.current;
  const last = s?.turns[s.turns.length - 1];
  const phase: Phase = last && last.streamEnd !== null ? phaseOf(last) : { kind: "done" };
  const needsLabel = !!last && last.labelSubmittedAt === null;
  const locked = streaming || needsLabel;
  const labelRange: [number, number] | null =
    phase.kind === "label" ? [phase.chunk.start, phase.chunk.end] : phase.kind === "review" && last ? [0, last.words.length] : null;

  const onWordDown = (turnIndex: number) => (i: number, e: RPointerEvent<HTMLSpanElement>) => {
    if (active || e.button > 2) return;
    e.preventDefault();
    if (phase.kind === "read") {
      setNudge((n) => n + 1);
      return;
    }
    if (!labelRange || turnIndex !== last?.index) return;
    // Like: shift, ctrl (a Mac "right-click" arrives as ctrl+left), or a real right button.
    const valence: Valence = e.button === 2 || e.shiftKey || e.ctrlKey ? 1 : -1;
    setActive({
      id: uid(), turn: turnIndex, wordIndex: i, valence, start: now(), moved: false, range: labelRange,
      phase: phase.kind === "label" ? "chunk" : "review",
      chunk: phase.kind === "label" ? phase.chunk.i : undefined,
    });
    setFocus({ turn: turnIndex, wordIndex: i });
  };

  /** Show a chunk all at once; its words' onset is the moment it appears. */
  function reveal(turn: Turn, c: Chunk) {
    const t = now();
    c.shownAt = t;
    for (let i = c.start; i < c.end; i++) turn.words[i].shownAt = t;
    recordRects(turn);
  }

  async function send() {
    const s = sref.current;
    const text = input.trim();
    if (!s || !text || locked) return;
    const index = s.turns.length;
    const n = index + 1;
    const c = s.condition;

    let perturbation: Perturbation = { kind: "none" };
    if (c.swapEvery > 0 && n % c.swapEvery === 0) {
      perturbation = { kind: "swap_prompt", sentPrompt: pick(SWAP_PROMPTS) };
    } else if (c.injectEvery > 0 && n % c.injectEvery === 0) {
      perturbation = { kind: "inject_word", word: pick(ODD_WORDS), targetIndex: 4 + Math.floor(Math.random() * 16) };
    }

    const style: TurnMode =
      c.behavior === "frustration"
        ? pickMode(s.turns.map((t) => t.style ?? { mode: "normal" }), c.helpfulRate ?? 0.3, c.tactics ?? [])
        : { mode: "normal" };
    const system = [c.systemPrompt, modeInstruction(style)].filter(Boolean).join("\n\n");

    const history = s.turns.flatMap((t) => [
      { role: "user" as const, content: t.perturbation.kind === "swap_prompt" ? t.perturbation.sentPrompt : t.userText },
      { role: "assistant" as const, content: t.assistantRaw },
    ]);
    const sentPrompt = perturbation.kind === "swap_prompt" ? perturbation.sentPrompt : text;

    const turn: Turn = {
      index,
      userText: text,
      typingStart: typingStart.current,
      submittedAt: now(),
      perturbation,
      style,
      model: c.model,
      assistantRaw: "",
      words: [],
      streamStart: now(),
      streamEnd: null,
      holds: [],
      nothingNotable: false,
      labelSubmittedAt: null,
    };
    s.turns.push(turn);
    setSendError(null);
    setFocus(null);
    typingStart.current = null;
    setInput("");
    setStreaming(true);
    bump("now");

    // The reply is collected off-screen and shown chunk by chunk once complete.
    let rawWords: Word[] = [];
    const build = () => {
      rawWords = tokenize(turn.assistantRaw, rawWords, 0);
      let words = rawWords.map((w) => ({ ...w }));
      if (perturbation.kind === "inject_word" && rawWords.length) {
        const k = Math.min(perturbation.targetIndex, Math.max(1, rawWords.length - 1));
        perturbation.targetIndex = k;
        words.splice(k, 0, { i: k, text: perturbation.word, para: rawWords[Math.min(k, rawWords.length - 1)].para, shownAt: 0, injected: true });
        words = words.map((w, i) => ({ ...w, i }));
      }
      turn.words = words;
    };

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: c.model,
          messages: [{ role: "system", content: system }, ...history, { role: "user", content: sentPrompt }],
        }),
      });
      if (!res.ok || !res.body) throw new Error(await res.text());
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        turn.assistantRaw += dec.decode(value, { stream: true });
      }
    } catch (e) {
      turn.error = (e as Error).message;
      if (!turn.assistantRaw) {
        // Nothing to label: drop the turn so the participant can retry.
        s.turns.pop();
        setInput(text);
        setSendError(turn.error);
        setStreaming(false);
        bump("now");
        return;
      }
    }
    build();
    turn.streamEnd = now();
    turn.chunks = chunkWords(turn.words);
    reveal(turn, turn.chunks[0]);
    setStreaming(false);
    bump("now");
  }

  // ---- phase actions ----
  function doneReading() {
    if (phase.kind !== "read") return;
    phase.chunk.readAt = now();
    bump("now");
  }

  function doneChunk() {
    if (phase.kind !== "label" || !last?.chunks) return;
    phase.chunk.labeledAt = now();
    const next = last.chunks[phase.chunk.i + 1];
    if (next) reveal(last, next);
    else recordRects(last); // full reply now visible for review
    setFocus(null);
    bump("now");
  }

  function submitReply() {
    if (phase.kind !== "review" || !last) return;
    last.nothingNotable = last.holds.length === 0;
    last.labelSubmittedAt = now();
    setFocus(null);
    bump("now");
  }

  const primary = () => (phase.kind === "read" ? doneReading() : phase.kind === "label" ? doneChunk() : submitReply());

  function undo() {
    if (!last) return;
    const h = last.holds[last.holds.length - 1];
    if (!h || !inPhase(h, phase)) return;
    const stroke = h.stroke;
    do last.holds.pop();
    while (stroke && last.holds.length && last.holds[last.holds.length - 1].stroke === stroke);
    bump("now");
  }

  function reset() {
    if (!last) return;
    last.holds = last.holds.filter((h) => !inPhase(h, phase));
    setFocus(null);
    bump("now");
  }

  useEffect(() => {
    if (phase.kind === "done" || active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (phase.kind === "read" && e.key === " ") doneReading();
      else if (phase.kind !== "read" && e.key === "Enter") primary();
      else if (phase.kind !== "read" && e.key === "Escape") reset();
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  function finish() {
    const s = sref.current;
    if (!s) return;
    s.endedAt = now();
    saveSession(s);
    router.push(`/replay?id=${s.id}`);
  }

  const chunkKey = phase.kind === "read" || phase.kind === "label" ? `${phase.chunk.i}` : phase.kind;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [s?.turns.length, chunkKey, streaming]);

  if (!id || (loaded && !s)) {
    return (
      <main className="p-10 text-center">
        Session not found. <Link className="underline" href="/">Start one</Link>.
      </main>
    );
  }
  if (!s) return null;

  const liveHolds = (t: Turn): Hold[] =>
    active?.turn === t.index
      ? [...t.holds, { ...active, id: "live", word: "", end: 0, durationMs: liveMs, intensity: segIntensity(liveMs, active.moved) }]
      : t.holds;
  const focusTurn = focus ? s.turns[focus.turn] : undefined;
  const focusNet = focusTurn ? wordScores(liveHolds(focusTurn), focusTurn.words.length).net[focus!.wordIndex] ?? 0 : 0;
  const marked = last
    ? wordScores(last.holds, last.words.length).net.filter((v, i) => Math.abs(v) >= 0.01 && (!labelRange || (i >= labelRange[0] && i < labelRange[1]))).length
    : 0;
  const panel = {
    phase: streaming ? ({ kind: "waiting" } as const) : phase,
    marked,
    editable: !!last?.holds.some((h) => inPhase(h, phase)),
    focusWord: focusTurn?.words[focus!.wordIndex]?.text,
    focusNet,
    holding: active?.valence ?? 0,
    nudge,
    onPrimary: primary,
    onUndo: undo,
    onReset: reset,
  };

  return (
    <main className="min-h-screen bg-white text-ink" onContextMenu={(e) => e.preventDefault()}>
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-line-soft bg-surface/90 px-5 py-3 text-sm backdrop-blur">
        <div className="flex items-center gap-3">
          <span className="font-semibold">Frustration Lab</span>
          <span className="text-muted">{s.participant} · turn {s.turns.length}</span>
        </div>
        <button
          onClick={finish}
          disabled={locked || s.turns.length === 0}
          className="rounded-full border border-line px-3 py-1.5 hover:bg-mid disabled:opacity-40"
        >
          Finish → replay
        </button>
      </header>

      <aside className="fixed right-6 top-20 hidden w-[240px] lg:block">
        <LabelPanel {...panel} />
      </aside>

      <div className="mx-auto max-w-3xl px-5 pb-48 pt-8 text-[17px] lg:mr-[280px] xl:mx-auto">
        {s.turns.length === 0 && <HowItWorks />}
        {s.turns.map((t) => {
          const { neg, pos, net } = wordScores(liveHolds(t), t.words.length);
          const isLast = t.index === last?.index;
          const p = isLast ? phase : ({ kind: "done" } as Phase);
          // While reading/labeling chunk k, show chunks 0..k with earlier ones dimmed.
          const chunked = p.kind === "read" || p.kind === "label";
          const words = chunked ? t.words.slice(0, p.chunk.end) : t.words;
          return (
            <section key={t.index} className="mb-10">
              <div className="mb-6 flex justify-end">
                <div className="max-w-[75%] whitespace-pre-wrap rounded-3xl bg-mid px-5 py-2.5">{t.userText}</div>
              </div>
              <div data-turn={t.index}>
                {t.streamEnd === null ? (
                  <span className="inline-flex items-center gap-2 text-sm text-muted">
                    <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-ink" /> Thinking…
                  </span>
                ) : (
                  <WordText
                    words={words}
                    neg={neg}
                    pos={pos}
                    range={chunked ? [p.chunk.start, p.chunk.end] : undefined}
                    interactive={p.kind === "label" || p.kind === "review"}
                    onWordDown={p.kind !== "done" ? onWordDown(t.index) : undefined}
                    badge={active?.turn === t.index ? { i: active.wordIndex, value: net[active.wordIndex] ?? 0 } : undefined}
                  />
                )}
              </div>
              {t.error && <div className="mt-2 text-sm text-neg">Error: {t.error}</div>}
              {isLast && p.kind !== "done" && (
                <div className="mt-5 lg:hidden">
                  <LabelPanel {...panel} compact />
                </div>
              )}
            </section>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div className="fixed inset-x-0 bottom-0 bg-gradient-to-t from-white via-white to-white/0 pb-6 pt-8">
        {sendError && (
          <div className="mx-auto mb-2 max-w-3xl px-5 text-sm text-neg lg:mr-[300px] xl:mx-auto">Request failed: {sendError}</div>
        )}
        <form
          className="mx-auto flex max-w-3xl items-center gap-2 rounded-[28px] border border-line bg-white px-5 py-3 shadow-[0_4px_24px_rgba(0,0,0,0.06)] lg:mr-[300px] xl:mx-auto"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input
            className="flex-1 bg-transparent py-1 outline-none placeholder:text-muted disabled:cursor-not-allowed"
            value={input}
            disabled={locked}
            placeholder={streaming ? "Waiting for the reply…" : needsLabel ? "Finish this reply to continue" : "Ask anything"}
            onChange={(e) => {
              typingStart.current ??= now();
              setInput(e.target.value);
            }}
            onKeyDown={() => s.events.push({ t: now(), type: "keydown", turn: s.turns.length, len: input.length })}
          />
          <button
            type="submit"
            disabled={locked || !input.trim()}
            className="grid h-9 w-9 place-items-center rounded-full bg-ink text-white disabled:bg-axis"
            aria-label="Send"
          >
            ↑
          </button>
        </form>
      </div>
    </main>
  );
}

function HowItWorks() {
  const steps = [
    ["Ask anything", "Chat as you normally would."],
    ["Read", "Each reply appears a few sentences at a time. Keep your hands still and read to the end of the dark text, then press Space."],
    ["Label", "Hold click on words that bother you, ⇧ or ctrl + click on words you like. Drag to mark several. Press Enter for the next part."],
    ["Review", "At the end you see the whole reply and can add more labels. Enter continues."],
  ];
  return (
    <div className="mx-auto mt-16 max-w-xl">
      <div className="mb-6 text-center text-2xl font-medium">What can I help with?</div>
      <ol className="space-y-3 rounded-2xl border border-line bg-page p-5 text-[14px]">
        {steps.map(([title, body], i) => (
          <li key={title} className="flex gap-3">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ink text-xs text-white">{i + 1}</span>
            <span>
              <span className="font-medium">{title}.</span> <span className="text-ink-2">{body}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

const Kbd = ({ children, dark = false }: { children: React.ReactNode; dark?: boolean }) => (
  <kbd
    className={
      "rounded px-1.5 py-0.5 font-mono text-[11px] " +
      (dark ? "bg-white/15 text-white" : "border border-line bg-white text-ink-2")
    }
  >
    {children}
  </kbd>
);

function LabelPanel({
  phase,
  marked,
  editable,
  focusWord,
  focusNet,
  holding,
  nudge,
  onPrimary,
  onUndo,
  onReset,
  compact = false,
}: {
  phase: Phase | { kind: "waiting" };
  marked: number;
  editable: boolean;
  focusWord?: string;
  focusNet: number;
  holding: number;
  nudge: number;
  onPrimary: () => void;
  onUndo: () => void;
  onReset: () => void;
  compact?: boolean;
}) {
  const labeling = phase.kind === "label" || phase.kind === "review";
  const step = phase.kind === "read" || phase.kind === "label" ? `${phase.chunk.i + 1} / ${phase.n}` : "";
  const status =
    phase.kind === "waiting" ? "Waiting for reply…"
    : phase.kind === "read" ? `Read · part ${step}`
    : phase.kind === "label" ? `Label · part ${step}`
    : phase.kind === "review" ? "Review whole reply"
    : "Send a message";
  const isLastChunk = phase.kind === "label" && phase.chunk.i === phase.n - 1;
  const primaryText =
    phase.kind === "read" ? "Done reading"
    : phase.kind === "label" ? (isLastChunk ? "Review whole reply" : "Next part")
    : phase.kind === "review" ? "Continue"
    : "";
  const primaryKey = phase.kind === "read" ? "Space" : "↵";

  const primaryBtn = primaryText && (
    <button
      onClick={onPrimary}
      className="flex w-full items-center justify-center gap-2 rounded-full bg-ink px-4 py-2 text-sm text-white"
    >
      {primaryText} <Kbd dark>{primaryKey}</Kbd>
    </button>
  );

  // Reading: hands off, nothing else to do.
  const readCard = (
    <div key={nudge} className={"rounded-xl bg-page p-3 text-[13px] text-ink-2 " + (nudge ? "animate-[pulse_0.6s_ease-in-out_2]" : "")}>
      Keep your hands still and read to the end of the <b className="text-ink">dark text</b>. Labeling unlocks after you
      press <Kbd>Space</Kbd>.
    </div>
  );

  const legend = (
    <div className="space-y-2 text-[13px] text-ink-2">
      <div className="flex items-center justify-between gap-2">
        <span>Hold <Kbd>click</Kbd></span>
        <span className="text-neg">dislike ↓</span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span>Hold <Kbd>⇧</Kbd> or <Kbd>ctrl</Kbd> + click</span>
        <span className="text-pos">like ↑</span>
      </div>
      <div className="text-[12px] leading-snug text-muted">
        Drag across words to mark several. Longer = stronger; the opposite pulls a word back.
        {phase.kind === "review" && " Add anything you missed."}
      </div>
    </div>
  );

  const secondary = (
    <div className="flex items-center gap-1 text-[13px] text-ink-2">
      <span className="mr-auto whitespace-nowrap text-[12px] text-muted">{marked} marked</span>
      <button onClick={onUndo} disabled={!editable} className="rounded-full px-2 py-1 hover:bg-mid disabled:opacity-40">Undo</button>
      <button onClick={onReset} disabled={!editable} className="flex items-center gap-1 rounded-full px-2 py-1 hover:bg-mid disabled:opacity-40">
        Reset <Kbd>Esc</Kbd>
      </button>
    </div>
  );

  if (compact) {
    return (
      <div className="space-y-3 rounded-2xl border border-line bg-page p-4">
        <div className="text-[13px] font-semibold">{status}</div>
        {phase.kind === "read" ? readCard : legend}
        {labeling && secondary}
        {primaryBtn}
      </div>
    );
  }

  // Gauge: +1 (like) at the top, -1 (dislike) at the bottom.
  const markerTop = `${50 - focusNet * 50}%`;
  const dim = labeling ? "" : "opacity-40";
  return (
    <div className="rounded-2xl border border-line bg-white p-4 shadow-[0_4px_24px_rgba(0,0,0,0.04)]">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13px] font-semibold text-ink">{status}</span>
        {phase.kind !== "done" && phase.kind !== "waiting" && (
          <span className={"h-2 w-2 rounded-full " + (phase.kind === "read" ? "bg-ink" : "animate-pulse bg-neg")} />
        )}
      </div>

      {phase.kind === "read" && <div className="mb-4">{readCard}</div>}

      <div className={`flex gap-4 ${dim}`}>
        <div className="relative h-36 w-3 shrink-0 rounded-full bg-gradient-to-b from-pos via-mid to-neg">
          <div className="absolute left-1/2 top-1/2 h-px w-5 -translate-x-1/2 bg-black/30" />
          {focusWord && labeling && (
            <div
              className="absolute left-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-ink shadow"
              style={{ top: markerTop }}
            />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-between py-0.5 text-[12px] text-muted">
          <span>like</span>
          <div className="min-w-0">
            <div className="truncate text-[15px] font-medium text-ink">{labeling ? focusWord ?? "—" : "—"}</div>
            <div className="font-mono" style={{ color: focusNet < 0 ? "var(--color-neg)" : focusNet > 0 ? "var(--color-pos)" : undefined }}>
              {labeling && focusWord ? `${focusNet > 0 ? "+" : ""}${focusNet.toFixed(2)}` : "hold a word"}
              {holding !== 0 && (holding < 0 ? " ↓" : " ↑")}
            </div>
          </div>
          <span>dislike</span>
        </div>
      </div>

      <div className={`mt-5 border-t border-line-soft pt-4 ${dim}`}>{legend}</div>

      <div className="mt-4 space-y-3 border-t border-line-soft pt-4">
        <div className={dim}>{secondary}</div>
        {primaryBtn}
      </div>
    </div>
  );
}
