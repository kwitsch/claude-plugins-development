# Per-step effort (`stepEffort`, 0.13.0)

The constraint is in `jevfort/.claude/rules/effort-routing.md`; the code is `stepRouted` in `jevfort/src/hooks/register.ts` and `stepEffortQuestion` in `jevfort/src/hooks/policy.ts`.

## What it does

With `stepEffort: true` (default `false`) every Opus/Sonnet step `k > 0` that is handed to the model asks Jev one `step_effort` score question in its own `askJev` call, with `state = { request, effort, delta }`: `effort` is the effort the previous model call of the turn ran at, `delta` the summarized steps since Jev's last answered effort question in the turn (`turn.seen`). The answer goes through `estimateEffort` (same 0-4 scale and `EFFORT_LEVELS`, so `EFFORT_CUTS` and the `minEffort`/`maxEffort` clamp apply unchanged) and sets the step's effort, the band's `chosen` (main loop only) and one debug-log line `… · step <n> · <source>`.

## Decisions

- **Only Opus/Sonnet.** An effort change rewrites the prompt cache of Haiku/Fable (the reason for their first-turn hold); Opus/Sonnet are effort-agnostic for the cache. The gate reuses `EVERY_TURN_MODELS`. The cache claim is the user's premise and the existing rule's reason; it was not re-measured.
- **Fallback order (user decision).** An unusable step estimate (Jev unavailable, timed out, paused or denied; no finite score, which fails the whole decision in `askJev`) runs the step at the effort step 0 decided for the turn (`turn.initial`: Jev's estimate, or the session effort when Jev failed at step 0). When step 0 made no estimate (Auto off at step 0, Auto switched back on mid-turn), the fallback is the session effort the user selected; with neither, no step question. The fallback is written explicitly, so a raised or lowered effort of an earlier step is not carried on.
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
