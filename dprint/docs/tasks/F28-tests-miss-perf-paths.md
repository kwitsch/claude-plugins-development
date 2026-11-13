---
id: F28
title: Test the performance-relevant server paths
status: partial
priority: low
area: dprint/tests/mcp-server.test.mts, dprint/src/mcp/lsp.mts (DprintLsp constructor option timeoutMs)
---

# F28 Test the performance-relevant server paths

## Status

Partial. Done in 0.8.0 (branch feature/performance-analysis-fixes, PR #19): tests for a 60-event file_changed burst ("60 concurrent file_changed events are all formatted"), the 1 MiB size guard ("file_changed skips files above 1 MiB"), `status.showUntrackedFiles=no`, rangeFormatting-null stub (stub mode `range-null`; Edit still formatted), and the timeout cooldown ("lsp timeout -> later formats of that document fail fast for the cooldown ..."; in-process `new DprintLsp({ cwd, timeoutMs: 300 })`). The test-only seam is the constructor option `timeoutMs` (defaults to `REQUEST_TIMEOUT_MS`, 30 s); no env var was added.
Done in 0.12.1: Content-Length frames split over several chunks and a 4 MB payload (stub mode `chunked`). Remaining gaps (still untested): `MAX_CLIENTS = 8` LRU eviction and respawn of an evicted client; hanging `initialize` through the server (cooldown after initialize timeout) at the server level; slow git (10 s `execFile` timeouts fail open); dprint stderr forwarding; two requests in one stdin chunk.

## Problem

Before 0.8.0 the test stub answered instantly with whole-document edits, every call was awaited serially, frames were far below 64 KB and the 30 s lsp timeout could not be shortened, so regressions in concurrency, pending cap, timeout/respawn and payload handling would pass CI.

## Evidence

Adversarial run of every untested path against the 0.7.0 build found NO defect: 60 file_changed in one chunk -> 60 answered; MAX_CLIENTS: 9th cwd evicts, evicted cwd respawns, 8 live; 7-byte-chunked response frames correct (Write 187 ms, Edit 238 ms); stub `hang`/`hang-init` -> `{}` after the timeout, no leaked child, respawn ok; slow git (`/bin/sleep 12` stub) -> file_changed `{}` after 20 s and still formatted, format_pre 10 s then formatted; 5 MB payload byte-exact (324-383 ms), 20 MB 2.7-3.0 s (superlinear = F18); stub stderr forwarded to server stderr. Existing suite ~3.4 s. Cautions: wall-clock budgets on the 5 MB test are CI-flaky (use none or generous); the file_changed pending-cap assertion depends on F05 (now 8 concurrent + 1000 queued, so a 60-burst formats all 60).

## Code locations

- dprint/tests/mcp-server.test.mts: `STUB_LSP` (stub modes ok, range-error, range-null, crash, hang), `startServer`, `stubDprint`, `tool()`/`call()` helpers; tests named above.
- `DprintLsp` (constructor `{ cwd, timeoutMs? }`, `noteTimeout`, cooldown), `REQUEST_TIMEOUT_MS`, `NOT_FOUND_RETRY_MS`, `onData` in dprint/src/mcp/lsp.mts.
- `MAX_CLIENTS` and the client map in dprint/src/mcp/format.mts.

## Approach

Add the remaining tests reusing `STUB_LSP` with new modes: `chunked` (write the response frame in small pieces), `big:<MB>` (response with a MB-sized edit; assert byte-exact content, no tight time budget), a `MAX_CLIENTS` test (format_pre in 9 distinct config-bearing cwds, then the first again -> formatted; count stub spawns via a log file), `hang-init` through `DprintLsp` with `timeoutMs` (cooldown starts on an initialize timeout, see commit 7ca4f35). Use the in-process `DprintLsp` + `timeoutMs` seam for timeouts (keep each test < 1 s); do not add a production env override.

## Verification

`pnpm --filter dprint build && pnpm --filter dprint test`; new tests must fail when the guarded behavior is broken (temporarily break the code, e.g. disable eviction, to see red).

## Constraints

Tests live in dprint/tests/*.test.mts and run against the built plugin/; edit src/ only for test seams; fail-open behavior must not change; a version bump in dprint/plugin.json AND dprint/package.json is needed if anything under dprint/ is merged to main.

## Related

F05 (burst cap), F14 (timeout cooldown), F18 (onData concat), F19 (stale stdout after timeout), F04 (size guard), F02 (range-null).
