---
id: F02
title: A failed tool registration is never retried in the session
status: done
priority: medium
area: bug (jev-api/src/hooks/register.mts: registerTools, register, onSessionStart, onToolCall)
---

## Status

Done in jev-api 0.3.2: `registerOne`/`ensureTools` (state `RegState`) register only the tools still missing; a failed one stays there and the next hook (session.start, or an owned call) registers it again (F17: with back-off), concurrent hooks share the per-tool in-flight promise. Test: "a failed registration is retried by the next call, only for the tools still missing".

Earlier state: Open.

## Problem

`register` memoizes the registration in `registering` (`registering ??= registerTools($, names)`). `registerTools` uses `Promise.allSettled`, so it never rejects: a rejected `$.tool.register` is logged once and the memo holds a resolved promise for the rest of the module's life. Every later `session.start` and every owned `tool.call` reuses it, so a tool whose registration failed once (engine busy, a hook above refusing) stays unregistered. jevfort gates on the tool listing (`missingJevTools`): without `mcp__jev-api__batch` it switches itself off for the whole session.

## Evidence

Proven (harness, fake `$` whose `tool.register` rejects `batch` once and succeeds afterwards): after a failed `batch` registration and two `session.start` calls the register calls are `["noul","choice","score","batch"]`, one `ui.log` line, `batch` registered again: false. Engine side estimated: how often `$.tool.register` rejects in Claude Code is unknown.

## Code locations

Before 0.3.2; since the rewrite the code is `RegState`, `registerOne` and `ensureTools` in the same file.

- `register` (`registering` memo), `onSessionStart`, `onToolCall` (`registering ??= ...`)
- `registerTools` (`Promise.allSettled`, `$.ui.log` on rejection)

## Approach

Memo only success: track the tools still unregistered (a `Set` of `ToolName`, at most 4 entries) and let the next `session.start` (and the best-effort call in `tool.call`) register only those. Concurrent callers share one in-flight promise; clear it when it settles so the next hook retries the remainder. No retry loop with timers: the next hook is the retry point.

## Verification

Kit test: `tool.register` throws for `choice` on the first call only; after a second `$.session.start` the register specs contain `choice` twice and the others once. The existing test "a failing tool.register is logged and does not stop the others" stays green.

## Constraints

`$` exists only inside hooks: retries happen in a hook, not on a timer. Keep `allSettled` (one failure must not drop the others). Do this together with F03.

## Related

F03 (same memo), jevfort `missingJevTools`.
