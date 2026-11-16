---
id: F12
title: No answer cache for identical questions
status: closed
priority: none
area: jev-api/src/hooks/register.mts (ask, askHaiku)
---

## Status

Closed 2026-11-13: not worth doing without a measured hit rate.

## Problem

Every call sends a request (System One) or a model call (Haiku), also when the same `(state, questions)` was asked a moment ago. A bounded TTL cache keyed by the request body would make identical repeats free.

## Evidence

Proven: 5 identical `noul` calls through the Haiku path made 5 `model.complete` calls (harness). Proven from jevfort's code: repeats are rare by construction. Every `askJev` state carries something that changes per call: the prompt text (`prompt.submit`), the prompt plus `recent` steps and `cwd` (`turn.step`), the final message (done check), the tool items (compaction), the Agent prompt (Agent routing). `prompt.submit` and the first `turn.step` of the same turn ask about the same prompt but with different states and questions. The only plausible exact repeat is `estimate_effort` called twice with the same prompt. Estimated: hit rate near 0 in normal sessions (not measured: jevfort's log keeps no state hashes).

## Code locations

- `ask`, `askHaiku`

## Approach

None now. If a hit rate is ever measured (log a hash of the request body per call in jevfort's decision log first), a cache would be: key = the exact request body string, at most ~64 entries, TTL ~5 min, only successful answers, concurrent identical calls sharing one promise (see `.claude/rules/hook-file-safety.md`, "Caches, timers, state").

## Verification

None.

## Constraints

A cache must never return an answer for different input (key on the full body, not on `state` alone).

## Related

F08.
