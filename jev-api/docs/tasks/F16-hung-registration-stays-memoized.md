---
id: F16
title: A hung registration stays memoized - every owned call waits 1 s, every session.start 5 s, no retry
status: done
priority: medium
area: bug (jev-api/src/hooks/register.mts: onToolCall, onSessionStart, registerTools, within)
---

## Status

Done in jev-api 0.3.2: registration is a state per tool (`RegState`, `ensureTools`); a hanging tool is waited for once (then `stuck`), the other tools and later calls do not wait for it. Test: "a hanging registration of one tool is waited for once, not by every call".

Earlier state: Open. Found in the re-run on 0.3.2 (EVALUATION-2026-11-13.md, "Re-run on 0.3.2 / jevfort 0.9.1"). Residual of F03: the wait is bounded now, but the bound is paid again on every hook.

## Problem

`registering ??= registerTools(...).finally(() => { registering = undefined; })` only resets when the round settles. A `$.tool.register` that never settles keeps `registering` set for the life of the module instance, and `missing` never shrinks, so:

- every owned call runs `within(..., 1000)` on the hung promise and waits the full 1 s before it answers;
- every `session.start` (a reload raises it again) waits the full 5 s;
- no tool is ever registered again in that instance (the retry of F02 never runs).

`registerTools` records results only after `Promise.allSettled` over all missing tools, so one hung tool (say `score`) keeps the three that registered fine in `missing` and their `names` entries unrecorded: calls of `noul` pay the 1 s too.

For jevfort the 1 s comes out of its 4 s interactive budget, and jev-api's own `timeout` clock only starts after the wait: a call with `timeout: 4` answered `timeout after 4000ms` after 5003 ms, past jevfort's budget.

## Evidence

Proven (harness `rerun.mjs`, `tool.register` never settling): all four hung: `session.start` 5003.4 ms, five owned `noul` calls 1002.1 / 1000.6 / 1001 / 1001.3 / 1000.5 ms, a second `session.start` 5003.3 ms, 4 register calls in total. Only `score` hung: identical figures (`noul` 1000.7-1002.2 ms per call). Healthy baseline for the same call: 6.8 us median. Estimated: how likely the engine's `$.tool.register` hangs at all (the 2.1.323 typings only say it rejects until the session binds); unverified live.

## Code locations

Before 0.3.2; since the rewrite the code is `RegState`, `registerOne` and `ensureTools` in the same file.

- `onToolCall` and `onSessionStart` (the `registering ??=` memo and `within`)
- `registerTools` (`Promise.allSettled`, results applied after all settle)
- `within`

## Approach

1. Apply each tool's result as it settles (`todo.map(async (type) => { try { ...; missing.delete(type) } catch { log } })`), so one hung tool does not keep the others in `missing`.
2. Drop the memo when `within` gives up: after a timeout, set `registering = undefined` and remember the time (`registerGaveUpAt`); the next attempt waits for a back-off (shared with F17) instead of re-awaiting the hung promise. A hung promise left behind is harmless (`register` replaces a tool registered again).
3. In `onToolCall`, do not await the registration at all (see F17): the tool being called is already answered by its default name.

## Verification

As shipped: the test named under Status ("a hanging registration of one tool is waited for once, not by every call": one tool hangs, four owned calls, one 1 s wait). The plan before the fix also named a check that `noul`'s name is recorded while `score` hangs; the shipped test checks that the calls are answered.

## Constraints

Every owned call is still answered (a `deny` on failure). No `next(e)` for owned tools. `$` only passed to top-level functions; no timers outside hooks.

## Related

F03 (introduced the bound), F17 (same code: retry policy), F02.
