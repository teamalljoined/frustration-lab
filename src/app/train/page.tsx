"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { download, listSessions, saveSession } from "@/lib/store";
import { groundTruthEvals, rlhfRecords } from "@/lib/signal";
import type { Session } from "@/lib/types";

const pct = (x: number) => (Number.isNaN(x) ? "—" : `${Math.round(x * 100)}%`);
const num = (x: number) => (Number.isNaN(x) ? "—" : x.toFixed(2));

export default function TrainPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  useEffect(() => setSessions(listSessions()), []);

  const records = useMemo(() => sessions.flatMap(rlhfRecords), [sessions]);
  const ev = useMemo(() => groundTruthEvals(sessions), [sessions]);
  const nSpans = records.reduce((a, r) => a + r.spans.length, 0);
  const nNeg = records.reduce((a, r) => a + r.spans.filter((s) => s.valence < 0).length, 0);

  function importSessions(files: FileList) {
    Promise.all(Array.from(files).map((f) => f.text())).then((txts) => {
      for (const t of txts) {
        try {
          saveSession(JSON.parse(t));
        } catch {
          alert("Could not parse one of the files as a session JSON.");
        }
      }
      setSessions(listSessions());
    });
  }

  const card = "rounded-2xl border border-line bg-white p-6";
  const h2 = "mb-4 text-[13px] font-semibold text-ink";

  return (
    <main className="min-h-screen bg-page px-5 py-10 text-ink">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="flex items-center gap-3">
          <Link href="/" className="font-semibold">Frustration Lab</Link>
          <span className="text-muted">Phase 3 · RLHF training & evals</span>
        </header>

        <section className={card}>
          <h2 className={h2}>Dataset</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[
              ["Sessions", sessions.length],
              ["Labeled turns", records.length],
              ["Spans", nSpans],
              ["Negative spans", nNeg],
            ].map(([k, v]) => (
              <div key={k}>
                <div className="text-3xl font-semibold tabular-nums">{v}</div>
                <div className="text-sm text-ink-2">{k}</div>
              </div>
            ))}
          </div>
          <div className="mt-5 flex flex-wrap gap-2 text-sm">
            <button
              disabled={!records.length}
              onClick={() => download("frustration-labels.jsonl", records.map((r) => JSON.stringify(r)).join("\n"), "application/x-ndjson")}
              className="rounded-full bg-ink px-4 py-2 text-white disabled:bg-axis"
            >
              Export all labels (.jsonl)
            </button>
            <label className="cursor-pointer rounded-full border border-line px-4 py-2 hover:bg-black/5">
              Import session JSON(s)
              <input type="file" multiple accept="application/json" className="hidden" onChange={(e) => e.target.files && importSessions(e.target.files)} />
            </label>
          </div>
          <p className="mt-3 text-xs text-muted">
            Each record: context, prompt shown vs. sent, displayed response, per-word reward in [-1, 1], merged spans with
            valence / intensity / hold timestamps, and the hidden perturbation. Sessions live in this browser only, so
            export them or import from other machines to pool data.
          </p>
        </section>

        <section className={card}>
          <h2 className={h2}>Label-quality evals (vs. hidden ground truth)</h2>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-line-soft">
              <tr><td className="py-2">Injected-word turns</td><td className="text-right tabular-nums">{ev.injectTurns}</td></tr>
              <tr><td className="py-2">…injected word ended net-negative (exact)</td><td className="text-right tabular-nums">{pct(ev.injectExactHit)}</td></tr>
              <tr><td className="py-2">…within ±1 word</td><td className="text-right tabular-nums">{pct(ev.injectNearHit)}</td></tr>
              <tr><td className="py-2">Swapped-prompt turns</td><td className="text-right tabular-nums">{ev.swapTurns}</td></tr>
              <tr><td className="py-2">Mean dislike mass · swapped turns</td><td className="text-right tabular-nums">{num(ev.swapNegMass)}</td></tr>
              <tr><td className="py-2">Mean dislike mass · clean turns ({ev.cleanTurns})</td><td className="text-right tabular-nums">{num(ev.cleanNegMass)}</td></tr>
            </tbody>
          </table>
        </section>

        <section className={card + " border-dashed"}>
          <div className="flex items-center justify-between">
            <h2 className={h2 + " mb-0"}>Training</h2>
            <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs text-muted">placeholder</span>
          </div>
          <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm text-ink-2">
            <li><b>Reward model:</b> token-level head trained on per-word rewards (spans projected to tokens), optionally conditioned on the EEG / eye-tracking frustration signal.</li>
            <li><b>Policy update:</b> span-weighted DPO (preferred = response with disliked spans rewritten) or PPO with dense per-token rewards.</li>
            <li><b>Evals:</b> held-out participants — reward-model AUC on injected words, frustration index on fresh sessions before vs. after fine-tuning.</li>
          </ol>
          <button disabled className="mt-5 rounded-full bg-axis px-4 py-2 text-sm text-white">Start training run (coming soon)</button>
        </section>
      </div>
    </main>
  );
}
