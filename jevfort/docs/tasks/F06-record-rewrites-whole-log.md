---
id: F06
title: record() rewrites the whole log and the stats per decision, in-frame on the critical path
status: open
priority: low
area: jevfort/src/hooks/register.mts (record, readLog, stats, storeQueue, onPromptSubmit, onTurnStep, recordCompare), jevfort/src/hooks/log.mts (MAX_ENTRIES)
---

## Status

Open. Found in the performance analysis of 2026-11-14 ([../EVALUATION-2026-11-14.md](../EVALUATION-2026-11-14.md)), plugin 0.10.1.

## Problem

Every decision is logged with `record()`: `$.store.get("log")`, `$.store.set("log", [...log, entry].slice(-1000))`, `$.store.get("stats")`, `$.store.set("stats", ...)`, serialized through `storeQueue` and awaited by the hook. The log holds up to 1000 entries, so each record rewrites the whole value. A default 6-step turn makes about 10 records (classify, route, take, a compare per step, done), three of them before the first model request (classify in `prompt.submit` before `next`, route and take at step 0 before `next`) and one after every step before the step returns (`recordCompare`).

## Evidence

Proven (fake store that serializes each `set` with `JSON.stringify`): 100 default turns fill the log (classify 100, route 100, take 100, compare 600, done 100), 321 KB of JSON; one more 6-step turn at the cap: 20 `store.set`, 3210 KB serialized, 22 `store.get`; a JSON round trip of the log 2.90 ms (p90 3.71). With an assumed 1 ms per engine op, step 0 waits 37 ms before its request (step k 15 ms) and each step's post-processing ~10 ms, most of it the records. Estimated: the engine's real cost of `$.store.get/set` (marshalling, persistence of up to 4 MiB of JSON per plugin) was not measured.

## Code locations

- `record`, `readLog`, `stats`, `clearLog`, `storeQueue` (register.mts).
- Callers before `next`: `onPromptSubmit` (`classify`), `onTurnStep` (`route`, `take`, `error`); after the step: `recordCompare`.
- `MAX_ENTRIES` (log.mts).

## Approach

Prototype and measure in a live session first (`live-verify`), then pick:

1. Buffer the turn's entries in memory and write the log and the stats once per turn, in the `turn.complete` frame (and in `session.end`); a turn that never completes loses at most its own entries.
2. Move the records that sit before `next` behind it (after the step's stream), so they no longer delay the first token.
3. Chunked keys (e.g. 100 entries per key, a ring of 10) so a record rewrites one chunk; `/jev report` and `/jev export` read all chunks.

## Verification

- Kit test: a 6-step turn makes at most the chosen number of `store.set` calls; `/jev`, `/jev report` and `/jev export` still show every decision; the existing store-failure tests stay green.
- Re-measure the evaluation's store rows in a new dated evaluation; if possible measure the real `$.store.set` cost live.

## Constraints

Every store call must run inside a hook frame of this module (`.claude/rules/register-hooks.md`, "Storage calls must run in-frame"); a failing store must not fail a hook; keep or explicitly re-decide the known limit "several sessions share one log" (CLAUDE.md).

## Related

F07 (other per-step engine reads), CLAUDE.md "Known limit: several sessions share one log".
