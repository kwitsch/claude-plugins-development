---
id: F04
title: Bound dprint lsp child memory for large documents
status: done
priority: medium
area: dprint/src/mcp/format.mts (fileChanged, client, MAX_CLIENTS, MAX_CHANGED_BYTES), dprint/src/mcp/lsp.mts (DprintLsp)
---

# F04 Bound dprint lsp child memory for large documents

## Status

Done in 0.13.0: `DprintLsp` stops its child after 2 min idle (`IDLE_MS`, constructor option `idleMs`; the timer is armed when the format queue drains and cleared by the next format; the next format respawns). Test: "idle lsp child exits after idleMs and the next format respawns it".

Earlier state: Partial (release dprint 0.8.0). Done: `fileChanged` skips files above `MAX_CHANGED_BYTES` (1 MiB) with one stderr line, using `statSync` before any read, and reads the file only after a FileChanged slot is held (waiting events keep no text alive). Not done: the RSS high-water of a `dprint lsp` child after a large Write/Edit document (no child recycling, no idle dispose). At most `MAX_CLIENTS` = 8 children live (LRU eviction in `client`, pre-existing).

## Problem

The wasm plugin memory inside `dprint lsp` is retained for the child's lifetime; the client never shrinks it. RSS = floor ~25 MB + high-water of the largest document formatted: 500 KB .ts -> ~180-290 MB; 1 MB .ts -> ~307-330 MB; 1.4 MB dirty .ts -> 330-620 MB; 5 MB compact JSON -> 1.1-1.65 GB; ~20 MB JSON -> 30 s timeout, child killed/respawned. No per-format leak for small files (600 x 27 KB: flat 35 MB). Ratio is content-dependent (rewriting work, not bytes): real 2.3 MB lib.dom.d.ts ~78 MB/MB; already-formatted lockfile-style JSON/YAML costs 2-7 MB. Up to two children per cwd (`format_pre` client and the separate `file_changed` client keyed `cwd + "\0file_changed"`).

## Evidence

Real session (bigjson-append): one in-place append to a watched 6.5 MB JSON -> 6.1 s hook, `file_changed` child 1.96 GB peak / 1.70 GB retained to session end, MCP server RSS 57 -> 271 MB (see F12 effect: later spawns 8.7 -> 17 ms). With the 1 MiB cap: 1 MB and 5 MB compact JSON return in 0-1 ms with no child (previously 1018 ms/230 MB and 5645 ms/1128 MB). Remaining exposure measured: Edit on 594 KB .ts leaves a 290 MB child; 1.8 MB .ts -> 1056 MB child; the model cannot emit multi-MB Writes, so exposure is Edits of existing large tracked files (0.4-9 MB generated JSON, bundles, large .md exist in the user's repos). dprint defaults do not exclude package-lock.json / pnpm-lock.yaml.

## Code locations

- `fileChanged` (`statSync(s.fp).size > MAX_CHANGED_BYTES`, then `acquireChangeSlot`, then `readFileSync`)
- `MAX_CHANGED_BYTES`, `MAX_CLIENTS`, `client` (LRU map), `disposeLsp`
- `DprintLsp.dispose`, `DprintLsp.formatNow` (finally block with `didClose`), `DprintLsp.format`
- test: "file_changed skips files above 1 MiB" in `tests/mcp-server.test.mts`

## Approach

Done: the file_changed size cap (and read-after-slot ordering). Open, only if worth it:
(a) In `formatNow`'s `finally`, after `didClose`: `if (text.length > MAX_KEEP_BYTES) this.dispose();` with 512 KiB. Prototype: next format sees a 22-25 MB child, 123 tests green; costs ~10 ms per respawn (p90 48 ms under load) and +19-26% on Edits of 0.6-1.8 MB files (which already take 1.2-3.9 s); files just under 512 KiB still retain ~250 MB.
(b) Alternative: unref'd idle-dispose timer reset per format (60-300 s). Prototype (1 s): child gone 1.3 s after a 1.1 MB format; first format after idle ~9 ms; no orphan at exit; frees the 25 MB floors of all children; NOT run through the test suite. Keeps memory during bursts.
Trap: dispose must go through the existing path so pending requests reject and the next `format` respawns; never dispose a child that has queued formats behind the current one without checking `queue` ordering (disposal inside the queued call is safe because queued calls respawn via `start`). Do not apply (a) or (b) without the user's decision: it is a trade of latency for memory.

## Verification

Done part: `pnpm --filter dprint test`. For (a)/(b): add a stub-based test that a document above the threshold causes the stub child to exit and the next format respawns (stub already supports crash respawn: "crashing dprint -> {}, then ... respawned"); measure child RSS from `/proc/<pid>/status` (VmRSS) after formatting a 1 MB .ts then a 3-line format.

## Constraints

Edit `src/`, never `plugin/**/*.mjs`; `pnpm --filter dprint build && pnpm --filter dprint test`; zero-dep node builtins; fail open; TSDoc on every symbol; version bump in `dprint/plugin.json` AND `dprint/package.json`.

## Related

F05 (burst queue holds slots; read-after-slot lives there), F12 (server RSS inflation from the same big payloads), F09 (cost of dirty big documents), F08 (large unformatted Edit cost).
