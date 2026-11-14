---
id: F08
title: askJev's budget sleep and the measurement grace are never cancelled
status: done
priority: low
area: jevfort/src/hooks/register.mts (askJev, onTurnStep measurement grace, Engine.clock type)
---

## Status

Done in 0.11.0. Found in the performance analysis of 2026-11-14 ([../EVALUATION-2026-11-14.md](../EVALUATION-2026-11-14.md)), plugin 0.10.1.

## Problem

`askJev` races the batch call against `$.clock.sleep(budgetMs)` (4 s, 9 s for a compaction ranking, 15 s on the Haiku path) and the measurement path races its answer against `$.clock.sleep(MEASURE_GRACE_MS)` (250 ms). Neither sleep is cancelled when the other side wins, so every ask leaves an engine timer pending for its full budget after the answer, with the race's closures alive until it fires. jev-api uses `$.clock.after` with `cancel()` for the same race (0 live timers in its evaluation). The engine typings give `$.clock.sleep(ms, { signal })` an abort option (graphmind memory of the typings, 2026-11-12).

## Evidence

Proven (harness, Node timers standing in for the engine's): 2000 sleeps still pending right after 200 fast simulated turns (10 per turn: classify, step 0, three measurements and their graces, done check, a subagent's step 0); heap 145 MB after 4300 turns at full speed, 6.9 MB after a 5 s idle wait (retention, no leak). Estimated: at human turn rates a handful of pending 4 s timers per turn; whether a pending `$.clock.sleep` delays a headless `claude -p` exit or counts in the engine's hook bookkeeping (`lingerMs`) was not checked live.

## Code locations

- `askJev`: `const timeout = $.clock.sleep(budgetMs).then(() => undefined);` raced with `call`.
- `onTurnStep` measurement: `Promise.race([measure, $.clock.sleep(MEASURE_GRACE_MS).then(...)])`.
- `Engine.clock.sleep(ms)` type at the top of register.mts (no options).

## Approach

Pass an own `AbortController`'s signal (`$.clock.sleep(budgetMs, { signal })`) and abort it in a `finally` once the race settled; catch the abort rejection. Extend the structural `Engine` type with the option. Alternative: `$.clock.after` with `cancel()` resolving a promise, as jev-api does. First check live (skill `live-verify`) whether a pending sleep holds a `claude -p` run open after the done check: that decides the priority.

## Verification

Done: `askJev` and the measurement grace use `$.clock.after` with `cancel()` (as jev-api does) instead of `$.clock.sleep`; the budget timer is cancelled in a `finally`, the grace right after the race. The kit's `clock.sleep` ignores an abort signal, so the `{ signal }` route could not be tested; `after` can. Test `An answered Jev call leaves no budget timer pending` (register.test.mts): every `clock.after` started during an answered turn step is cancelled (fails without the change: no `after` call); `An answered step measurement leaves no timer pending, the 250 ms grace timer included` does the same for a measured main-loop step (index 1) and fails without `grace.cancel()`. Not run: the live `claude -p` timing and the harness burst count. Known limit: a clock that refuses `after` never fires the timer, so the measurement grace would wait for the measurement itself (the old `sleep` fell back to dropping it); the engine has no known refusal of `after`.

Planned checks:

- Kit test (if the kit supports the sleep signal): after an answered `askJev` no sleep is pending; otherwise a unit-level check of the abort call.
- Harness: 0 pending sleeps after a burst of turns; a live `claude -p` run timed with and without the change.

## Constraints

A refused clock must still not throw out of `askJev` (it falls back to the wall clock today); the budget semantics stay (an in-flight `$.tool.call` does not use up the hook's 10 s; a `$.clock.sleep` wait may).

## Related

F12 (memory record), jev-api F06/F14 (timer cleanup there), `.claude/rules/claude-code-hook-facts.md`.
