---
id: F11
title: Request path overhead vs a bare fetch, validation and JSON cost
status: closed
priority: none
area: jev-api/src/hooks/register.mts (onToolCall, parseInput, ask, endpoint)
---

## Status

Closed 2026-11-13 (measurement record): the plugin adds 0.05-0.2 ms to a request whose server time is 50-4000 ms.

## Problem

Per owned call the plugin validates the input (`parseInput`), resolves the endpoint (`endpoint`, regex), serializes the body, races the request against a `$.clock.after` timer, parses the response and re-serializes the answers. The question was whether any of this is measurable next to the request.

## Evidence

Proven (harness; `$.http.fetch` mapped to Node's global `fetch`, a local `node:http` stub of System One; sequential, bare fetch and hook call interleaved):

| Case                                 | Bare fetch median (p90) ms | Through the hook median (p90) ms | Overhead |
| ------------------------------------ | -------------------------- | -------------------------------- | -------- |
| `batch` of 3, stub delay 0, N=1000   | 0.300 (0.372)              | 0.350 (0.423)                    | +0.05 ms |
| `batch` of 3, stub delay 50 ms, N=60 | 50.86 (51.07)              | 51.09 (51.28)                    | +0.2 ms  |
| real System One, `noul`, N=10        | 49.5 (82.7)                | 49.9 (58.0)                      | noise    |
| real System One, `batch` of 3, N=10  | 130.0 (165.1)              | 129.4 (156.5)                    | noise    |

Plugin CPU per owned call with an in-memory fetch that resolves at once (validation, 4 env reads, timer, stringify, parse, rebuild):

| Case                                         | Median us | p90 us | Request bytes | Response bytes |
| -------------------------------------------- | --------- | ------ | ------------- | -------------- |
| `noul`                                       | 87.9      | 109.7  | 183           | 72             |
| `batch` of 3                                 | 86.1      | 125.0  | 312           | 367            |
| `batch` of 30 compaction-sized scores        | 213.9     | 264.3  | 29,903        | 11,456         |
| `batch` of 1 choice, 255 options x 200 chars | 274.7     | 309.8  | 59,143        | 9,459          |
| `batch` of 50 such choices (stress)          | 9,757     | 13,294 | 2,807,887     | 471,226        |

Re-serializing the answers (`JSON.stringify(list)`) is part of these figures; even the 2.8 MB stress case is under 10 ms. There is no request or response size cap in the plugin; the engine caps one fetch at 30 s. URL resolution runs per call but is a regex over a short string.

## Code locations

- `onToolCall`, `parseInput`, `parseQuestion`, `endpoint`, `ask`

## Approach

None. Caching the endpoint or the env values would save microseconds (see F07 for the only cheap change).

## Verification

Re-run the harness after changes to the request path.

## Constraints

None.

## Related

F07, F10, F13.
