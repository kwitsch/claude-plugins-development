---
id: F23
title: "The transport server's RSS grows from 49 MB to over 200 MB while its JS heap stays at 12 MB"
status: open
priority: low
area: jev-api/plugin/.mcp.json (server start arguments), jev-api/src/mcp/server.mts
---

## Status

Open. Found in the performance analysis of 2026-11-15 ([EVALUATION-2026-11-15.md](../evaluations/EVALUATION-2026-11-15.md), "Timers, listeners, memory"). Nothing implemented.

## Problem

Since 0.5.0 every session with a configured Jev runs one `node mcp/server.mjs` process (F22). Its resident memory grows with the number of requests it has served: from 49 to 51 MB idle to about 133 MB after 4,000 small requests and 224 MB after 20,000, and to 163 MB after 1,000 requests with a 120 KB state. The JS heap does not leak (heapUsed stays at 8 to 12 MB after a forced GC); V8 grows its young generation (heapTotal from 7 MB to 79 MB) and keeps the pages. For a sidecar that holds no data between requests that is several times the memory it needs, per session and per open Claude Code window.

## Evidence

Proven (harness, built `plugin/mcp/server.mjs` spawned with `--expose-gc` and a preloaded module that runs two `gc()` on `SIGUSR2` and prints `process.memoryUsage()`; the server code unchanged; requests sent directly over stdio JSON-RPC to a local stub answering at once; Node v24.22.2, one WSL2 machine):

| Requests (state)       | RSS default (MB) | heapUsed | heapTotal | RSS with `--max-semi-space-size=1` | heapTotal |
| ---------------------- | ---------------- | -------- | --------- | ---------------------------------- | --------- |
| 0                      | 50.9             | 4.6      | 7.3       | 50.8                               | 7.3       |
| 4,000 (tiny), 4k run   | 133.0            | 12.0     | 79.1      | 96.1                               | 15.8      |
| 20,000 (tiny), 20k run | 223.7            | 11.7     |           | 108.8                              | 16.1      |
| 1,000 (120 KB)         | 163.0            | 8.4      | 74.6      | 120.0                              | 13.3      |

- The default 20k run plateaued at about 222 MB from 6,000 requests on; with the flag it plateaued at about 107 to 109 MB.
- Speed with the flag: 1.678 against 1.665 ms per small request (20k), 2.897 against 2.731 ms per 120 KB request (+6 %, against seconds of System One time for such a state).
- `MALLOC_ARENA_MAX=2` changed nothing (129.8 MB after 4,000).
- Without forced GC, the server driven through the mod stood at 277.7 MB after about 11,000 calls.
- Estimated, not measured: how many requests a real session sends (jevfort asks through `batch`; the count per turn depends on its configuration), and the server's memory under Claude Code's own MCP client.

## Code locations

- `plugin/.mcp.json` (`mcpServers.http.args`: today only `${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs`); it is hand-written plugin content, edited in `plugin/`.
- `src/mcp/server.mts` (`startServer`, `runRequest`, `readBody`): nothing in them keeps data between requests (maps `byRpc`, `byCall` emptied, `tombstones` capped at 256).

## Approach

1. Start the server with a small young generation: `"args": ["--max-semi-space-size=1", "${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs"]` in `plugin/.mcp.json` (try 1 and 2 MB; measure both with the harness above). A flag on the command line, not `NODE_OPTIONS`, so a user's own `NODE_OPTIONS` stays untouched.
2. Optional, only if the rest of the growth (about 50 to 109 MB outside the JS heap with the flag) matters: measure `--max-old-space-size` and whether the growth is code space or `fetch` (undici) buffers before changing anything else.

Not proposed: restarting the server after N requests (the mod would see `unconfigured` and resend the config, but a restart costs about 28 ms and a connection) or a bun launcher (rejected in F22).

## Verification

- Repeat the server memory runs of the Evidence section (4k and 20k tiny requests, 1k requests with 120 KB) with the changed `.mcp.json` arguments; RSS after 20k requests under 120 MB, time per request within 10 %.
- `claude plugin validate jev-api/plugin`, and one live session (`live-verify`): a `noul` call still answers through the server (`Calling MCP tool: request` in the debug log), and the server process shows the flag (`ps`).
- `tests/server.test.mts` spawns the server without the flag; if a test reads `.mcp.json`'s arguments, keep it in line.

## Constraints

- Node 24 accepts `--max-semi-space-size` as a command-line flag; the value is in MB.
- `plugin/.mcp.json` also sets `NODE_USE_ENV_PROXY` (F22 proxy fix); keep it.
- One machine, one Node version; re-measure after a Node upgrade.

## Related

F22 (the server), F14 (timers and module memory of the mod), EVALUATION-2026-11-15.md.
