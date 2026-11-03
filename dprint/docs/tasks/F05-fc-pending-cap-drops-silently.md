---
id: F05
title: FileChanged burst handling without silent drops
status: done
priority: none
area: dprint/src/mcp/format.mts (fileChanged, acquireChangeSlot, releaseChangeSlot)
---

# F05 FileChanged burst handling without silent drops

## Status

Done (release dprint 0.8.0). `fileChanged` runs at most `MAX_ACTIVE_CHANGES` = 8 events at once (git + dprint); further events wait FIFO in `waitingChanges` (up to `MAX_WAITING_CHANGES` = 1000); beyond that an event is dropped with one stderr line `[dprint-hooks] file_changed dropped (1000 waiting): <path>`.

## Problem

Old code: a counter `MAX_PENDING_CHANGES` = 50 returned `{}` silently for event 51+, and the check ran before the cheap early exits. Claude Code dispatches one FileChanged hook per watcher event concurrently (115 in flight in a real session), so `git restore` of 120 unformatted tracked files formatted exactly 50 and left 70 unformatted with no log line (confirmed on disk with `dprint check`). Sub-claims of the analysis that are wrong and must not be repeated: dropped digest-hit echoes are harmless (both return `{}`); "50 slow formats block all events for 19-55 s" is false (a slot frees per completed format).

## Evidence

Offline burst (real dprint): 100 modified files: 50/100 formatted before; after the fix 100/100, 120/120, 300/300; git concurrency 50 -> 8. 1200 events: 1008 formatted, 192 dropped with the stderr line. Wall time grows (100 one-liners 267 -> 545 ms; 120 x 150-line files 0.6 -> 1.5 s) because all the work is now done; server RSS median 104 MB. A dedicated test formats 60 concurrent events.

## Code locations

- `fileChanged` (order before the slot: `event === "unlink"`, `scopeOf`/`inScope`, `findConfig`, `statSync` size vs `MAX_CHANGED_BYTES`; after the slot: read, digest vs `written`, lone-CR check, git status spawn, lsp format, write)
- `acquireChangeSlot`, `releaseChangeSlot` (slot handed to the oldest waiter instead of decremented), `activeChanges`, `waitingChanges`
- constants `MAX_ACTIVE_CHANGES`, `MAX_WAITING_CHANGES`
- test: "60 concurrent file_changed events are all formatted" in `tests/mcp-server.test.mjs`

## Approach

Implemented as an 8-slot semaphore with a FIFO waiter list. The text is read after the slot is acquired, and a write that lands while an event waits is protected by the existing re-read check (`readFileSync !== text` skips the write) and by the `written` digest check before writing. Not implemented: per-real-path coalescing (would only save one duplicate format for a path with several queued events). Known limitation: an event whose digest matches `written` (Claude's own Edit echo) now takes a slot before returning `{}`; cost is one file read, negligible.

## Verification

`pnpm --filter dprint build && pnpm --filter dprint test`. For a new burst test above 1000: stub dprint, fire 1100 concurrent `file_changed` calls on modified files and assert stderr contains the "dropped (1000 waiting)" line for the overflow. In a real session re-run a `git restore --source=<branch> -- <120 files>` and check `dprint check <dir>`; this only works once F24-style watch loss is not in the way (the watch list of Claude Code can die after the first checkout; see F24).

## Constraints

Edit `src/`, not `plugin/**/*.mjs`; zero-dep; fail open (every error -> `{}`); TSDoc on every symbol; version bump in both `dprint/plugin.json` and `dprint/package.json`; `pnpm --filter dprint build && pnpm --filter dprint test`.

## Related

F06 (one git spawn per event, same code path), F13 (event-loop saturation by bursts), F24 (watch list static; bursts after the first checkout never arrive), F04 (size cap), F09 (format cost per file bounds burst time).
