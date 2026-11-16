---
id: F03
title: At >= 80% context fill the turn end asks Jev twice with the same state and reads the transcript twice
status: done
priority: medium
area: jevfort/src/hooks/register.mts (onTurnComplete, checkDone, contextCompact, readTurn)
---

## Status

Done in 0.11.0. Found in the performance analysis of 2026-11-14 ([../EVALUATION-2026-11-14.md](../EVALUATION-2026-11-14.md)), plugin 0.10.1 (the task-end compaction came with 0.10.0).

## Problem

`onTurnComplete` runs the done check (`checkDone`: `readTurn`, then `askJev` with `{ request, final_message, recent }` and `doneQuestion`) and then `contextCompact`, which from `taskCompactPercent` (default 80) reads the transcript again (`readTurn`) and asks Jev again with the identical state and `taskEndQuestion`. Two System One requests one after another and two `$.session.messages` reads per answered turn while the context is that full, all inside the `turn.complete` hook.

## Evidence

Proven: fake `$`, `turn.complete` at 85% fill: 31 ops, 2 batch calls, 2 `session.messages` (16 ops, 1 call, 1 read at 30%). Real System One (3.1 KB state, 5 runs): done check then task end 1341 ms median (p90 1368), both questions in one batch 762 ms (p90 772): 43% less. With every clip full each request takes ~1.7 s, so the sequential pair is ~3.4 s. Estimated: whether the engine holds the next prompt or a headless run's exit until `turn.complete` returns (not checked live).

## Code locations

- `onTurnComplete`: `checkDone(...)`, then `contextCompact($, e, true, continued, taskCompactPercent, forceCompactPercent)`.
- `checkDone`: `readTurn`, `askJev(... { done: doneQuestion })`.
- `contextCompact`: `readTurn`, `askJev(... { end: taskEndQuestion })`, skipped when `continued` (the done check sent Claude back) or forced.

## Approach

Ask both questions in one batch when both are due: read the fill (`$.session.usage()`) first, then one `readTurn` and one `askJev` with `{ done, end }` when the done check runs and the fill is at or above `taskCompactPercent`; `contextCompact` takes the `end` answer (and the shared turn context) instead of asking. Keep the current order of effects: a done follow-up (`continued`) still suppresses the task-end compaction; a forced compaction (>= `forceCompactPercent`) still asks nothing; the done check's `exempt`/`donePending` logic and the background-agent skip stay as they are (when the done check is skipped for a waiting subagent, the task end is not due either: today it is asked; decide and document).

## Verification

Done (0.11.0). `onTurnComplete` reads the fill first; from `taskCompactPercent` and below `forceCompactPercent` the done check asks `{ done, end }` in one `askJev` after one `readTurn`, and `contextCompact` takes the `end` answer instead of asking. Decisions: a done follow-up still suppresses the compaction; when the done check is skipped for a waiting subagent nothing is merged and `contextCompact` asks the end question itself, as before; a failed merged call answers neither (no follow-up, no compaction). Tests in `tests/register.test.mts`: "Turn end at 85% fill: one batch call (done+end), one transcript read" (failed before the change: 2 calls, 2 reads), the 30% case (done only), "A done follow-up at 85% fill queues no compaction"; the existing compaction tests stay green (199 tests). Not re-measured against the real endpoint (the 43% figure above stands as the expected gain).

Plan:

- Kit test: at 85% fill one `turn.complete` makes exactly one batch call carrying both questions and one `session.messages` read; at 30% one call with the done question only; with a done follow-up the compaction is not queued.
- Existing done-check and context-compaction tests stay green.
- Re-measure the turn end at 85% in a new dated evaluation.

## Constraints

All or nothing per `askJev`: a failed merged call must fall back for both (no compaction, no follow-up), as two failed calls do today. Every `$` call stays in-frame.

## Related

F02 (request size), F07 (duplicate transcript reads), CLAUDE.md "Effort routing"/done check.
