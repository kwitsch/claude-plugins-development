---
id: F05
title: Every step re-scans the whole turn (mentionedPaths, summarize), quadratic over a turn
status: open
priority: low
area: jevfort/src/hooks/register.mts (onTurnStep, buildCandidates), jevfort/src/hooks/context.mts (summarize, toolCalls), jevfort/src/hooks/candidates.mts (mentionedPaths)
---

## Status

Open. Found in the performance analysis of 2026-11-14 ([../EVALUATION-2026-11-14.md](../EVALUATION-2026-11-14.md)), plugin 0.10.1.

## Problem

At every main-loop step jevfort rebuilds its view of the turn from the full transcript: `mentionedPaths` runs its regex over the request, every step text and every tool result of the turn, and `summarize` stringifies every tool input of the turn (`clip(JSON.stringify(use.input), 300)` clips only after the whole input was serialized) to keep the last 8 entries. The work per step is linear in the turn's text, so a turn costs quadratic time; it all runs before the model request.

## Evidence

Proven (fake `$`, step k > 0 until the request, median of 7): 10 steps with 2 KB results 1.38 ms, 200 steps 2.95 ms, 50 steps with 50 KB results 9.39 ms, 100 steps with 50 KB results 16.97 ms (p90 22.21), 100 steps with 50 KB tool inputs 10.67 ms. Pure parts on the 100-step / 50 KB turn: `mentionedPaths` over 5.0 MB 15.4 ms, `summarize` 0.07 ms (7.0 ms with 50 KB inputs), `splitTurn` and `toolCalls` 0.008 ms. Estimated: typical turns (tens of steps, a few KB per result) stay at 1-3 ms; only long turns with big outputs (large Reads, logs, Writes of whole files) reach 10-20 ms per step.

## Code locations

- `buildCandidates`: `texts = [request, ...steps.map((m) => m.text), ...calls.map((c) => c.text ?? "")]`, `mentionedPaths(texts)`.
- `summarize` (context.mts): forward loop over all assistant rows, `out.slice(-limit)` at the end.
- `onTurnStep`: `readTurn`, `toolCalls(ctx.steps)`, `summarize(ctx.steps)` per step.

## Approach

1. `summarize`: walk the steps from the end and stop after `limit` entries (same output, linear in 8 instead of the turn).
2. `mentionedPaths`: scan only rows not scanned before in this turn (per-turn cache of found paths and the number of rows seen, in the per-turn state), or scan only the newest N rows / the last K characters of each result.

## Verification

- Pure tests: `summarize` returns the same entries as today for turns shorter and longer than the limit; the path cache yields the same paths as a full scan.
- Re-measure the evaluation's `bench2.mjs` 50 KB rows in a new dated evaluation.

## Constraints

Pure modules stay pure (no `$`); the per-turn state lives in `register.mts` and ends with the turn.

## Related

F04 (the stats that follow the scan), F02 (the `recent` state built here), F07.
