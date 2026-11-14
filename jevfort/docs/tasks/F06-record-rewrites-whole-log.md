---
id: F06
title: record() rewrites the whole log and the stats per decision, in-frame on the critical path
status: done
priority: low
area: jevfort/src/hooks/register.mts (record, readLog, stats, storeQueue, onPromptSubmit, onTurnStep, recordCompare), jevfort/src/hooks/log.mts (MAX_ENTRIES)
---

## Status

Done in 0.11.0 (approach 1). `record()` only buffers the entry (`pending` in register.mts); `flushLog` writes the log and the counters with one `store.get` and one `store.set` each, in-frame from `turn.complete` (both return paths), `session.end` and the `/jev` command (before report, export and the counters are read; `clear` drops the pending entries). A 6-step turn now makes 2 `store.set` (was 20) and none before the first model request (was 3 records, 6 sets). A store failure drops the flushed batch, as a failing `record()` dropped its entry before. Trade-off: decisions of a session whose process dies without `turn.complete`/`session.end` (and those recorded after the last one) are lost; the in-memory buffer has no cap between flushes (`shortcut:` comment).

Earlier state: Open. Found in the performance analysis of 2026-11-14 ([../EVALUATION-2026-11-14.md](../EVALUATION-2026-11-14.md)), plugin 0.10.1.

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

Done: `tests/register.test.mts` "A 6-step turn writes the log and the counters once, and /jev export still holds every decision" (prompt classify, steps 0 to 5, `turn.complete`): no `store.set` before `turn.complete`, then exactly one `log` and one `stats` write; `/jev export` holds classify, route, 6 compare and done, `/jev` counts compare=6. Without the fix it fails with 18 `store.set` before `turn.complete` (20 with the done record). The store-failure tests stay green; the done-check subagent table now runs with `classify: false` (the kit runs the unawaited follow-up's classify during the extra flush await), and the effort-score log test reads the log after `/jev report`. A live measurement of the real `$.store.set` cost and a new dated evaluation were not run.

Planned:

- Kit test: a 6-step turn makes at most the chosen number of `store.set` calls; `/jev`, `/jev report` and `/jev export` still show every decision; the existing store-failure tests stay green.
- Re-measure the evaluation's store rows in a new dated evaluation; if possible measure the real `$.store.set` cost live.

## Constraints

Every store call must run inside a hook frame of this module (`.claude/rules/register-hooks.md`, "Storage calls must run in-frame"); a failing store must not fail a hook; keep or explicitly re-decide the known limit "several sessions share one log" (CLAUDE.md).

## Related

F07 (other per-step engine reads), CLAUDE.md "Known limit: several sessions share one log".
