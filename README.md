# Frustration Lab

Participants chat with an LLM and label each reply by **pressing and holding on words**. These labels become span-level preference data for RLHF, time-aligned with EEG / eye tracking / screen recording.

## Phases

1. **Chat** (`/chat`) — ChatGPT-style window. After each reply the input stays locked until the participant labels it:
   - **Left-click hold** = dislike, **right-click hold** (or ⇧+click) = like.
   - Hold duration sets intensity (linear, saturates at 2 s). Repeated holds on a word add up (capped at 1).
   - "Nothing stood out" submits an explicit null label.
   - Holds work while the reply is still streaming, so reactions during reading are captured.
2. **Replay** (`/replay?id=…`) — frustration index over time (turn windows shaded), a scrubbable transcript with heat overlay, an overlay-opacity slider, and a list of the strongest moments. "Import predicted signal" replaces the label-derived curve with a model's output (JSON `[{t, v}]`, where `t` is epoch ms or seconds from session start).
3. **Train** (`/train`) — dataset stats, JSONL export/import, and label-quality evals against hidden ground truth. Training itself is a placeholder.

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
