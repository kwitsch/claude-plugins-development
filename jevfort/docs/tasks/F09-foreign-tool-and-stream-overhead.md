---
id: F09
title: Foreign tool.call/tool.check overhead and the turn.step stream pass-through
status: closed
priority: none
area: jevfort/src/hooks/register.mts (onToolCall, onToolCheck, onTurnStep, cacheWatch)
---

## Status

Closed 2026-11-14: measurement record, no code action.

## Problem

Question answered: what jevfort's matcher-less `tool.call` and `tool.check` hooks cost on every tool call it does not own, and what its `turn.step` wrapper costs per streamed chunk (it runs also while jevfort is inactive, for the cache countdown).

## Evidence

Proven (fake `$`, 200 x 1000 awaited calls after 50,000 warm-up calls): bare `next(e)` 0.151 us/call; `tool.call` with a foreign tool 0.299 us (p90 0.400), 0 engine ops (`jevMissing` returns the turn's cached promise); `tool.check` with a foreign tool 0.308 us (p90 0.417), 0 ops; the first scratchpad `Write` check reads two env values and the session id once (3 ops), later checks 0. Stream of 20,000 chunks with jevfort inactive: bare 4.12 ms, through `onTurnStep` + `cacheWatch` 15.44 ms: +0.57 us per chunk (7 runs).

## Code locations

- `onToolCall`, `onToolCheck` (readiness guard `jevMissing`, `ownCalls` lookup, scratchpad memo `scratchpad`).
- `onTurnStep` (`return yield* next(e)` through `cacheWatch`).

## Approach

None: sub-microsecond per call and per chunk, no engine op on the foreign path.

## Verification

None needed.

## Constraints

None.

## Related

F07 (the per-step ops of the active path).
