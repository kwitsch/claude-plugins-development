---
id: F01
title: jevfort's 4 s askJev budget is below real System One latency for large batches
status: done
priority: high
area: jevfort/src/hooks/jev.mts (TIMEOUT_MS, JEV_API_TIMEOUT_S), jevfort/src/hooks/register.mts (askJev, session.compact hook), jevfort/src/hooks/compact.mts (MAX_ITEMS)
---

## Status

Done in jevfort 0.9.1: a compaction ranking has its own `askJev` budget (`COMPACT_TIMEOUT_MS` 12 s, jev-api `timeout` 12), the interactive budget stays 4 s and jev-api's `timeout` equals it (`JEV_API_TIMEOUT_S` 4, was 5: the request ends with the budget, not a second after). Test: "session.compact waits longer for Jev than an interactive call, and tells jev-api so" (a stub batch answering after 4.5 s).

Earlier state: Open. Found in the jev-api analysis; the change belongs to jevfort (jev-api cannot make System One answer faster).

## Problem

System One answers the questions of one `batch` request one after another: latency grows linearly with the question count. jevfort's `askJev` races every batch against `TIMEOUT_MS` = 4000 ms, and passes `timeout: JEV_API_TIMEOUT_S` = 5 s to jev-api. The compaction ranking (`session.compact` hook) sends one `score` question per earlier tool call, up to `MAX_ITEMS` = 30, each with up to 500 characters of tool result in its `instructions`. At that size the request takes longer than the budget, so the ranking is always lost (`askJev` returns `timeout after 4000ms` and the compaction runs unranked), and jev-api's request keeps running for up to 1 more second after jevfort gave up (see F09: it cannot be cancelled).

## Evidence

Proven (measured against the real System One endpoint from `JEV_URL`, bare `fetch`, model `jev-latest`, 3 runs each, 2026-11-13; the plugin adds < 0.5 ms, see F11):

| Batch of `score` questions (4 RELEVANCE levels)                | Median ms | Runs                     |
| -------------------------------------------------------------- | --------- | ------------------------ |
| 1 short item                                                   | 145.8     | 145.8 / 136.4 / 146.2    |
| 5 short items                                                  | 433.5     | 433.5 / 439.6 / 394.2    |
| 10 short items                                                 | 734.7     | 749.2 / 732.6 / 734.7    |
| 30 short items (~150-char instructions)                        | 2172.4    | 2206.5 / 2168.3 / 2172.4 |
| 30 compaction-sized items (~600-char instructions, 32 KB body) | 4097.8    | 4128.6 / 4091.6 / 4097.8 |

About 70 ms per short question and ~135 ms per compaction-sized one. 30 compaction-sized items exceed the 4000 ms budget in every run. Estimated: real sessions often have shorter results than the 500-char clip, so the break-even is roughly 25-30 items of typical size; any turn with long tool outputs and a full item list loses the ranking.

## Code locations

- jevfort: `TIMEOUT_MS`, `JEV_API_TIMEOUT_S` (`jev.mts`), `askJev` (budget race), the `session.compact` hook that builds `item_<i>` questions, `MAX_ITEMS`, `compactItems` (500-char result clip).
- jev-api: `ask` (one request per batch, timeout from the call's `timeout`).

## Approach

In jevfort, pick one (decision for the jevfort owner):

1. A per-call budget for compaction: compaction is not on the interactive path, so give `askJev` an optional budget (e.g. 10 s, with `timeout` just below it) for the `session.compact` call only.
2. Fewer or shorter questions: clip each item's result to ~200 characters, or lower `MAX_ITEMS` to ~20 (both cut latency linearly).
3. Keep the jev-api `timeout` below the `askJev` budget everywhere (today 5 s > 4 s): the request then ends with the budget instead of 1 s after it.

Splitting the batch into parallel requests does not help: 10 single-question requests in parallel took 1102 ms (short) and 1795 ms (long) against 735 ms for one batch of 10 (F13).

## Verification

jevfort test: a stub `batch` answering after 4.5 s still ranks a 30-item compaction (option 1), or the questions are clipped (option 2). Re-measure with the real endpoint (`realscale.mjs`-style script, see the evaluation) and record the figures in a new evaluation.

## Constraints

jevfort and jev-api ship standalone; `batch`'s name and shape stay. The interactive budget (prompt classification, turn steps) should stay short; only the compaction path is off the critical path.

## Related

F09 (abandoned request keeps running), F13 (batch shape), jevfort `CLAUDE.md`.
