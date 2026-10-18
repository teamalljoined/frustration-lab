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

type ActiveHold = { turn: number; wordIndex: number; valence: Valence; start: number };

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
  const [active, setActive] = useState<ActiveHold | null>(null);
  const [liveMs, setLiveMs] = useState(0);
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
    const end = () => {
      const s = sref.current;
      if (!s) return;
      const t = now();
      const turn = s.turns[active.turn];
      const durationMs = t - active.start;
      const hold: Hold = {
        id: uid(),
        turn: active.turn,
        wordIndex: active.wordIndex,
        word: turn.words[active.wordIndex]?.text ?? "",
        valence: active.valence,
        start: active.start,
        end: t,
        durationMs,
        intensity: intensityFromMs(durationMs),
      };
      turn.holds.push(hold);
      setActive(null);
      setLiveMs(0);
      bump("now");
    };
    addEventListener("pointerup", end);
    addEventListener("pointercancel", end);
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener("pointerup", end);
      removeEventListener("pointercancel", end);
    };
  }, [active, bump]);

  const onWordDown = (turnIndex: number) => (i: number, e: RPointerEvent<HTMLSpanElement>) => {
    if (active) return;
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    const valence: Valence = e.button === 2 || e.shiftKey ? 1 : -1;
    setActive({ turn: turnIndex, wordIndex: i, valence, start: now() });
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
      turn.assistantRaw ||= "Sorry — the model request failed.";
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
    last?.holds.pop();
    bump("now");
  }

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

  return (
    <main className="min-h-screen bg-white text-[#0d0d0d]" onContextMenu={(e) => e.preventDefault()}>
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-black/5 bg-white/90 px-5 py-3 text-sm backdrop-blur">
        <div className="flex items-center gap-3">
          <span className="font-semibold">Frustration Lab</span>
          <span className="text-black/40">{s.participant} · turn {s.turns.length}</span>
        </div>
        <button
          onClick={finish}
          disabled={locked || s.turns.length === 0}
          className="rounded-full border border-black/10 px-3 py-1.5 hover:bg-black/5 disabled:opacity-40"
        >
          Finish → replay
        </button>
      </header>

      <div className="mx-auto max-w-3xl px-5 pb-48 pt-8 text-[16.5px]">
        {s.turns.length === 0 && (
          <div className="mt-24 text-center text-2xl font-medium text-black/80">What can I help with?</div>
        )}
        {s.turns.map((t) => {
          const isLive = active?.turn === t.index;
          const holds = isLive
            ? [...t.holds, { ...active!, id: "live", word: "", end: 0, durationMs: liveMs, intensity: intensityFromMs(liveMs) } as Hold]
            : t.holds;
          const { neg, pos } = wordScores(holds, t.words.length);
          const canLabel = t.labelSubmittedAt === null;
          return (
            <section key={t.index} className="mb-10">
              <div className="mb-6 flex justify-end">
                <div className="max-w-[75%] whitespace-pre-wrap rounded-3xl bg-[#e9eef6] px-5 py-2.5">{t.userText}</div>
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
                  />
                )}
              </div>
              {t.error && <div className="mt-2 text-sm text-red-600">Error: {t.error}</div>}
              {canLabel && t.streamEnd !== null && (
                <LabelBar turn={t} onUndo={undo} onSubmit={submitLabels} />
              )}
            </section>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div className="fixed inset-x-0 bottom-0 bg-gradient-to-t from-white via-white to-white/0 pb-6 pt-8">
        <form
          className="mx-auto flex max-w-3xl items-center gap-2 rounded-[28px] border border-black/10 bg-white px-5 py-3 shadow-[0_4px_24px_rgba(0,0,0,0.06)]"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input
            className="flex-1 bg-transparent py-1 outline-none placeholder:text-black/40 disabled:cursor-not-allowed"
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
            className="grid h-9 w-9 place-items-center rounded-full bg-black text-white disabled:bg-black/20"
            aria-label="Send"
          >
            ↑
          </button>
        </form>
      </div>
    </main>
  );
}

function LabelBar({
  turn,
  onUndo,
  onSubmit,
}: {
  turn: Turn;
  onUndo: () => void;
  onSubmit: (nothing: boolean) => void;
}) {
  const negs = turn.holds.filter((h) => h.valence < 0).length;
  const poss = turn.holds.length - negs;
  return (
    <div className="mt-5 rounded-2xl border border-black/10 bg-[#fafafa] p-4 text-sm">
      <div className="mb-3 text-black/70">
        <b className="text-black">Label this reply to continue.</b> Press and hold on words:{" "}
        <span className="rounded px-1" style={{ background: "rgba(240,90,110,0.25)" }}>left-click</span> = bothers you,{" "}
        <span className="rounded px-1" style={{ background: "rgba(34,170,120,0.25)" }}>right-click</span> (or ⇧+click) = you like it.
        Hold longer for stronger feelings.
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto text-black/50">
          {negs} dislike{negs === 1 ? "" : "s"} · {poss} like{poss === 1 ? "" : "s"}
        </span>
        <button onClick={onUndo} disabled={!turn.holds.length} className="rounded-full px-3 py-1.5 hover:bg-black/5 disabled:opacity-40">
          Undo
        </button>
        <button onClick={() => onSubmit(true)} disabled={turn.holds.length > 0} className="rounded-full border border-black/10 px-3 py-1.5 hover:bg-black/5 disabled:opacity-40">
          Nothing stood out
        </button>
        <button onClick={() => onSubmit(false)} disabled={!turn.holds.length} className="rounded-full bg-black px-4 py-1.5 text-white disabled:bg-black/20">
          Done labeling
        </button>
      </div>
    </div>
  );
}
