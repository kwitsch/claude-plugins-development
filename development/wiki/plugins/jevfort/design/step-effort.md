# Per-step effort (`stepEffort`, 0.13.0)

The constraint is in `jevfort/.claude/rules/effort-routing.md`; the code is `stepRouted` in `jevfort/src/hooks/register.ts` and `stepEffortQuestion` in `jevfort/src/hooks/policy.ts`.

## What it does

With `stepEffort: true` (default `false`) every Opus/Sonnet step `k > 0` that is handed to the model asks Jev one `step_effort` score question in its own `askJev` call, with `state = { request, effort, delta }`: `effort` is the effort the previous model call of the turn ran at, `delta` the summarized steps since Jev's last answered effort question in the turn (`turn.seen`). The answer goes through `estimateEffort` (same 0-4 scale and `EFFORT_LEVELS`, so `EFFORT_CUTS` and the `minEffort`/`maxEffort` clamp apply unchanged) and sets the step's effort, the band's `chosen` (main loop only) and one debug-log line `… · step <n> · <source>`.

## Decisions

- **Only Opus/Sonnet.** An effort change rewrites the prompt cache of Haiku/Fable (the reason for their first-turn hold); Opus/Sonnet are effort-agnostic for the cache. The gate reuses `EVERY_TURN_MODELS`. The cache claim is the user's premise and the existing rule's reason; it was not re-measured.
- **Fallback order (user decision, changed 0.13.1 on 2026-11-18).** A failed Jev request (unavailable, timed out, paused or denied; a score that is no number fails the whole decision in `askJev`) turns the scoring off for the rest of the turn (`turn.stepOff`): the failed step and every later one run at the session effort the user selected, and no further step question is asked. Before 0.13.1 the step fell back to the effort step 0 decided (`turn.initial`) and the next step asked again. When step 0 made no estimate (Auto off at step 0, Auto switched back on mid-turn), the fallback is the session effort the user selected; with neither, no step question. The fallback is written explicitly, so a raised or lowered effort of an earlier step is not carried on.
- **Only right before a model call (user decision "no call, no Jev").** The question lives in `stepRouted`, which runs only on the three exits of `onTurnStep` that call `next(...)` after the transcript read. A step Jev takes itself, a whole-turn bypass summary and a turn without a transcript request ask nothing.
- **Delta since the last answer (user decision).** `turn.seen` advances only when Jev answered (`r.ok`): a paused call sends nothing and a failed one returns nothing, so Jev did not judge those steps and they stay in the next delta. A transcript that shrank mid-turn restarts the delta at 0. `summarize` caps the delta at the last 8 step summaries.
- **No `mechanical` question at steps.** The score's `low` level covers trivial deltas; one question per step keeps the Jev cost minimal. The score's confidence is not checked, as at step 0.
- **Step 0 unchanged.** Its batch and questions are as before; with the option it only writes `turn.initial` and `turn.seen`.

## Rejected alternatives

- **A. Re-ask the full step-0 questions at every step:** judges the whole request again, not the increment; two questions per step.
- **B. Asynchronous estimate (ask after step k, apply at step k+1):** no critical-path latency, but the delta is one step stale, it needs a pending promise with cancellation at turn end and interacts with the Jev pause.
- **C. A separate `step_effort` call next to the take batch (the first implementation):** two sequential Jev round trips (up to 8 s) at a step with take candidates; replaced on user decision (review escalation) by the merged batch below.

## Latency and residuals

- Every gated step waits for one Jev round trip (up to 4 s, then the Jev pause). The step question joins the step's existing batch call (one round trip, one timeout); a step Jev takes still carries it, and its answer is then unused and `turn.seen` stays, so the next model step's delta covers the taken call. This is why the option is off by default. It works against the latency goals of the performance tasks F15/F16 (`../TASKS.md`); not measured yet (follow-up).
- More debug-log lines (one per gated step) and more Jev tokens (one score question with up to 8 step summaries per gated step).
- A mid-turn model switch Opus -> Haiku fails the gate; the last step effort holds for the rest of the turn. Not a Claude Code flow; accepted.
- An abandoned dispatch (`next.signal`) is not checked, as at step 0; `turn` is per-turn state that dies with the turn.

## Calibration of the question (0.13.1)

Live smoke of 0.13.0 (`claude -p`, Sonnet 5.5, session medium, 4 runs, 2026-11-18): a delta that holds a task's requirements, a failing test or a design question scored 0.49-1.04, under the `EFFORT_CUTS` low cut of 1.05, so every later step ran at `low` although step 0 was `mechanical` or `medium`.

Measured with a `score` question of `mcp__jev-api__request` and fixed deltas (one sample each; the cuts are unchanged, only the question text differs):

| Delta                                             | Old text | New text |
| :------------------------------------------------ | :------- | :------- |
| Read of a TODO with 4 requirements                | 0.91     | 1.15     |
| Failing test output (deep-equal diff)             | 0.98     | 1.16     |
| The model's own text weighing an LRU/TTL conflict | 1.58     | 1.81     |
| `node test.mjs` prints `all pass`                 | 0.09     | 0.07     |
| Read of a one-line file                           | 0.33     | 0.60     |
| Edit that renames a function                      | 0.89     | 0.78     |

The new text asks for the difficulty of the work that follows the delta, not of the last tool call. Hard deltas now clear 1.05, trivial ones stay under it; the margin is small (1.15 against 1.05) and measured once, so the cuts for steps may still need their own calibration (`tests/fixtures/effort-scores.json` holds step 0 only). Open: no live run after the change, and no case with a delta between the two groups (a small edit with a clear instruction).

### Step cuts (0.13.1)

`scripts/step-calibrate.mts` scores the 32 labelled deltas of `tests/fixtures/step-deltas.json` (labels 0 low to 3 xhigh, hand-written by one author: 10 / 10 / 8 / 4 deltas) five times each against the real Jev endpoint and writes `tests/fixtures/step-effort-scores.json` (measured 2026-11-18, d1-3b through jev-api). Same question text as in 0.13.1.

| Label    | Scores (n) | Mean | sd   | Range     |
| :------- | :--------- | :--- | :--- | :-------- |
| 0 low    | 50         | 0.32 | 0.26 | 0.08-0.82 |
| 1 medium | 50         | 0.99 | 0.16 | 0.65-1.20 |
| 2 high   | 40         | 1.37 | 0.27 | 1.09-1.94 |
| 3 xhigh  | 20         | 1.75 | 0.31 | 1.28-2.12 |

- The five runs of one delta differ by at most sd 0.02: repeating does not add information, more deltas would.
- Best cut between neighbouring labels: 0.45 (90%), 1.2 (89%), 1.95 (82%). `STEP_EFFORT_CUTS = [0.45, 1.2, 1.95, 3.1]` (the last is provisional: no max delta). Level accuracy 81% with these, 50% with the request question's `EFFORT_CUTS`.
- Limits: the cuts were found on the same 32 deltas they are scored on (no held-out set), one author labelled them, medium and high overlap (high 1.09-1.94 against xhigh 1.28-2.12). Re-run the script after any change of the question text or of Jev's model, and extend the corpus before trusting the cuts for more than the low/medium/high split.
