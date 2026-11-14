---
id: F04
title: buildCandidates stats every mentioned path of the whole turn one after another, again at every step
status: open
priority: medium
area: jevfort/src/hooks/register.mts (buildCandidates, onTurnStep), jevfort/src/hooks/candidates.mts (mentionedPaths, MAX_READS)
---

## Status

Open. Found in the performance analysis of 2026-11-14 ([../EVALUATION-2026-11-14.md](../EVALUATION-2026-11-14.md)), plugin 0.10.1.

## Problem

`buildCandidates` collects every path-like string from the request, every step's text and **every tool result of the turn** (`mentionedPaths`), and for each one not yet read and safe to offer awaits `$.fs.stat` until `MAX_READS` (8) files qualify. A path that does not exist, is a directory or is over 2 MB costs a stat and does not count, so the number of stats has no bound. It runs before the model request of step 0 (take path) and, with `measureSteps` on (default), of every main-loop step > 0, and nothing is remembered between steps: the same missing paths are probed again at every step.

Paths that do not exist relative to the session cwd are common in tool output: a monorepo command printing paths relative to a package (`pnpm -r test`, `tsc -b`), stack traces from other machines, `git log --stat` with deleted files, build logs.

## Evidence

Proven (fake `$`, zero-cost stats, 7 fresh instances per case): a turn of 20 steps whose results mention 25 missing paths each: 501 `fs.stat` per step, 4.8 ms until the request; 40 steps x 50 paths: 2001 stats per step, 15.4 ms; a normal turn: 1 stat. Every stat is a sequential `await` before the model request. Estimated: with an assumed 1 ms per engine op that is 0.5-2 s per step; on a 9P working tree (WSL `/mnt/c`) a stat costs 0.7-2.5 ms (`.claude/rules/hook-file-safety.md`), so 0.35-5 s per step. The engine's real `$.fs.stat` cost was not measured.

## Code locations

- `buildCandidates` (register.mts): `for (const p of mentionedPaths(texts)) { if (reads >= MAX_READS) break; ... await $.fs.stat(file) ... }`, `texts = [request, ...steps.map((m) => m.text), ...calls.map((c) => c.text ?? "")]`.
- `onTurnStep`: the measurement branch (`measureSteps && takeSteps && !ctx.command && e.index > 0 && !e.agentId`) and the take branch call it before `next`.
- `mentionedPaths`, `MAX_READS` (candidates.mts).

## Approach

1. Bound the probes per call (e.g. at most 16 stats, newest mentions first: the latest tool output names the most relevant files).
2. Remember stat results per turn (a `Map` keyed by absolute path in the per-turn state, dropped with `turns.delete` at `turn.complete`), so a path is probed once per turn.
3. Optionally stat a bounded batch in parallel (`Promise.all`) instead of one after another.

Keep the order of the offered reads stable (tests pin candidate lists).

## Verification

- Kit test: a turn whose tool results mention 100 missing paths makes at most the bound of `fs.stat` calls at a step, and none for the same paths at the next step of the turn; existing candidate tests stay green.
- Re-measure the evaluation's `bench2.mjs` missing-path rows in a new dated evaluation.

## Constraints

`isSafeToOffer` and the 2 MB size check stay; every `$` use stays in `register.mts`; the cache must not outlive the turn (a file created later in the session must be offered).

## Related

F05 (the same whole-turn scan), F07 (other per-step probes), dprint F27/F29 (stat cost on 9P).
