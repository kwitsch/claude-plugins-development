---
id: F24
title: "A call's timeout does not bound it: one-off waits for registration, store, connect and config come before the request"
status: partial
priority: low
area: jev-api/src/hooks (transport.mts ensureServer, syncConfig, sendOutcome; register.mts onToolCall; size.mts loadKnowledge; registry.mts ensureTools)
---

## Status

Partial. Found in the performance analysis of 2026-11-15 ([EVALUATION-2026-11-15.md](../evaluations/EVALUATION-2026-11-15.md), "One-off waits before a request"). Step 3 shipped: b4cd930 (fallback) and ea54af3 (server request) give the request only the time left; none left answers `timeout after <ms>ms` without sending. Open: the unbounded waits themselves (steps 1, 2, 4).

## Problem

The `timeout` of a call (input, `userConfig` option or 20 s) only bounds the HTTP request. Before it, an owned call can wait for:

- the tools' registration, at most 1 s (`REGISTER_WAIT_MS`, once per hanging tool, F16),
- the stored density, at most 1 s (`STORE_WAIT_MS`, once per module instance),
- `$.mcp.connect`, at most 3 s (`CONNECT_WAIT_MS`; when the server did not connect in session.start),
- the `config` call, at most 3 s (`CONNECT_WAIT_MS`; at the first request, when the env values changed, and after every failed request, since a failure sets `link.dirty`).

None of these waits is shortened to the time the call has left, and when a wait ends in a fallback to `$.http.fetch`, that request gets the full `timeoutMs` again. On the server path the guard adds `SERVER_GUARD_MS` (1.5 s) on top of the timeout by design. So a caller that sets `timeout` equal to its own budget (jevfort: 4 s interactive, 9 s for the compaction ranking) can get its answer after the budget: the answer is then wasted, and the caller falls back although jev-api would have answered in time without the wait.

Each wait is paid once per outage (the connect and the `config` failure mark the server down for 60 s; a hung registration is waited for once; the store is read once per instance), so a healthy session never pays it.

## Evidence

Proven (harness, built `plugin/hooks/register.mjs` with a fake `$`, `timeout` 1 s, fallback `$.http.fetch` answering at once):

| Case                                                                                                                                                               | Result                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `$.mcp.connect` never answers, first call (measured before b4cd930; now `timeout after 1000ms` after 3 s, nothing fetched)                                         | 3003 ms, answered through `$.http.fetch`; the next call 0 ms                         |
| registration, `store.get` and `$.mcp.connect` never answer, first call                                                                                             | 5003 ms; the next call 0 ms                                                          |
| a network error, then the `config` call never answers                                                                                                              | the next call 3001 ms, then 0 ms                                                     |
| the built server stopped with `SIGSTOP` after a success, 3 calls (measured before b4cd930/ea54af3; the 3008 ms row now is `timeout after 1000ms`, nothing fetched) | 2502 ms (`timeout after 1000ms`), 3008 ms (through `$.http.fetch`), 4 ms; 1 log line |

The last row also shows that F22's constraint "the next call waits for the guard again until the server answers" is out of date: the guard timeout sets `dirty`, the next call's `config` call waits 3 s, marks the server down and falls back.

Not measured: how often these waits happen in a real session (engine `$.mcp.connect` took 41 ms live in F22; a hung server or store was never seen live), and whether jevfort abandons the dispatch when its budget fires (then `next.signal` ends the wait at once and only the budget is lost).

## Code locations

- `transport.mts`: `ensureServer` (connect race against `CONNECT_WAIT_MS`), `syncConfig` (`stopOn($, CONNECT_WAIT_MS, signal)`), `sendOutcome` (falls back with `fetchViaEngine($, Math.round(left), signal)`, the time left, and answers `timeout after <ms>ms` when `left < 1`), `callServer` (`timeoutMs + SERVER_GUARD_MS`).
- `register.mts`: `onToolCall` (`ensureTools($, st, REGISTER_WAIT_MS)`, `loadKnowledge`, then `answerJev`).
- `size.mts`: `loadKnowledge` (`STORE_WAIT_MS`); `registry.mts`: `ensureTools`.

## Approach

1. Take the call's deadline once at the start of the owned call (`$.clock.now` already runs in `answerJev`; move the reading before the waits) and pass it down.
2. Bound each pre-request wait by `min(<its constant>, time left)`; a wait cut short this way behaves like its timeout today (registration goes on in the background, the store default is used, the server is marked down only when the full connect or config wait expired, otherwise the call falls back without marking it down).
3. Give the fallback request, and the server request after a `config` call, only the time left (at least 1 ms, or answer `timeout after <ms>ms` at once when none is left).
4. Keep the guard as it is (it only fires when the server itself is stuck) or document it as part of the bound.

Smaller alternative if this is judged not worth the code: document in `CLAUDE.md` and the README that `timeout` bounds the request only and that a degraded first call can take up to 5 s longer, and fix F22's stale constraint sentence.

A decision between the two needs the user (or a decision agent, per the docs rule).

## Verification

- Direct hook tests in `tests/transport.test.mts` (the rig there drives timers by hand): a call with `timeout` 1 whose connect never answers is answered within 1 s (+ the guard only on the server path); the same for a hanging `config` call after a failure and for a hanging store; a call whose time ran out during a wait sends no request.
- Repeat the table of the Evidence section with the harness; every row at or below `timeout` (+1.5 s where the server request ran).
- The existing tests for marking down and the 60 s reconnect stay green.

## Constraints

- Every owned call is answered (a `deny` on failure); jevfort's `request` input and answer shape stay.
- `$.mcp.call` has no timeout and no cancel of its own (F22); the mod's own races are the only bound.
- The engine's static check: no `$.<noun>` passed as a value, also in `lib.mjs`; run `claude plugin validate jev-api/plugin` after the change.

## Related

F03, F16 (registration wait), F21 (`loadKnowledge`), F22 (transport, guard, config), jevfort F01, F19, F20 (budgets equal to the timeout).
