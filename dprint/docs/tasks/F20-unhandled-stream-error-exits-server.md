---
id: F20
title: Optional no-op error listeners on server stdout/stderr
status: open
priority: none
area: dprint/src/mcp/server.mts (startServer, process.stdout/stderr), dprint/src/mcp/lsp.mts (DprintLsp.start)
---

# F20 Optional no-op error listeners on server stdout/stderr

## Status

Open, verdict REFUTED (worth fixing: no). No change required. Only optional two-line hardening exists, with a downside.

## Problem

Hypothesis: an `'error'` event on the dprint child's stdout/stderr or on the MCP server's own stdout/stderr is unhandled, would throw, and exit the server; interactive Claude Code never restarts a stdio server mid-session (formatting silently off until /mcp Reconnect). `lsp.mts` registers `error` only on `child.stdin`; `server.mts` writes to `process.stdout`/`process.stderr` without listeners and has no `uncaughtException` handler.

## Evidence

- Child streams: refuted. On Linux a pipe whose writer dies delivers EOF (`end`/`close`), not `error`. Stub destroying its stdout with an Error mid-frame: server alive 15/15, format_pre `{}` in ~86 ms, next call respawns. SIGKILL of the real dprint at 16 points across a 1.9 s format: server alive 16/16, fail-open in 8-47 ms. Existing `child.on("exit")` -> `failPending` handles child death.
- Server's own streams: mechanism real, trigger unrealistic. If the client closes its read end while stdin stays open, the server exits 1 with "write EPIPE" (20/20 stdout and stderr); two no-op listeners make it survive 20/20. But Claude Code holds and reads both pipes (stderr logged every session); when the client dies all pipes close together, stdin EOF wins and `rl.on("close")` exits 0 (6/6 even with a format in flight). A no-op listener would turn a vanished client into an orphan until stdin closes.
- 32 real connects logged, 30 "exited cleanly", no crash lines.
- Side observation: a child that closes stdout WITHOUT exiting hangs format_pre until the 30 s request timeout (cooldown from F14 then applies).

## Code locations

- `DprintLsp.start` in dprint/src/mcp/lsp.mts: `child.stdin.on("error", () => {})` exists; stdout/stderr have only `data` listeners (leave as is).
- `startServer` in dprint/src/mcp/server.mts: `send` writes `process.stdout`; stderr logs via `process.stderr.write` (no listeners).

## Approach

None. Do NOT add `child.stdout/stderr` error listeners (dead code on Linux) and do NOT add `process.on("uncaughtException")` (masks real bugs). If hardening is wanted anyway: at the top of `startServer` add `process.stdout.on("error", () => {}); process.stderr.on("error", () => {});` with a TSDoc/comment noting the orphan-until-stdin-close caveat.

## Verification

Only if added: test spawning server.mjs, destroying the harness read end of the server's stdout while stdin stays open, then sending `ping`/a tool call; expect an answer or at least no exit code 1. `pnpm --filter dprint build && pnpm --filter dprint test`.

## Constraints

- Edit src/, never plugin/*.mjs; TSDoc on every symbol; version bump if code changes.

## Related

- F14: timeout path for a child that goes silent.
