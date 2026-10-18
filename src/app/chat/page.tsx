"use client";

import { Suspense, useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { WordText } from "@/components/WordText";
import { wordScores } from "@/lib/heat";
import {
  ODD_WORDS, SWAP_PROMPTS, getSession, intensityFromMs, now, saveSession, tokenize, uid,
} from "@/lib/store";
import type { Hold, Perturbation, Session, Turn, Valence, Word } from "@/lib/types";

/**
 * A press, optionally dragged across words. Each word under the pointer gets
 * its own hold (segment); time spent on a word sets its intensity.
 */
type Stroke = { id: string; turn: number; valence: Valence; wordIndex: number; start: number; moved: boolean };

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

  const recordRects = useCallback((turn: Turn) => {
    const els = document.querySelectorAll<HTMLElement>(`[data-turn="${turn.index}"] [data-w]`);
    const rects = Array.from(els).map((el) => {
      const r = el.getBoundingClientRect();
      return { i: Number(el.dataset.w), x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height };
    });
    (turn.wordRects ??= []).push({ at: now(), rects });
  }, []);

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
      if (wi === active.wordIndex) return;
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

  const onWordDown = (turnIndex: number) => (i: number, e: RPointerEvent<HTMLSpanElement>) => {
    if (active) return;
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    // Like: shift, ctrl (a Mac "right-click" arrives as ctrl+left), or a real right button.
    const valence: Valence = e.button === 2 || e.shiftKey || e.ctrlKey ? 1 : -1;
    setActive({ id: uid(), turn: turnIndex, wordIndex: i, valence, start: now(), moved: false });
    setFocus({ turn: turnIndex, wordIndex: i });
  };

  // ---- sending ----
  const s = sref.current;
  const last = s?.turns[s.turns.length - 1];
  const needsLabel = !!last && last.labelSubmittedAt === null;
  const locked = streaming || needsLabel;

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

    let rawWords: Word[] = [];
    let injectedAt: number | null = null;
    const render = (final: boolean) => {
      const t = now();
      rawWords = tokenize(turn.assistantRaw, rawWords, t);
      let words = rawWords.map((w) => ({ ...w }));
      if (perturbation.kind === "inject_word") {
        let k = perturbation.targetIndex;
        if (final && rawWords.length <= k) k = Math.max(1, rawWords.length - 1);
        if (rawWords.length > k || (final && rawWords.length > 0)) {
          injectedAt ??= t;
          perturbation.targetIndex = k;
          const para = rawWords[Math.min(k, rawWords.length - 1)].para;
          words.splice(k, 0, { i: k, text: perturbation.word, para, shownAt: injectedAt, injected: true });
          words = words.map((w, i) => ({ ...w, i }));
        }
      }
      turn.words = words;
      bump("soon");
    };

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: c.model,
          messages: [{ role: "system", content: c.systemPrompt }, ...history, { role: "user", content: sentPrompt }],
        }),
      });
      if (!res.ok || !res.body) throw new Error(await res.text());
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        turn.assistantRaw += dec.decode(value, { stream: true });
        render(false);
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
    render(true);
    turn.streamEnd = now();
    setStreaming(false);
    bump("now");
    requestAnimationFrame(() => {
      recordRects(turn);
      bump("now");
    });
  }

  function submitLabels(nothing: boolean) {
    if (!last) return;
    last.nothingNotable = nothing;
    last.labelSubmittedAt = now();
    recordRects(last);
    bump("now");
  }

  function undo() {
    if (!last?.holds.length) return;
    const stroke = last.holds[last.holds.length - 1].stroke;
    do last.holds.pop();
    while (stroke && last.holds.length && last.holds[last.holds.length - 1].stroke === stroke);
    bump("now");
  }

  function reset() {
    if (!last) return;
    last.holds = [];
    setFocus(null);
    bump("now");
  }

  const labeling = needsLabel && !streaming && last?.streamEnd != null;
  const holdCount = last?.holds.length ?? 0;
  useEffect(() => {
    if (!labeling || active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Enter") submitLabels(holdCount === 0);
      else if (e.key === "Escape") reset();
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [s?.turns.length, last?.words.length, needsLabel]);

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
  const panel = {
    state: (streaming ? "waiting" : labeling ? "labeling" : "idle") as "waiting" | "labeling" | "idle",
    turn: labeling ? last : undefined,
    focusWord: focusTurn?.words[focus!.wordIndex]?.text,
    focusNet,
    holding: active?.valence ?? 0,
    onUndo: undo,
    onReset: reset,
    onSubmit: submitLabels,
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
          className="rounded-full border border-line px-3 py-1.5 hover:bg-black/5 disabled:opacity-40"
        >
          Finish → replay
        </button>
      </header>

      <aside className="fixed right-6 top-20 hidden w-[240px] lg:block">
        <LabelPanel {...panel} />
      </aside>

      <div className="mx-auto max-w-3xl px-5 pb-48 pt-8 text-[16.5px] lg:mr-[280px] xl:mx-auto">
        {s.turns.length === 0 && (
          <div className="mt-24 text-center text-2xl font-medium text-ink">What can I help with?</div>
        )}
        {s.turns.map((t) => {
          const { neg, pos, net } = wordScores(liveHolds(t), t.words.length);
          const canLabel = t.labelSubmittedAt === null;
          return (
            <section key={t.index} className="mb-10">
              <div className="mb-6 flex justify-end">
                <div className="max-w-[75%] whitespace-pre-wrap rounded-3xl bg-mid px-5 py-2.5">{t.userText}</div>
              </div>
              <div data-turn={t.index}>
                {t.words.length === 0 && streaming ? (
                  <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-black" />
                ) : (
                  <WordText
                    words={t.words}
                    neg={neg}
                    pos={pos}
                    interactive={canLabel}
                    onWordDown={canLabel ? onWordDown(t.index) : undefined}
                    badge={active?.turn === t.index ? { i: active.wordIndex, value: net[active.wordIndex] ?? 0 } : undefined}
                  />
                )}
              </div>
              {t.error && <div className="mt-2 text-sm text-red-600">Error: {t.error}</div>}
              {canLabel && t.streamEnd !== null && (
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
          <div className="mx-auto mb-2 max-w-3xl px-5 text-sm text-red-600 lg:mr-[300px] xl:mx-auto">Request failed: {sendError}</div>
        )}
        <form
          className="mx-auto flex max-w-3xl lg:mr-[300px] xl:mx-auto items-center gap-2 rounded-[28px] border border-line bg-white px-5 py-3 shadow-[0_4px_24px_rgba(0,0,0,0.06)]"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input
            className="flex-1 bg-transparent py-1 outline-none placeholder:text-muted disabled:cursor-not-allowed"
            value={input}
            disabled={locked}
            placeholder={needsLabel && !streaming ? "Label the response above to continue" : "Ask anything"}
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

const Kbd = ({ children }: { children: React.ReactNode }) => (
  <kbd className="rounded border border-line bg-white px-1.5 py-0.5 font-mono text-[11px] text-ink-2">{children}</kbd>
);

function LabelPanel({
  state,
  turn,
  focusWord,
  focusNet,
  holding,
  onUndo,
  onReset,
  onSubmit,
  compact = false,
}: {
  state: "waiting" | "labeling" | "idle";
  turn?: Turn;
  focusWord?: string;
  focusNet: number;
  holding: number;
  onUndo: () => void;
  onReset: () => void;
  onSubmit: (nothing: boolean) => void;
  compact?: boolean;
}) {
  const n = turn ? wordScores(turn.holds, turn.words.length).net.filter((v) => Math.abs(v) >= 0.01).length : 0;
  const on = state === "labeling";
  const dim = on ? "" : "opacity-40";
  const status = state === "waiting" ? "Reading reply…" : on ? "Label this reply" : "Send a message";

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
      </div>
    </div>
  );

  const continueBtn = (
    <button
      onClick={() => onSubmit(n === 0)}
      disabled={!on}
      className="flex w-full items-center justify-center gap-2 rounded-full bg-ink px-4 py-2 text-sm text-white disabled:bg-axis"
    >
      {n ? "Done" : "Nothing stood out"}
      <kbd className="rounded bg-white/15 px-1.5 font-mono text-[11px]">↵</kbd>
    </button>
  );

  const secondary = (
    <div className="flex items-center gap-1 text-[13px] text-ink-2">
      <span className="mr-auto whitespace-nowrap text-[12px] text-muted">{n} marked</span>
      <button onClick={onUndo} disabled={!on || !n} className="rounded-full px-2 py-1 hover:bg-mid disabled:opacity-40">Undo</button>
      <button onClick={onReset} disabled={!on || !n} className="flex items-center gap-1 rounded-full px-2 py-1 hover:bg-mid disabled:opacity-40">
        Reset <Kbd>Esc</Kbd>
      </button>
    </div>
  );

  if (compact) {
    return (
      <div className="space-y-3 rounded-2xl border border-line bg-page p-4">
        {legend}
        {secondary}
        {continueBtn}
      </div>
    );
  }

  // Gauge: +1 (like) at the top, -1 (dislike) at the bottom.
  const markerTop = `${50 - focusNet * 50}%`;
  return (
    <div className="rounded-2xl border border-line bg-white p-4 shadow-[0_4px_24px_rgba(0,0,0,0.04)]">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13px] font-semibold text-ink">{status}</span>
        {state === "labeling" && <span className="h-2 w-2 animate-pulse rounded-full bg-neg" />}
      </div>

      <div className={`flex gap-4 ${dim}`}>
        <div className="relative h-44 w-3 shrink-0 rounded-full bg-gradient-to-b from-pos via-mid to-neg">
          <div className="absolute left-1/2 top-1/2 h-px w-5 -translate-x-1/2 bg-black/30" />
          {focusWord && (
            <div
              className="absolute left-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-ink shadow"
              style={{ top: markerTop }}
            />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-between py-0.5 text-[12px] text-muted">
          <span>like</span>
          <div className="min-w-0">
            <div className="truncate text-[15px] font-medium text-ink">{focusWord ?? "—"}</div>
            <div className="font-mono" style={{ color: focusNet < 0 ? "var(--color-neg)" : focusNet > 0 ? "var(--color-pos)" : undefined }}>
              {focusWord ? `${focusNet > 0 ? "+" : ""}${focusNet.toFixed(2)}` : "hold a word"}
              {holding !== 0 && (holding < 0 ? " ↓" : " ↑")}
            </div>
          </div>
          <span>dislike</span>
        </div>
      </div>

      <div className={`mt-5 border-t border-line-soft pt-4 ${dim}`}>{legend}</div>

      <div className={`mt-4 space-y-3 border-t border-line-soft pt-4 ${dim}`}>
        {secondary}
        {continueBtn}
      </div>
    </div>
  );
}
