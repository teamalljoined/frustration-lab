"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { WordText } from "@/components/WordText";
import { wordScores } from "@/lib/heat";
import { download, getSession, saveSession } from "@/lib/store";
import { rlhfRecords, sessionBounds, turnBands } from "@/lib/signal";
import {
  gazeToFixations, groupMeans, onsetFixations, parseRows, syntheticData, wordStats,
  type GazeCoords, type Series,
} from "@/lib/align";
import type { Fixation, Session } from "@/lib/types";
import { tacticLabel } from "@/lib/styles";

export default function ReplayPage() {
  return (
    <Suspense>
      <Replay />
    </Suspense>
  );
}

const SIGNAL = "#0b0b0b";
const NEG = "#e34948";
const POS = "#2a78d6";
const fmt = (x: number, d = 2) => (Number.isNaN(x) ? "—" : x.toFixed(d));
const labelColor = (v: number) => (v <= -0.01 ? NEG : v >= 0.01 ? POS : "#c3c2b7");

function Replay() {
  const id = useSearchParams().get("id");
  const [s, setS] = useState<Session | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [lag, setLag] = useState(300);
  const [showLabels, setShowLabels] = useState(true);
  const [showTruth, setShowTruth] = useState(false);
  const [coords, setCoords] = useState<GazeCoords>("screen");
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!id) return;
    const sess = getSession(id);
    setS(sess);
    setLoaded(true);
    if (sess) setT(sessionBounds(sess).t0);
  }, [id]);

  const series: Series = useMemo(() => s?.signal ?? s?.predicted ?? [], [s]);
  const hasGaze = !!s?.fixations?.length;
  const fixations: Fixation[] = useMemo(() => (s ? (hasGaze ? s.fixations! : onsetFixations(s)) : []), [s, hasGaze]);
  const bounds = useMemo(() => {
    if (!s) return { t0: 0, t1: 1 };
    const b = sessionBounds(s);
    return { t0: b.t0, t1: Math.max(b.t1, ...fixations.map((f) => f.end)) };
  }, [s, fixations]);
  const bands = useMemo(() => (s ? turnBands(s) : []), [s]);
  const stats = useMemo(() => (s ? wordStats(s, fixations, series, lag) : []), [s, fixations, series, lag]);
  const groups = useMemo(() => groupMeans(stats), [stats]);
  const labeled = useMemo(
    () => stats.filter((st) => Math.abs(st.label) >= 0.01).sort((a, b) => a.label - b.label),
    [stats],
  );
  const nets = useMemo(() => (s ? s.turns.map((tr) => wordScores(tr.holds, tr.words.length).net) : []), [s]);
  const current = fixations.find((f) => f.start <= t && t <= f.end);

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

  // Keep the gazed word in view during playback.
  useEffect(() => {
    if (!current) return;
    const box = transcriptRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-turn="${current.turn}"] [data-w="${current.wordIndex}"]`);
    if (!box || !el) return;
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top;
    if (top < 40 || top > box.clientHeight - 40) box.scrollTop += top - box.clientHeight / 3;
  }, [current]);

  if (!id || (loaded && !s)) {
    return <main className="p-10 text-center">Session not found. <Link className="underline" href="/">Home</Link></main>;
  }
  if (!s) return null;

  const update = (patch: Partial<Session>) => {
    const next = { ...s, ...patch };
    saveSession(next);
    setS(next);
  };

  async function importSignal(file: File) {
    try {
      const rows = parseRows(await file.text(), bounds.t0);
      const key = Object.keys(rows[0] ?? {}).find((k) => k !== "t") ?? "v";
      update({ signal: rows.map((r) => ({ t: r.t, v: r[key] })), signalSource: file.name, synthetic: false });
    } catch {
      alert("Expected CSV with columns t,v (or JSON [{t, v}]). t = epoch ms, or seconds from session start.");
    }
  }

  async function importGaze(file: File) {
    try {
      const rows = parseRows(await file.text(), bounds.t0).map((r) => ({ t: r.t, x: r.x, y: r.y }));
      const fx = gazeToFixations(s!, rows, coords);
      update({ fixations: fx, gazeSource: `${file.name} (${coords} px, ${rows.length} samples)`, synthetic: false });
      if (!fx.length) alert("No gaze samples landed on words. Check the coordinate space and clock alignment.");
    } catch {
      alert("Expected CSV with columns t,x,y (or JSON [{t, x, y}]).");
    }
  }

  const btn = "rounded-full border border-line bg-white px-3 py-1.5 hover:bg-black/5";

  return (
    <main className="min-h-screen bg-page text-ink">
      <header className="flex flex-wrap items-center gap-3 px-6 py-4 text-sm">
        <Link href="/" className="font-semibold">Frustration Lab</Link>
        <span className="text-muted">Replay · {s.participant} · {s.turns.length} turns</span>
        <span className="ml-auto flex flex-wrap gap-2">
          <button className={btn} onClick={() => download(`session-${s.id}.json`, JSON.stringify(s, null, 2))}>Session JSON</button>
          <button
            className={btn}
            onClick={() => download(`labels-${s.id}.jsonl`, rlhfRecords(s).map((r) => JSON.stringify(r)).join("\n"), "application/x-ndjson")}
          >
            RLHF labels (.jsonl)
          </button>
          <Link href="/train" className="rounded-full bg-ink px-3 py-1.5 text-white">Train →</Link>
        </span>
      </header>

      {s.synthetic && (
        <div className="mx-6 mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          Showing <b>synthetic demo</b> EEG + gaze, generated from the labels. Import real recordings to replace it.
        </div>
      )}

      <div className="mx-auto max-w-[1400px] space-y-6 px-6 pb-12">
        {/* Sources */}
        <section className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl border border-line bg-white px-6 py-4 text-sm">
          <Source label="EEG signal" value={series.length ? (s.synthetic ? "synthetic demo" : s.signalSource ?? "imported") : "none"}>
            <FileButton onFile={importSignal}>Import t,v</FileButton>
          </Source>
          <Source label="Gaze" value={hasGaze ? (s.synthetic ? "synthetic demo" : s.gazeSource ?? "imported") : "none → using word onsets"}>
            <select value={coords} onChange={(e) => setCoords(e.target.value as GazeCoords)} className="rounded border border-line bg-white px-1 py-1">
              <option value="screen">screen px</option>
              <option value="viewport">viewport px</option>
            </select>
            <FileButton onFile={importGaze}>Import t,x,y</FileButton>
          </Source>
          <button
            className="ml-auto text-muted underline hover:text-black"
            onClick={() => update({ ...syntheticData(s), synthetic: true, signalSource: undefined, gazeSource: undefined })}
          >
            Generate synthetic demo
          </button>
          {(series.length > 0 || hasGaze) && (
            <button className="text-muted underline hover:text-red-600" onClick={() => update({ signal: undefined, predicted: undefined, fixations: undefined, synthetic: false })}>
              Clear imports
            </button>
          )}
        </section>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="min-w-0 space-y-6">
            {/* Timeline */}
            <section className="rounded-2xl border border-line bg-white p-6">
              <div className="mb-3 flex items-baseline justify-between">
                <h2 className="text-[13px] font-semibold text-ink">EEG signal × what they were reading</h2>
                <span className="font-mono text-xs text-muted">t = {((t - bounds.t0) / 1000).toFixed(1)}s</span>
              </div>
              <Timeline
                series={series} fixations={fixations} nets={nets} bands={bands}
                t0={bounds.t0} t1={bounds.t1} t={t} lag={lag}
                onSeek={(x) => { setPlaying(false); setT(x); }}
                wordOf={(f) => s.turns[f.turn]?.words[f.wordIndex]?.text ?? ""}
              />
              <div className="mt-4 flex items-center gap-4">
                <button
                  onClick={() => {
                    if (!playing && t >= bounds.t1 - 1) setT(bounds.t0);
                    setPlaying(!playing);
                  }}
                  className="shrink-0 rounded-full bg-ink px-5 py-2.5 font-medium text-white"
                >
                  {playing ? "Pause" : "Replay"}
                </button>
                <input
                  type="range" min={bounds.t0} max={bounds.t1} step={10} value={t}
                  onChange={(e) => { setPlaying(false); setT(+e.target.value); }}
                  className="w-full accent-ink"
                />
                <select value={speed} onChange={(e) => setSpeed(+e.target.value)} className="rounded border border-line bg-white px-1 py-1 text-sm">
                  {[0.5, 1, 2, 4].map((x) => <option key={x} value={x}>{x}×</option>)}
                </select>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-ink-2">
                <label className="flex items-center gap-2">
                  EEG lag
                  <input type="range" min={0} max={1000} step={50} value={lag} onChange={(e) => setLag(+e.target.value)} className="w-32 accent-ink" />
                  <span className="w-14 font-mono">{lag} ms</span>
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />
                  Show labels
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={showTruth} onChange={(e) => setShowTruth(e.target.checked)} />
                  Show hidden behavior & perturbations
                </label>
              </div>
            </section>

            {/* Transcript at time t with gaze cursor */}
            <section ref={transcriptRef} className="max-h-[520px] overflow-auto rounded-2xl border border-line bg-white p-6 text-[16px]">
              {s.turns.filter((tr) => tr.submittedAt <= t).map((tr) => {
                const words = tr.words.filter((w) => w.shownAt <= t);
                const net = nets[tr.index];
                return (
                  <div key={tr.index} className="mb-8" data-turn={tr.index}>
                    <div className="mb-4 flex justify-end">
                      <div className="max-w-[75%] rounded-3xl bg-mid px-5 py-2.5">
                        {tr.userText}
                        {showTruth && tr.perturbation.kind === "swap_prompt" && (
                          <div className="mt-1 text-xs text-muted">↳ actually sent: “{tr.perturbation.sentPrompt}”</div>
                        )}
                      </div>
                    </div>
                    {showTruth && tr.style && tr.style.mode !== "normal" && (
                      <div className={"mb-2 inline-block rounded-full px-2 py-0.5 text-xs " + (tr.style.mode === "helpful" ? "bg-pos/10 text-pos" : "bg-neg/10 text-neg")}>
                        {tr.style.mode === "helpful" ? "helpful" : `frustrating · ${tacticLabel(tr.style.tactic)}`}
                      </div>
                    )}
                    <WordText
                      words={words}
                      neg={showLabels ? net.map((v) => Math.max(0, -v)) : []}
                      pos={showLabels ? net.map((v) => Math.max(0, v)) : []}
                      overlay={0.8}
                      showInjected={showTruth}
                      cursor={current?.turn === tr.index ? current.wordIndex : undefined}
                    />
                  </div>
                );
              })}
            </section>
          </div>

          <div className="space-y-6">
            {/* Summary: does the signal differ by label? */}
            <section className="rounded-2xl border border-line bg-white p-6">
              <h2 className="mb-1 text-[13px] font-semibold text-ink">Signal while fixating</h2>
              <p className="mb-4 text-xs text-muted">
                Mean EEG over each fixation (+{lag} ms lag), grouped by how the word was labeled afterwards.
                {!hasGaze && " No gaze imported: word onsets stand in for fixations."}
              </p>
              <div className="grid grid-cols-3 gap-3">
                {([["disliked", NEG], ["neutral", "#c3c2b7"], ["liked", POS]] as const).map(([k, c]) => (
                  <div key={k} className="rounded-xl bg-page p-3">
                    <div className="flex items-center gap-1.5 text-xs text-ink-2">
                      <span className="h-2 w-2 rounded-full" style={{ background: c }} />
                      {k}
                    </div>
                    <div className="mt-1 text-2xl font-semibold">{fmt(groups[k].mean)}</div>
                    <div className="text-xs text-muted">{groups[k].n} word{groups[k].n === 1 ? "" : "s"}</div>
                  </div>
                ))}
              </div>
              {!series.length && <p className="mt-3 text-xs text-muted">Import an EEG signal to fill these in.</p>}
            </section>

            {/* Labeled words */}
            <section className="rounded-2xl border border-line bg-white p-6">
              <h2 className="mb-3 text-[13px] font-semibold text-ink">Labeled words</h2>
              {labeled.length === 0 && <p className="text-sm text-muted">No labeled words in this session.</p>}
              <table className="w-full text-sm">
                {labeled.length > 0 && (
                  <thead className="text-left text-xs text-muted">
                    <tr>
                      <th className="pb-2 font-normal">Word</th>
                      <th className="pb-2 text-right font-normal">Label</th>
                      <th className="pb-2 text-right font-normal">Dwell</th>
                      <th className="pb-2 text-right font-normal">EEG</th>
                    </tr>
                  </thead>
                )}
                <tbody>
                  {labeled.map((st) => (
                    <tr
                      key={`${st.turn}:${st.wordIndex}`}
                      onClick={() => { setPlaying(false); if (st.fixations[0]) setT(st.fixations[0].start); }}
                      className="cursor-pointer border-t border-line-soft hover:bg-black/[0.03]"
                    >
                      <td className="max-w-[160px] truncate py-2 font-medium">
                        {st.word}
                        <span className="ml-1.5 text-xs font-normal text-muted">T{st.turn + 1}</span>
                      </td>
                      <td className="text-right font-mono tabular-nums" style={{ color: labelColor(st.label) }}>
                        {st.label > 0 ? "+" : ""}{st.label.toFixed(2)}
                      </td>
                      <td className="text-right font-mono tabular-nums text-ink-2">
                        {st.fixations.length ? `${Math.round(st.dwellMs)}ms×${st.fixations.length}` : "not seen"}
                      </td>
                      <td className="text-right font-mono tabular-nums">{fmt(st.meanSignal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}

function Source({ label, value, children }: { label: string; value: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <div>
        <div className="text-[13px] font-semibold text-ink">{label}</div>
        <div className="max-w-[260px] truncate text-ink">{value}</div>
      </div>
      {children}
    </div>
  );
}

function FileButton({ onFile, children }: { onFile: (f: File) => void; children: React.ReactNode }) {
  return (
    <label className="cursor-pointer rounded-full border border-line px-3 py-1.5 hover:bg-black/5">
      {children}
      <input
        type="file" accept=".csv,.tsv,.json,text/csv,application/json" className="hidden"
        onChange={(e) => {
          if (e.target.files?.[0]) onFile(e.target.files[0]);
          e.target.value = "";
        }}
      />
    </label>
  );
}

function Timeline({
  series, fixations, nets, bands, t0, t1, t, lag, onSeek, wordOf,
}: {
  series: Series;
  fixations: Fixation[];
  nets: number[][];
  bands: { label: string; start: number; end: number }[];
  t0: number; t1: number; t: number; lag: number;
  onSeek: (t: number) => void;
  wordOf: (f: Fixation) => string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const L = 40, R = 10, T = 8, SIG_H = 150, GAP = 14, LANE_H = 22, AX = 22;
  const H = T + SIG_H + GAP + LANE_H + AX;
  const iw = Math.max(10, w - L - R);
  const x = (tt: number) => L + ((tt - t0) / (t1 - t0 || 1)) * iw;
  const lo = series.length ? Math.min(...series.map((p) => p.v)) : 0;
  const hi = series.length ? Math.max(...series.map((p) => p.v)) : 1;
  const span = hi - lo || 1;
  const y = (v: number) => T + (1 - (v - lo) / span) * SIG_H;
  const path = series.filter((p) => p.t >= t0 && p.t <= t1)
    .map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const laneY = T + SIG_H + GAP;
  const toT = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.max(t0, Math.min(t1, t0 + ((clientX - r.left - L) / iw) * (t1 - t0)));
  };
  const hv = hover !== null ? fixations.find((f) => f.start <= hover && hover <= f.end) : undefined;

  return (
    <div ref={ref} className="relative select-none">
      <svg
        width={w} height={H} className="block cursor-crosshair" role="img"
        aria-label="EEG signal over time with word fixations colored by label"
        onMouseMove={(e) => setHover(toT(e.clientX))}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => onSeek(toT(e.clientX))}
      >
        {bands.map((b) => (
          <g key={b.label}>
            <rect x={x(b.start)} y={T} width={Math.max(1, x(b.end) - x(b.start))} height={SIG_H + GAP + LANE_H} fill="#f4f3ef" />
            <text x={x(b.start) + 4} y={H - 6} fontSize={11} fontFamily="ui-monospace, monospace" fill="#898781">{b.label}</text>
          </g>
        ))}
        {series.length > 0 ? (
          <>
            {[lo, (lo + hi) / 2, hi].map((g) => (
              <g key={g}>
                <line x1={L} x2={L + iw} y1={y(g)} y2={y(g)} stroke="#e1e0d9" />
                <text x={L - 6} y={y(g) + 4} fontSize={11} textAnchor="end" fontFamily="ui-monospace, monospace" fill="#898781">{g.toFixed(2)}</text>
              </g>
            ))}
            <path d={path} fill="none" stroke="#52514e" strokeWidth={1.25} strokeLinejoin="round" />
          </>
        ) : (
          <text x={L + iw / 2} y={T + SIG_H / 2} textAnchor="middle" fontSize={13} fill="#c3c2b7">
            No EEG signal imported
          </text>
        )}
        {/* Gaze lane: each fixation, colored by the word's later label */}
        <text x={L - 6} y={laneY + LANE_H / 2 + 4} fontSize={11} textAnchor="end" fontFamily="ui-monospace, monospace" fill="#898781">gaze</text>
        {fixations.map((f, i) => {
          const v = nets[f.turn]?.[f.wordIndex] ?? 0;
          const labeled = Math.abs(v) >= 0.01;
          return (
            <rect
              key={i} x={x(f.start)} y={labeled ? laneY : laneY + LANE_H / 2 - 2}
              width={Math.max(2, x(f.end) - x(f.start))} height={labeled ? LANE_H : 4} rx={1}
              fill={labelColor(v)} opacity={labeled ? 0.35 + 0.65 * Math.abs(v) : 0.35}
            />
          );
        })}
        {/* Lag-shifted guides from labeled fixations up into the signal */}
        {series.length > 0 && fixations.filter((f) => Math.abs(nets[f.turn]?.[f.wordIndex] ?? 0) >= 0.01).map((f, i) => (
          <line key={`g${i}`} x1={x(f.start + lag)} x2={x(f.start + lag)} y1={T} y2={T + SIG_H}
            stroke={labelColor(nets[f.turn][f.wordIndex])} strokeOpacity={0.25} strokeDasharray="2 3" />
        ))}
        <line x1={x(t)} x2={x(t)} y1={T} y2={laneY + LANE_H} stroke={SIGNAL} strokeWidth={1.5} />
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={laneY + LANE_H} stroke={SIGNAL} strokeOpacity={0.25} pointerEvents="none" />}
      </svg>
      {hover !== null && (
        <div
          className="pointer-events-none absolute top-0 rounded-md bg-ink px-2 py-1 font-mono text-xs text-white"
          style={{ left: Math.min(w - 180, x(hover) + 8) }}
        >
          {((hover - t0) / 1000).toFixed(2)}s{hv ? ` · “${wordOf(hv)}”` : ""}
        </div>
      )}
    </div>
  );
}
