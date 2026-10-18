"use client";

import type { Condition, Session, Word } from "./types";

const KEY = "frustration-lab:sessions";

export const now = () => performance.timeOrigin + performance.now();

export const uid = () =>
  Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

export const DEFAULT_CONDITION: Condition = {
  model: "gpt-4.1-mini",
  systemPrompt:
    "You are a helpful assistant. Reply in plain text only: no markdown, no bullet lists, no headings. Keep replies under 120 words.",
  injectEvery: 0,
  swapEvery: 0,
};

export const ODD_WORDS = [
  "giraffe", "trombone", "pancake", "volcano", "umbrella", "cactus",
  "submarine", "accordion", "walrus", "lighthouse", "spatula", "marmalade",
];

export const SWAP_PROMPTS = [
  "Tell me about the history of the stapler.",
  "What is the average lifespan of a goldfish?",
  "Describe how to fold a paper crane.",
  "Explain the rules of curling.",
  "What are some fun facts about Saturn's moons?",
  "Write a short poem about a parking lot.",
];

function safeRead(): Record<string, Session> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}

export function listSessions(): Session[] {
  return Object.values(safeRead()).sort((a, b) => b.createdAt - a.createdAt);
}

export function getSession(id: string): Session | null {
  return safeRead()[id] ?? null;
}

export function saveSession(s: Session) {
  const all = safeRead();
  all[s.id] = s;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch (e) {
    console.error("Failed to persist session", e);
  }
}

export function deleteSession(id: string) {
  const all = safeRead();
  delete all[id];
  localStorage.setItem(KEY, JSON.stringify(all));
}

export function download(name: string, text: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Hold duration -> intensity. Saturates at 2s. */
export const intensityFromMs = (ms: number) => Math.min(1, ms / 2000);

/**
 * Tokenize streamed text into words, preserving the first time each word was
 * shown. Words keep trailing punctuation; blank lines start new paragraphs.
 */
export function tokenize(text: string, prev: Word[], t: number): Word[] {
  const out: Word[] = [];
  const paras = text.split(/\n+/);
  let i = 0;
  paras.forEach((p, para) => {
    for (const w of p.split(/\s+/).filter(Boolean)) {
      out.push({ i, text: w, para, shownAt: prev[i]?.shownAt ?? t });
      i++;
    }
  });
  return out;
}
