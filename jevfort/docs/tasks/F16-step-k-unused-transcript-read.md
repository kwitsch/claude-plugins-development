---
id: F16
title: Every step k > 0 reads and splits the whole transcript, which with the defaults only the bypass follow-up step uses
status: open
priority: low
area: jevfort/src/hooks/register.mts (onTurnStep)
---

## Status

Open. Found in the analysis after the option removal ([../EVALUATION-2026-11-14-3.md](../EVALUATION-2026-11-14-3.md)), plugin 0.12.0. Before 0.12.0 the step measurement asked Jev at every step k > 0 and needed the transcript; its removal left the read in place.

## Problem

`onTurnStep` reads the loop's transcript (`$.session.messages`) and splits the turn (`turnOf`, `toolCalls`) at every step before it decides whether anything is to be asked. With the defaults a step k > 0 asks nothing: `takeOnlyForBypass` limits the take candidates to main-loop step 0, and the effort estimate runs at step 0 only. The only step k > 0 that uses the transcript is the bypass follow-up (`turn.bypassId` set), which summarizes the taken step's result. Every other step k > 0, in the main loop and in subagents, reads the whole transcript for nothing and then passes on.

- Harness (fake `$`): step k > 0 is 2 engine ops (`session.messages`, and `clock.now` in `cacheWatch` after the stream); 8 of the 10 transcript reads of a turn with 6 main-loop and 4 subagent steps are unused.
- Cost per unused read: 0.35 ms when the read returns the engine's array as is; 3.1-4.8 ms with a cloned 1.26 MB transcript (2000 earlier turns), 9.5 ms (p90 12.9) with a cloned 10 MB one. What the engine really pays to hand a mod the transcript (marshalling, copying) is unmeasured.

## Evidence

Proven: harness op counts and timings (`bench1.mjs`, `bench2.mjs`, `bench4.mjs` of the evaluation), and the code path (no question can be built at `e.index > 0` unless `turn.bypassId` is set or `takeOnlyForBypass` is off). Estimated: the real engine cost of a `$.session.messages` call.

## Code locations

- `onTurnStep` (register.mts): `const messages = await $.session.messages(...)`, `turnOf`, `toolCalls`, the bypass block (`turn.bypassId && e.index > 0`), the take branch (`takeSteps && ... (!takeOnlyForBypass || (bypass && e.index === 0 && !e.agentId))`), the step-0 effort block (`routing && e.index === 0`), `routed`.

## Approach

Before the read, pass on when the step cannot ask anything: `e.index > 0 && !turn.bypassId && !(takeSteps && !takeOnlyForBypass && turn.taken < MAX_TAKES_PER_TURN)` returns `yield* next(routed(e))`, with `routed` (the turn's effort from step 0) defined before it. Step 0, the bypass follow-up step and the in-turn take path (`takeOnlyForBypass: false`) keep the read.

## Verification

- Kit test (`tests/register.test.mts`): a default 3-step main-loop turn calls `$.session.messages` once (step 0) and still sends the step-0 effort on steps 1 and 2; the bypass follow-up step still reads it and answers with the summary; with `takeOnlyForBypass: false` every step reads it. Fails on 0.12.0 (3 reads).
- Harness: step k > 0 at 1 op (`clock.now` after the stream).

## Constraints

`turnRunning` and the `cacheWatch` wrap stay before the readiness guard and before this early return; the readiness guard stays (`.claude/rules/register-hooks.md`). The turn's effort (`turn.effort`) must still reach every step of the turn.

## Related

F05 and F07 (the per-step scan and reads they made incremental), F15 (the take path whose bypass step is the one remaining user of the read at k > 0).
