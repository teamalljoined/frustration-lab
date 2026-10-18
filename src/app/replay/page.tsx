"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { WordText } from "@/components/WordText";
import { wordScores } from "@/lib/heat";
import { download, getSession, intensityFromMs, saveSession } from "@/lib/store";
import { allHolds, frustrationSeries, rlhfRecords, sessionBounds, turnBands } from "@/lib/signal";
import type { Hold, Session } from "@/lib/types";

export default function ReplayPage() {
  return (
    <Suspense>
      <Replay />
    </Suspense>
  );
}

const ACCENT = "#c2416b";

/** Persistent overlay: ramps while held, stays at final intensity after. */
const heldAt = (h: Hold, t: number) => (t < h.start ? 0 : t <= h.end ? intensityFromMs(t - h.start) : h.intensity);

function Replay() {
  const id = useSearchParams().get("id");
  const [s, setS] = useState<Session | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [overlay, setOverlay] = useState(0.9);
  const [showTruth, setShowTruth] = useState(false);

  useEffect(() => {
    if (!id) return;
    const sess = getSession(id);
    setS(sess);
    setLoaded(true);
    if (sess) setT(sessionBounds(sess).t1);
  }, [id]);

  const bounds = useMemo(() => (s ? sessionBounds(s) : { t0: 0, t1: 1 }), [s]);
  const series = useMemo(() => (s ? frustrationSeries(s) : []), [s]);
  const bands = useMemo(() => (s ? turnBands(s) : []), [s]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (p: number) => {
      const dt = (p - last) * speed;
      last = p;
      setT((cur) => {
        const nxt = cur + dt;
        if (nxt >= bounds.t1) {
          setPlaying(false);
          return bounds.t1;
        }
        return nxt;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, bounds.t1]);

  const moments = useMemo(() => {
    if (!s) return [];
    return allHolds(s)
      .filter((h) => h.valence < 0)
      .sort((a, b) => b.intensity - a.intensity)
      .slice(0, 8)
      .map((h) => {
        const turn = s.turns[h.turn];
        const ctx = turn.words.slice(Math.max(0, h.wordIndex - 4), h.wordIndex + 6).map((w) => w.text).join(" ");
        return { h, ctx };
      });
  }, [s]);

  if (!id || (loaded && !s)) {
    return <main className="p-10 text-center">Session not found. <Link className="underline" href="/">Home</Link></main>;
  }
  if (!s) return null;

  function importPredicted(file: File) {
    file.text().then((txt) => {
      try {
        const raw = JSON.parse(txt) as { t: number; v: number }[];
        const pts = raw.map((p) => ({ t: p.t < 1e11 ? bounds.t0 + p.t * 1000 : p.t, v: Math.max(0, Math.min(1, p.v)) }));
        const next = { ...s!, predicted: pts };
        saveSession(next);
        setS(next);
      } catch {
        alert("Expected JSON array of {t, v}: t in epoch ms, or seconds from session start.");
      }
    });
  }

  const elapsed = ((t - bounds.t0) / 1000).toFixed(1);

  return (
    <main className="min-h-screen bg-[#f0f1f4] text-[#16181d]">
      <header className="flex flex-wrap items-center gap-3 px-6 py-4 text-sm">
        <Link href="/" className="font-semibold">Frustration Lab</Link>
        <span className="text-black/40">Replay · {s.participant} · {s.turns.length} turns</span>
        <span className="ml-auto flex flex-wrap gap-2">
          <label className="cursor-pointer rounded-full border border-black/10 bg-white px-3 py-1.5 hover:bg-black/5">
            Import predicted signal
            <input type="file" accept="application/json" className="hidden" onChange={(e) => e.target.files?.[0] && importPredicted(e.target.files[0])} />
          </label>
          <button
            className="rounded-full border border-black/10 bg-white px-3 py-1.5 hover:bg-black/5"
            onClick={() => download(`session-${s.id}.json`, JSON.stringify(s, null, 2))}
          >
            Session JSON
          </button>
          <button
            className="rounded-full border border-black/10 bg-white px-3 py-1.5 hover:bg-black/5"
            onClick={() => download(`labels-${s.id}.jsonl`, rlhfRecords(s).map((r) => JSON.stringify(r)).join("\n"), "application/x-ndjson")}
          >
            RLHF labels (.jsonl)
          </button>
          <Link href="/train" className="rounded-full bg-black px-3 py-1.5 text-white">Train →</Link>
        </span>
      </header>

      <div className="mx-auto grid max-w-[1400px] gap-6 px-6 pb-12 lg:grid-cols-[1fr_560px]">
        {/* Transcript as it looked at time t */}
        <section className="rounded-2xl border border-black/10 bg-white p-6 text-[16px] lg:max-h-[calc(100vh-100px)] lg:overflow-auto">
          {s.turns.filter((tr) => tr.submittedAt <= t).map((tr) => {
            const words = tr.words.filter((w) => w.shownAt <= t);
            const { neg, pos } = wordScores(
              tr.holds.map((h) => ({ ...h, intensity: heldAt(h, t) })),
              tr.words.length,
            );
            return (
              <div key={tr.index} className="mb-8">
                <div className="mb-4 flex justify-end">
                  <div className="max-w-[75%] rounded-3xl bg-[#e9eef6] px-5 py-2.5">
                    {tr.userText}
                    {showTruth && tr.perturbation.kind === "swap_prompt" && (
                      <div className="mt-1 text-xs text-black/50">↳ actually sent: “{tr.perturbation.sentPrompt}”</div>
                    )}
                  </div>
                </div>
                <WordText words={words} neg={neg} pos={pos} overlay={overlay} showInjected={showTruth} />
              </div>
            );
          })}
        </section>

        <div className="space-y-6">
          <section className="rounded-2xl border border-black/10 bg-white p-6">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-black/60">
                Frustration index over time
              </h2>
              <span className="font-mono text-xs text-black/40">
                {s.predicted?.length ? "predicted (imported)" : "derived from labels"}
              </span>
            </div>
            <Chart series={series} bands={bands} t0={bounds.t0} t1={bounds.t1} t={t} onSeek={(x) => { setPlaying(false); setT(x); }} />
            <div className="mt-4 flex items-center gap-4">
              <button
                onClick={() => {
                  if (!playing && t >= bounds.t1 - 1) setT(bounds.t0);
                  setPlaying(!playing);
                }}
                className="shrink-0 rounded-full bg-[#16181d] px-5 py-2.5 font-medium text-white"
              >
                {playing ? "Pause" : "Replay session"}
              </button>
              <input
                type="range" min={bounds.t0} max={bounds.t1} step={10} value={t}
                onChange={(e) => { setPlaying(false); setT(+e.target.value); }}
                className="w-full accent-[#c2416b]"
              />
            </div>
            <div className="mt-3 flex items-center gap-4 text-sm text-black/60">
              <span className="w-14">Overlay</span>
              <input type="range" min={0} max={1} step={0.05} value={overlay} onChange={(e) => setOverlay(+e.target.value)} className="w-full accent-[#c2416b]" />
              <span className="w-10 text-right font-mono">{Math.round(overlay * 100)}%</span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-black/60">
              <span className="font-mono">t = {elapsed}s</span>
              <label className="flex items-center gap-2">
                Speed
                <select value={speed} onChange={(e) => setSpeed(+e.target.value)} className="rounded border border-black/10 bg-white px-1 py-0.5">
                  {[1, 2, 4, 8, 16].map((x) => <option key={x} value={x}>{x}×</option>)}
                </select>
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={showTruth} onChange={(e) => setShowTruth(e.target.checked)} />
                Show hidden perturbations
              </label>
            </div>
          </section>

          <section className="rounded-2xl border border-black/10 bg-white p-6">
            <h2 className="mb-2 font-mono text-xs uppercase tracking-[0.2em] text-black/60">Strongest moments</h2>
            {moments.length === 0 && <p className="text-sm text-black/50">No negative holds in this session.</p>}
            <ul>
              {moments.map(({ h, ctx }) => (
                <li key={h.id}>
                  <button
                    onClick={() => { setPlaying(false); setT(h.end); }}
                    className="flex w-full items-center gap-4 rounded-xl px-3 py-3 text-left hover:bg-black/[0.03]"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-lg font-medium">{h.word}</span>
                      <span className="block truncate text-sm text-black/55">
                        T{h.turn + 1} · held {(h.durationMs / 1000).toFixed(1)}s · {ctx}
                      </span>
                    </span>
                    <span className="font-mono text-lg" style={{ color: ACCENT }}>{h.intensity.toFixed(2)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </main>
  );
}

function Chart({
  series, bands, t0, t1, t, onSeek,
}: {
  series: { t: number; v: number }[];
  bands: { label: string; start: number; end: number }[];
  t0: number; t1: number; t: number;
  onSeek: (t: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(500);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const H = 210, L = 44, R = 12, T = 10, B = 26;
  const iw = Math.max(10, w - L - R), ih = H - T - B;
  const x = (tt: number) => L + ((tt - t0) / (t1 - t0 || 1)) * iw;
  const y = (v: number) => T + (1 - v) * ih;
  const shown = series.filter((p) => p.t <= t);
  const path = shown.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const area = shown.length ? `${path}L${x(shown[shown.length - 1].t)},${y(0)}L${x(shown[0].t)},${y(0)}Z` : "";
  const valueAt = (tt: number) => {
    let best = series[0];
    for (const p of series) if (Math.abs(p.t - tt) < Math.abs(best.t - tt)) best = p;
    return best;
  };
  const cur = shown[shown.length - 1];
  const hv = hover !== null && series.length ? valueAt(hover) : null;

  const toT = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.max(t0, Math.min(t1, t0 + ((clientX - r.left - L) / iw) * (t1 - t0)));
  };

  return (
    <div ref={ref} className="relative select-none">
      <svg
        width={w} height={H} className="block cursor-crosshair"
        onMouseMove={(e) => setHover(toT(e.clientX))}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => onSeek(toT(e.clientX))}
        role="img" aria-label="Frustration index over time"
      >
        {bands.map((b) => (
          <g key={b.label}>
            <rect x={x(b.start)} y={T} width={Math.max(1, x(b.end) - x(b.start))} height={ih} fill="#e9eaee" opacity={0.7} />
            <text x={x(b.start) + 4} y={H - 8} fontSize={12} fontFamily="ui-monospace, monospace" fill="#6b6f78">{b.label}</text>
          </g>
        ))}
        {[0, 0.5, 1].map((g) => (
          <g key={g}>
            <line x1={L} x2={L + iw} y1={y(g)} y2={y(g)} stroke="#d9dbe0" strokeWidth={1} />
            <text x={L - 8} y={y(g) + 4} fontSize={12} textAnchor="end" fontFamily="ui-monospace, monospace" fill="#6b6f78">{g.toFixed(1)}</text>
          </g>
        ))}
        <path d={area} fill={ACCENT} opacity={0.12} />
        <path d={path} fill="none" stroke={ACCENT} strokeWidth={2} strokeLinejoin="round" />
        {cur && <circle cx={x(cur.t)} cy={y(cur.v)} r={5} fill={ACCENT} stroke="#fff" strokeWidth={2} />}
        {hv && (
          <g pointerEvents="none">
            <line x1={x(hv.t)} x2={x(hv.t)} y1={T} y2={T + ih} stroke="#16181d" strokeOpacity={0.3} />
            <circle cx={x(hv.t)} cy={y(hv.v)} r={4} fill="#fff" stroke={ACCENT} strokeWidth={2} />
          </g>
        )}
      </svg>
      {hv && (
        <div
          className="pointer-events-none absolute top-0 rounded-md bg-[#16181d] px-2 py-1 font-mono text-xs text-white"
          style={{ left: Math.min(w - 120, x(hv.t) + 8) }}
        >
          {((hv.t - t0) / 1000).toFixed(1)}s · {hv.v.toFixed(2)}
        </div>
      )}
    </div>
  );
}
