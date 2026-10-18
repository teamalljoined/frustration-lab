import type { Chunk, Turn, Word } from "./types";

const SENTENCE_END = /[.!?…]["'”’)\]]*$/;

/**
 * Split a reply into short reading chunks: whole sentences, grouped until a
 * chunk has at least `min` words. Paragraph breaks always end a chunk, and a
 * run-on sentence is cut at `max` words (preferring a comma).
 */
export function chunkWords(words: Word[], min = 12, max = 32): Chunk[] {
  const chunks: Chunk[] = [];
  let start = 0;
  const push = (end: number) => {
    if (end > start) chunks.push({ i: chunks.length, start, end, shownAt: null, readAt: null, labeledAt: null });
    start = end;
  };
  for (let i = 0; i < words.length; i++) {
    const len = i - start + 1;
    const next = words[i + 1];
    const paraBreak = !next || next.para !== words[i].para;
    const sentence = SENTENCE_END.test(words[i].text);
    if (paraBreak || (sentence && len >= min)) push(i + 1);
    else if (len >= max) {
      // Cut a run-on at the last comma inside the window, else here.
      let cut = i + 1;
      for (let j = i; j > start + min / 2; j--) if (/,$/.test(words[j].text)) { cut = j + 1; break; }
      push(cut);
    }
  }
  push(words.length);
  // Fold a tiny trailing chunk into the previous one.
  const lastC = chunks[chunks.length - 1];
  if (chunks.length > 1 && lastC.end - lastC.start < 4) {
    chunks[chunks.length - 2].end = lastC.end;
    chunks.pop();
  }
  return chunks;
}

export type Phase =
  | { kind: "read" | "label"; chunk: Chunk; n: number }
  | { kind: "review" }
  | { kind: "done" };

/** Where a turn is in read → label → … → review. Older turns without chunks go straight to review. */
export function phaseOf(t: Turn): Phase {
  if (t.labelSubmittedAt !== null) return { kind: "done" };
  if (!t.chunks?.length) return { kind: "review" };
  const chunk = t.chunks.find((c) => c.labeledAt === null);
  if (!chunk) return { kind: "review" };
  return { kind: chunk.readAt === null ? "read" : "label", chunk, n: t.chunks.length };
}
