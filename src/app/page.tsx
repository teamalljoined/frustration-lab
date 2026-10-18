"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { DEFAULT_CONDITION, deleteSession, listSessions, now, saveSession, uid } from "@/lib/store";
import type { Condition, Session } from "@/lib/types";

export default function Home() {
  const router = useRouter();
  const [participant, setParticipant] = useState("P01");
  const [cond, setCond] = useState<Condition>(DEFAULT_CONDITION);
  const [sessions, setSessions] = useState<Session[]>([]);
  useEffect(() => setSessions(listSessions()), []);

  function start() {
    const s: Session = {
      id: uid(),
      participant: participant.trim() || "anon",
      createdAt: now(),
      endedAt: null,
      condition: cond,
      turns: [],
      events: [],
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    };
    saveSession(s);
    router.push(`/chat?id=${s.id}`);
  }

  const field = "w-full rounded-lg border border-black/10 bg-white px-3 py-2 outline-none focus:border-black/30";

  return (
    <main className="min-h-screen bg-[#f0f1f4] px-5 py-12 text-[#16181d]">
      <div className="mx-auto max-w-2xl space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">Frustration Lab</h1>
          <p className="mt-1 text-black/60">
            1 · Chat and label each reply by holding on words → 2 · Replay the frustration signal → 3 · Train (RLHF, coming soon)
          </p>
        </header>

        <section className="space-y-4 rounded-2xl border border-black/10 bg-white p-6">
          <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-black/50">New session</h2>
          <label className="block text-sm">
            Participant ID
            <input className={field} value={participant} onChange={(e) => setParticipant(e.target.value)} />
          </label>
          <label className="block text-sm">
            Model
            <input className={field} value={cond.model} onChange={(e) => setCond({ ...cond, model: e.target.value })} />
          </label>
          <label className="block text-sm">
            System prompt
            <textarea
              className={field + " h-24"}
              value={cond.systemPrompt}
              onChange={(e) => setCond({ ...cond, systemPrompt: e.target.value })}
            />
          </label>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <label className="block">
              Inject odd word every N turns <span className="text-black/40">(0 = off)</span>
              <input
                type="number" min={0} className={field} value={cond.injectEvery}
                onChange={(e) => setCond({ ...cond, injectEvery: Math.max(0, +e.target.value) })}
              />
            </label>
            <label className="block">
              Swap user prompt every N turns <span className="text-black/40">(0 = off)</span>
              <input
                type="number" min={0} className={field} value={cond.swapEvery}
                onChange={(e) => setCond({ ...cond, swapEvery: Math.max(0, +e.target.value) })}
              />
            </label>
          </div>
          <p className="text-xs text-black/50">
            Perturbations are hidden from the participant and logged as ground truth (which word was injected, which prompt
            was actually sent), so we can check label quality.
          </p>
          <button onClick={start} className="rounded-full bg-black px-5 py-2 text-white">
            Start chat →
          </button>
        </section>

        <section className="rounded-2xl border border-black/10 bg-white p-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-black/50">Sessions on this device</h2>
            <Link href="/train" className="text-sm underline">Train / export →</Link>
          </div>
          {sessions.length === 0 && <p className="text-sm text-black/50">None yet.</p>}
          <ul className="divide-y divide-black/5">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center gap-3 py-2 text-sm">
                <span className="font-medium">{s.participant}</span>
                <span className="text-black/50">
                  {new Date(s.createdAt).toLocaleString()} · {s.turns.length} turns ·{" "}
                  {s.turns.reduce((n, t) => n + t.holds.length, 0)} holds
                </span>
                <span className="ml-auto flex gap-3">
                  {!s.endedAt && <Link className="underline" href={`/chat?id=${s.id}`}>Resume</Link>}
                  <Link className="underline" href={`/replay?id=${s.id}`}>Replay</Link>
                  <button
                    className="text-black/40 hover:text-red-600"
                    onClick={() => {
                      if (confirm("Delete this session from this browser?")) {
                        deleteSession(s.id);
                        setSessions(listSessions());
                      }
                    }}
                  >
                    Delete
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
