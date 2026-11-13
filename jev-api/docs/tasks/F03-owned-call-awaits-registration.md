---
id: F03
title: A hanging $.tool.register blocks session.start and every owned tool call
status: done
priority: medium
area: bug (jev-api/src/hooks/register.mts: onToolCall, onSessionStart, registerTools)
---

## Status

Done in jev-api 0.3.2: the registration wait is bounded (`ensureTools`, 1 s in an owned call, 5 s in session.start; F16: paid once per hanging tool); a registration that never answers no longer holds the call. Test: "a registration that never answers does not hold the call".

Earlier state: Open.

## Problem

`onToolCall` awaits `(registering ??= registerTools($, names)).catch(() => undefined)` before it answers. The `.catch` covers a rejection, not a hang: if one `$.tool.register` dispatch never settles, every owned call (`noul`, `choice`, `score`, `batch`) waits on it and never sends its request; `onSessionStart` also awaits it before `next(e)`. The wait is useless for the call itself: the tool being called is already reachable (the hook answers the default `mcp__jev-api__<type>` names without any registration). It also puts one registration round in front of the first call of an instance that saw no `session.start`.

## Evidence

Proven (harness, `tool.register` returning a never-settling promise): `session.start` and an owned `noul` call both still pending after 2000 ms, 0 fetches sent. Cost of the round when it works: `session.start` with instant registration 84.8 us median (p90 113.4 us, 300 fresh module instances); with 5 ms per registration 5.79 ms (the four run in parallel). Estimated: whether the engine cuts a hung hook with its hook time limits, and after how long, is not verified (the kit does not implement them).

## Code locations

- `onToolCall` (the `await (registering ??= ...)` line), `onSessionStart`
- `registerTools`

## Approach

In `onToolCall` start the registration but do not wait for it unbounded: race it against a short bound (e.g. 1 s via `$.clock.after`, cancelled when it settles) or do not await it at all. Check first whether the engine still accepts the `$` of a hook that already returned (jevfort notes refusals "out of frame"): if not, keep the await but bound it. `onSessionStart` may keep waiting (tools must be listed for the first turn) but with the same bound. Do it together with F02 so a timed-out registration is retried by the next hook.

## Verification

Kit test: `tool.register` never settles; an owned `noul` call with `JEV_URL` set still sends its request and answers, and `session.start` resolves after the bound (advance the mock clock).

## Constraints

Every owned call must be answered; no `next(e)` for owned tools. Timer cancelled on every path.

## Related

F02 (same memo), F14 (timer cleanup).
