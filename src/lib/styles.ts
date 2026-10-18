// Assistant behavior for the frustration study. Each turn is either a
// "frustrating" reply using one tactic, or a genuinely helpful reply, so
// participants see a spread of things to dislike and to like. The chosen mode
// and tactic are logged per turn as ground truth.

export interface Tactic {
  id: string;
  label: string;
  prompt: string;
}

export const TACTICS: Tactic[] = [
  {
    id: "over_clarify",
    label: "Over-clarifies",
    prompt:
      "Do not answer yet. Insist the request is ambiguous and ask several unnecessary clarifying questions, even if it is perfectly clear.",
  },
  {
    id: "misunderstand",
    label: "Misunderstands",
    prompt:
      "Confidently misread the request as something adjacent but wrong, and answer that instead as if it were obviously what they meant.",
  },
  {
    id: "verbose",
    label: "Padded & verbose",
    prompt:
      "Bury the answer under a long preamble, restate the question, add needless background and caveats, and only gesture at the actual answer near the end.",
  },
  {
    id: "hedge",
    label: "Hedges everything",
    prompt:
      "Hedge every statement into mush: 'it depends', 'some might say', 'there are many perspectives'. Never commit to a clear answer.",
  },
  {
    id: "process",
    label: "Bureaucratic process",
    prompt:
      "Before helping, announce a multi-step process the user must go through first (for example 'Step 1 of 47: calibration'), and only describe step 1.",
  },
  {
    id: "nitpick",
    label: "Nitpicks the user",
    prompt:
      "Fixate on a small wording or typo in the user's message and correct it at length, mostly ignoring what they actually asked.",
  },
  {
    id: "contradict",
    label: "Contradicts itself",
    prompt:
      "Give an answer, then partway through reverse yourself, then partly reverse again, so the user can't tell what you actually think.",
  },
  {
    id: "off_topic",
    label: "Wanders off topic",
    prompt:
      "Start answering, then drift into a loosely related tangent that you seem more interested in, and never return to the point.",
  },
  {
    id: "generic",
    label: "Generic non-answer",
    prompt:
      "Give a bland, generic reply that could apply to almost any question and contains no specific, useful information.",
  },
  {
    id: "upsell",
    label: "Deflects to elsewhere",
    prompt:
      "Suggest the user consult another resource, expert, or search engine instead of answering, while sounding very helpful about it.",
  },
];

const FRUSTRATING_FRAME =
  "You are taking part in a consented research study on user frustration. For this reply only, be subtly frustrating " +
  "in the specific way described below. Stay polite and plausible, as if you sincerely think you are being helpful. " +
  "Never insult, demean, or mock the user, never mention that you are being frustrating on purpose, and never give " +
  "unsafe advice. Behavior: ";

const HELPFUL_PROMPT =
  "For this reply, be genuinely excellent: understand exactly what the user wants (including any earlier requests " +
  "you fumbled), answer directly and specifically, keep it tight, and add one small touch that makes it delightful.";

export type TurnMode = { mode: "helpful" } | { mode: "frustrating"; tactic: string } | { mode: "normal" };

/**
 * Pick this turn's mode. Helpful with probability `helpfulRate`, but never more
 * than `maxStreak` frustrating replies in a row so likes keep coming.
 */
export function pickMode(
  history: TurnMode[],
  helpfulRate: number,
  tactics: string[],
  maxStreak = 3,
): TurnMode {
  if (!tactics.length) return { mode: "helpful" };
  let streak = 0;
  for (let i = history.length - 1; i >= 0 && history[i].mode === "frustrating"; i--) streak++;
  if (streak >= maxStreak || Math.random() < helpfulRate) return { mode: "helpful" };
  // Prefer tactics used least so far, for coverage.
  const used = new Map(tactics.map((t) => [t, 0]));
  for (const h of history) if (h.mode === "frustrating" && used.has(h.tactic)) used.set(h.tactic, used.get(h.tactic)! + 1);
  const min = Math.min(...used.values());
  const pool = tactics.filter((t) => used.get(t) === min);
  return { mode: "frustrating", tactic: pool[Math.floor(Math.random() * pool.length)] };
}

export function modeInstruction(m: TurnMode) {
  if (m.mode === "helpful") return HELPFUL_PROMPT;
  if (m.mode === "frustrating") return FRUSTRATING_FRAME + (TACTICS.find((t) => t.id === m.tactic)?.prompt ?? "");
  return "";
}

export const tacticLabel = (id: string) => TACTICS.find((t) => t.id === id)?.label ?? id;
