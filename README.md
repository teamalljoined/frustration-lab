# Frustration Lab

Participants chat with an LLM and label each reply by **pressing and holding on words**. These labels become span-level preference data for RLHF, time-aligned with EEG / eye tracking / screen recording.

## Phases

1. **Chat** (`/chat`) — ChatGPT-style window. After each reply the input stays locked until the participant labels it:
   - **Hold click** = dislike, **hold ⇧+click** (or right-click) = like. Hold duration sets intensity (linear, saturates at 2 s).
   - Scores are signed and add up per word, clamped to [-1, 1], so an opposite hold pulls a word back toward neutral.
   - Press and drag across words to mark several in one stroke; time spent on each word sets its intensity (swept words get at least 0.25). Ctrl+click also counts as like, since a Mac "right-click" is ctrl+click.
   - Side panel: legend plus a live like/dislike gauge, and a score badge above the word being held. Hotkeys: `Enter` continues (and records "nothing stood out" if no words are marked), `Esc` resets.
   - Holds work while the reply is still streaming, so reactions during reading are captured.
2. **Replay** (`/replay?id=…`): lines labels up with what the participant was reading. Labels are made *after* reading, so they mark which words matter, while EEG and gaze give the timing.
   - **EEG signal**: CSV `t,v` (or JSON `[{t, v}]`).
   - **Gaze**: CSV `t,x,y` in screen or viewport px. Each sample is mapped to a word using the logged word boxes, scroll position and window placement, then consecutive hits are merged into fixations. Without gaze, word onset times stand in for fixations.
   - `t` is epoch ms (same clock as the app), or seconds from session start.
   - The view shows the signal, a gaze lane colored by each word's label, a transcript with a gaze cursor, mean EEG at fixation by label group (with adjustable lag), and a per-word table.
   - "Generate synthetic demo" fills in fake data for trying the view. It's flagged as synthetic in the UI.
3. **Train** (`/train`) — dataset stats, JSONL export/import, and label-quality evals against hidden ground truth. Training itself is a placeholder.

## Assistant behavior (frustration study)

With **Frustration study** selected on the home page (the default), each reply is secretly one of:
- **Frustrating**: one tactic per reply, e.g. over-clarifying, misunderstanding, padding, hedging, a "Step 1 of 47" process, nitpicking, contradicting itself, wandering off topic, a generic non-answer, or deflecting elsewhere. The next tactic is the least-used one so far, for even coverage. Tactics stay polite and are never insulting or unsafe.
- **Genuinely helpful**: a direct, excellent answer, which gives participants things to *like*.

The helpful rate is adjustable (default 30%), with at most 3 frustrating replies in a row. Mode and tactic are logged per turn (`style` in the export) and summarized on `/train`. Participants should consent to an assistant that may be deliberately unhelpful.

## Grounded perturbations (for training signal)

These are set per session on the home page, are hidden from the participant, and are logged:
- **Inject odd word every N turns**: an out-of-place word (e.g. "pancake") is spliced into the reply while it streams.
- **Swap prompt every N turns**: the model receives a different prompt than the one the participant typed.

## Logged data

All timestamps are epoch ms with sub-ms precision (`performance.timeOrigin + performance.now()`).
- Per turn: user text, typing start, submit time, prompt actually sent, raw and displayed reply, **per-word `shownAt`**, stream start and end, holds (`wordIndex, valence, start, end, durationMs, intensity`), label submit time, and the perturbation.
- **Word bounding boxes** (document coordinates) after rendering and labeling, plus scroll, resize, focus and blur events. These let you map gaze from the eye tracker to words.
- RLHF JSONL, one record per labeled turn: context, `prompt_shown` / `prompt_sent`, `response`, `words`, merged `spans`, dense `word_reward ∈ [-1,1]`, and perturbation.

Sessions are stored in the browser's `localStorage`. Export them to pool data across machines.

## Run

```bash
cp .env.example .env.local   # add OPENAI_API_KEY
npm install && npm run dev
```

Without a key, `/api/chat` streams a mock reply so the UI still works.

## Deploy (Vercel)

Import the repo in Vercel, or run `npx vercel`, then set `OPENAI_API_KEY` (and optionally `OPENAI_MODEL`) in Project → Settings → Environment Variables.
