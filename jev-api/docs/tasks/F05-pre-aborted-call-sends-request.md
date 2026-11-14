---
id: F05
title: An already abandoned call still sends its System One request
status: done
priority: low
area: bug (jev-api/src/hooks/register.mts: ask, askHaiku, onToolCall)
---

## Status

Done in jev-api 0.3.2: an already aborted call answers `the call was abandoned` after validation and sends nothing. Test: "an already abandoned call sends no request".

Earlier state: Open.

## Problem

`ask` calls `$.http.fetch` first and only then builds the `stop` race that checks `signal.aborted`. A call whose dispatch was already abandoned (user interrupt, a hook above settled first) before it reached `ask` answers `the call was abandoned` but still sends the request, which then runs to completion on the server (F09: it cannot be cancelled). `askHaiku` likewise starts `$.model.complete` before checking the signal, which costs a model call (tokens). The four `$.env.get` reads and `parseInput` also run first.

## Evidence

Proven (harness, local stub): a `noul` call with a pre-aborted `next.signal` returns `{ deny: "noul: the call was abandoned" }` and the stub counted 1 request. Estimated: how often the engine hands a hook an already-aborted signal is unknown (most likely when jevfort's or the user's interrupt races the dispatch).

## Code locations

- `ask` (fetch before the `stop` promise), `askHaiku` (`$.model.complete` before `aborted`)
- `onToolCall`

## Approach

`if (next.signal.aborted) return fail(type, "the call was abandoned")` once in `onToolCall` right before the `askHaiku`/`ask` branch (after validation, so the error texts stay as they are). Keep the existing in-race checks for aborts during the request.

## Verification

Extend the test "an abandoned call answers at once instead of waiting for the request": with a pre-aborted controller `sent` stays false and the answer is `noul: the call was abandoned`; same for the Haiku path (`model.complete` not called).

## Constraints

Every owned call is answered. Do it together with F06 (same race code).

## Related

F06, F09.
