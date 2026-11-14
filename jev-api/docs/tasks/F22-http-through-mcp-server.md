---
id: F22
title: "The System One request cannot be cancelled and has no timeout option: it goes through a bundled MCP server"
status: done
priority: medium
area: jev-api/src/mcp/server.mts, jev-api/src/shared/http.mts, jev-api/src/hooks/transport.mts, jev-api/plugin/.mcp.json
---

## Status

Done in jev-api 0.5.0. Tests: `jev-api/tests/http-core.test.mts`, `server.test.mts`, `transport.test.mts` (a hand mutation of the guard time, of the reconnect time and a dead guard each found by a test or removed), live checks below.

## Problem

`$.http.fetch` has no `signal` and no timeout option (docs and live, see F09 and F21), so a timed-out or abandoned System One request ran on and slowed every later one. The user asked for the HTTP part to move into a bundled MCP server that the mod drives, with the timeout passed per call, and for a live test of whether `$.mcp.call` is cancelled automatically when the dispatch's signal aborts (the documentation is silent).

## Evidence

All live on Claude Code 2.1.325 with throwaway mods and stdio servers (`claude -p --plugin-dir`), then with the real plugin.

- **`$.mcp.call` is not cancelled by the signal.** An outer hook gave up after 3 s, the inner hook's `next.signal` aborted at once, the 15 s call ran to its end (18:34:21 against the abort at 18:34:09) and the server never got `notifications/cancelled`. A 15 s call inside `tool.call` is not cut by the 10 s hook budget.
- **`$.mcp.connect("<key>")`** returns `server: "plugin:<plugin>:<key>"`, waits for the connection (5 ms, also inside `session.start`) and `$.mcp.call(server, tool, args)` answers `{ isError, content }` (headless, no allow rule needed).
- **A hidden tool is not callable:** `_meta.ui.visibility: ["app"]` makes `$.mcp.call` fail with `no connected MCP tool "slow" on a server named "plugin:...:probe"`. So the tools of the transport server are visible (deferred behind ToolSearch).
- **`tool.check` sees who calls:** `origin` is `{ plugin: "<own>", tier: "user" }` for the mod's own `$.mcp.call` and `{ plugin: "engine", tier: "core" }` for the model's direct call. With the real plugin the model's direct call of `mcp__plugin_jev-api_http__request` was refused (`Permission to use ... denied by plugins ...: this tool is the internal HTTP transport ...`), although it was in `--allowedTools`. A notice that `cc-plugin-sec-default` skipped the hook appears, the deny still applies.
- **The server inherits the whole environment**, including the settings' `env` block and the user's shell variables, with no `env` entry in `.mcp.json`; `${VAR:-default}` interpolation in `.mcp.json` works too.
- **A hooks module may import from outside `hooks/`** (`../shared/http.mjs`), also through the bundled `lib.mjs`.
- **The static check applies to every module of `lib.mjs`:** `typeof $.mcp?.connect` made the module fail to load (`$.mcp is used as a value`); `claude plugin validate` reports it, the vitest kit does not.
- **Real endpoint through the server:** `timeoutMs` 1000 on a state of about 16k tokens ended after 1004 ms as `timeout after 1000ms`; a `cancel` after 1 s answered `{ cancelled: true }` and the request `aborted` after 1003 ms. A tiny request right after needed 2.1 s and 2.4 s (idle 0.16 to 0.34 s): closing the connection frees the endpoint, but not at once. A slow local stub (15 s) saw the connection closed 3.0 s after the request when an outer hook gave up after 3 s: the mod's `cancel` reached the server.
- **Sessions:** a `noul` call and a `batch` call answer through the server (`Calling MCP tool: request` in the debug log); `MCP_PROTOCOL_NEGOTIATION=legacy` and the default (modern, 41 ms connect) both work; with `node` off the `PATH` the server failed with `ENOENT`, the mod logged `HTTP server not available, using $.http.fetch: ...` and the call answered through `$.http.fetch`.

## Code locations

- `src/shared/http.mts`: `sendRequest`, `endpoint`, `hide`, `hideHost`, `detail`, `contextRefusal` (moved out of `hooks/`).
- `src/mcp/server.mts`: tools `request` and `cancel`, tombstones, dual-era loop.
- `src/hooks/transport.mts`: `ensureServer`, `sendOutcome`, `callServer`, `fetchViaEngine`.
- `src/hooks/register.mts`: the `tool.check` hook; `src/hooks/jev.mts`: `ask` and `answerJev` take the link.

## Approach

Done as designed: the server enforces `timeoutMs` with `AbortSignal.timeout` on its `fetch`; the mod races the call against `timeoutMs + 1500` and `next.signal` and fires one `cancel { callId }` when it gives up; a `cancel` that arrives first is remembered for 60 s (256 ids at most); the server takes no URL, header or key from its caller; the model is kept off the tools by `tool.check`; the old `$.http.fetch` path stays as the fallback (no reconnect for 60 s, one log line per outage).

## Verification

- `pnpm lint && pnpm --filter jev-api build && pnpm --filter jev-api test` (316 tests at the end of the work), `claude plugin validate jev-api/plugin`.
- The live checks of the Evidence section; scripts were scratch files, not in the repository.

## Constraints

- A node process per session; the server needs `node` on the `PATH` (the fallback covers its absence, without cancel).
- `$.mcp.call` has no timeout and no cancel of its own: the server's timeout and the app-level `cancel` are the only enforcement. A call abandoned while the server is down or hung runs on only on the fallback path.
- Not exercised live: an interactive session (tasks are not used by this server), a Windows host.

## Related

F09 (an abandoned request keeps running), F21 (oversized states), jevfort F01 and F20 (budgets).
