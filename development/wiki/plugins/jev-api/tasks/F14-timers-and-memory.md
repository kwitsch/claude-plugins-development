---
id: F14
title: Timer cleanup and module memory
status: closed
priority: none
area: jev-api/src/hooks/register.mts (ask, register)
---

## Status

Closed 2026-11-13 (measurement record): no timer leak, no unbounded module state. The one memory risk found is F06.

## Problem

Each System One call starts one `$.clock.after` timer for its timeout race; the module keeps state across calls (`names`, `registering`). Checked: are timers cancelled on every path, and does memory grow with the call count?

## Evidence

Proven (harness; `$.clock.after` mapped to `setTimeout`, counters for created, cancelled and still-live engine timers):

| Path                                               | Timers created | Cancelled | Live afterwards | Node Timeout handles delta                                       |
| -------------------------------------------------- | -------------- | --------- | --------------- | ---------------------------------------------------------------- |
| 1000 answered calls                                | 1000           | 1000      | 0               | 0                                                                |
| 50 calls timing out (`timeout: 0.05`, stub 300 ms) | 50             | 50        | 0               | n/a                                                              |
| 50 calls aborted while in flight                   | 50             | 50        | 0               | 0 from the plugin (the 100 left are the stub's own reply timers) |

`askHaiku` starts no timer (it passes `timeoutMs` to `$.model.complete`). On the timeout path `cancel()` runs once more on the already-fired timer: harmless. Module state: `names` holds at most 8 entries (4 defaults plus up to 4 engine-returned names), `registering` one promise; no caches, no per-call maps. Heap after two forced GCs with a fresh `next.signal` per call: 10,000 HTTP calls -0.10 MB, 10,000 Haiku calls +0.07 MB, 1,000,000 foreign calls -0.03 MB. With one long-lived signal the heap grows (F06).

## Code locations

Before 0.3.2; since the rewrite the module state is `RegState` (at most 4 tools) next to `names`, and `registering` is gone.

- `ask` (`timer`, `finally { timer?.cancel() }`), `register` (`names`, `registering`)

## Approach

None (see F06 for the listener removal).

## Verification

Existing test "a settled request cancels its timeout timer".

## Constraints

None.

## Related

F06, F09.
