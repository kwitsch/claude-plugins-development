---
id: F17
title: A permanently failing registration is retried on every owned call, with a log line each time
status: done
priority: low
area: jev-api/src/hooks/register.mts (onToolCall, registerTools)
---

## Status

Done in jev-api 0.3.2: a refused tool is retried once at once, then after 5 s, 10 s, ... (max 5 min) and logged once. Test: "a permanently failing registration is retried with back-off and logged once".

Earlier state: Open. Found in the re-run on 0.3.2 (EVALUATION-2026-11-13.md, "Re-run on 0.3.2 / jevfort 0.9.1"). Side effect of the F02 fix.

## Problem

F02 made a failed registration retry at the next hook. There is no back-off and no limit: while one tool keeps failing, every owned call (of any of the four tools) starts a registration round for it, awaits it (up to 1 s, F03 bound) and writes one `registering <tool> failed: ...` line to the plugin log. The failing tool's rejection latency is added to calls of the other tools, which do not need it: the call being answered is already reachable by its default name (F03's task said the same of the original wait). Calls that come before `session.start` (the engine rejects `$.tool.register` until the session binds) make 4 attempts and 4 log lines each.

## Evidence

Proven (harness `rerun.mjs failing`): `batch` registration rejecting at once, 1000 owned `noul` calls: 1000 register attempts, 1000 log lines, 1000 `within` timers (0 live), 1117 us median per call against 6.8 us healthy (the extra is the rejection's own latency). Rejecting after 50 ms: 20 calls, 20 attempts, 20 log lines, 50.27 ms median per call. 3 calls before `session.start`: 12 attempts, 12 log lines. Estimated: the cost of one engine `$.tool.register` and `$.ui.log` dispatch (not measured; the harness calls are free).

## Code locations

Before 0.3.2; since the rewrite the code is `RegState`, `registerOne` and `ensureTools` in the same file.

- `onToolCall` (the awaited `within(registering ??= registerTools(...), REGISTER_WAIT_MS)`)
- `registerTools` (one log line per failed tool per round)

## Approach

1. In `onToolCall`, start the retry without awaiting it (best effort, `registering ??= ...` and `.catch`), or await it only for the tool being called; the answer never needs it.
2. Back off: retry a failed tool at most once per N seconds (e.g. 30 s, a module-level `lastAttemptAt`), and always at `session.start`.
3. Log a tool's failure once per message change, not once per attempt.

Check first whether an unawaited `$.tool.register` from a hook that has already returned still registers in the engine (in-frame rules, see jevfort's `.claude/rules/register-hooks.md`); if not, keep the await but only with the back-off.

## Verification

As shipped: the test named under Status ("a permanently failing registration is retried with back-off and logged once": 2 attempts inside the back-off, a third after 6 s, none within the next 10 s window, one log line).

## Constraints

A registration that fails at `session.start` must still be retried in the session (F02). Every owned call answered.

## Related

F02, F03, F16 (same code: do together).
