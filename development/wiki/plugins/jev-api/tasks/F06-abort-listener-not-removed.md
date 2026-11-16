---
id: F06
title: Abort listeners stay on next.signal after the call settles
status: done
priority: low
area: jev-api/src/hooks/register.mts (ask, askHaiku)
---

## Status

Done in jev-api 0.3.2: `ask` and `askHaiku` remove their abort listener in `finally`. Test: "settled calls leave no abort listeners on a shared signal".

Earlier state: Open.

## Problem

`ask` and `askHaiku` add `signal.addEventListener("abort", ..., { once: true })` for the race and never remove it when the request settles normally. `once` only removes it when the signal fires. If the engine's `next.signal` lives longer than one dispatch (shared per turn or per session), every owned call leaves one listener, holding its closure and pending promise, until that signal aborts.

## Evidence

Proven in the harness (local stub, 10,000 `noul` calls after 200 warm-up, heap after two forced GCs):

| Mode                              | Heap growth per 10k calls | Listeners left on the signal |
| --------------------------------- | ------------------------- | ---------------------------- |
| HTTP path, fresh signal per call  | -0.10 MB                  | 0                            |
| HTTP path, one shared signal      | +12.34 MB                 | 10,200                       |
| Haiku path, fresh signal per call | +0.07 MB                  | 0                            |
| Haiku path, one shared signal     | +8.61 MB                  | 10,200                       |

About 1.2 KB per call with a long-lived signal, 0 with a per-dispatch one. Estimated: the kit (`claude-engine-vitest`) creates one signal per dispatch, and the engine typings describe `next.signal` as aborting "when the dispatch is abandoned", so in Claude Code the leak is most likely absent; the engine's signal lifetime was not verified.

## Code locations

- `ask` (`stop` promise), `askHaiku` (`aborted` promise)

## Approach

Keep the listener in a variable and `signal.removeEventListener("abort", onAbort)` in the existing `finally` of `ask` (and a new one in `askHaiku`). Two lines each, no behaviour change.

## Verification

Test that drives the hook directly (like "an abandoned call answers at once") with one shared `AbortController` over 3 calls: `getEventListeners(signal, "abort")` from `node:events` is 0 afterwards.

## Constraints

Do it together with F05.

## Related

F05, F14.
