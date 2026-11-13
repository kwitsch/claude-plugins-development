---
id: F19
title: Ignore stdout of a replaced dprint child
status: done
priority: none
area: dprint/src/mcp/lsp.mts (DprintLsp.start stdout handler)
---

## Status

Done. The child's stdout `data` handler in `start()` only calls `onData` when `this.child === child`.

## Problem

On a request timeout the timer disposes the child synchronously; the queued next `format()` respawns in a microtask and resets `buf` before the event loop delivers chunks still buffered from the old child's pipe. If the old response's HEADER chunk (header + partial body) is delivered late, it prefixes the new child's initialize response: the new response is swallowed into the stale frame body, so the next format hangs a full timeout ("initialize timed out", 30 s in production) before failing open; the one after recovers. Mid-body junk and complete stale frames were harmless (unanchored header regex, unknown ids ignored, incomplete frame discarded by the reset). Window = server synchronous busy time just before the timeout fires; realistic likelihood very low (needs a format over 30 s, a queued second format, and a sub-ms to ms window).

## Evidence

- Stub 2 (no reply until SIGTERM, then a valid header + 50 KB of a 100 KB body): original 2nd format "initialize timed out" 10/10, fixed 10/10 OK. The finding's own stub 1 (wrong Content-Length + junk flood) does NOT reproduce the defect.
- Real dprint, 500-line file (523 KB response in 10-12 chunks), timeout swept in 1 ms steps with a 10 ms busy loop before the timer: original 30 hits / 51 timeouts, fixed 0 hits / 53. Real dprint writes 0 bytes after SIGTERM (20/20).

## Code locations

- `child.stdout.on("data", ...)` with `if (this.child === child)` guard in `DprintLsp.start` (dprint/src/mcp/lsp.mts). `dead()` already had the same identity check. Stderr forwarder is intentionally unguarded (cosmetic).

## Approach

One-line guard as implemented. The `timeoutMs` constructor option (F14/F28) makes a regression test possible.

## Verification

- Missing regression test worth adding (dprint/tests/mcp-server.test.mts or a DprintLsp-level test against the built plugin/mcp/lsp.mjs): PATH-first stub `dprint` whose `lsp` answers initialize, then on formatting stays silent until SIGTERM, then writes a valid Content-Length header + partial body and exits; construct `new DprintLsp({cwd, timeoutMs: 200})`, call `format(big)` and queue `format(small)`, expect the first to reject with timeout and the second NOT to reject with "initialize timed out". Cooldown applies per URI, so use a different URI for the second call.
- `pnpm --filter dprint build && pnpm --filter dprint test`.

## Constraints

- Edit src/, never plugin/*.mjs; TSDoc on every symbol; version bump for further changes.

## Related

- F14: timeout and cooldown; F18: onData rewrite must keep this guard; F28: injectable timeout.
