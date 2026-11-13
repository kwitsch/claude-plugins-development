---
id: F15
title: Negative cache for a missing dprint binary
status: done
priority: none
area: dprint/src/mcp/lsp.mts (DprintLsp.start, noDprintUntil, NOT_FOUND_RETRY_MS)
---

## Status

Done. After `findDprint()` returned null, `DprintLsp.start()` rejects "dprint not found" without searching again for 30 s (`NOT_FOUND_RETRY_MS`), per client instance (not module-global).

## Problem

`start()` called `findDprint()` on every attempt while no child ran. `findDprint` (dprint/src/skills/dprint/find-dprint.mts) does a synchronous accessSync/statSync walk of every PATH dir. On a default WSL PATH (61 entries, 44 under /mnt/c on 9P) a miss costs 95-114 ms per call; 41 ms with 20 /mnt entries; 0.13 ms on a plain Linux PATH. A project with a dprint config but no binary paid this per Write/Edit/FileChanged event, and a 50-event burst blocked the whole server for 5.9 s (a format_pre mid-burst waited 5.5 s).

## Evidence

- `findDprint()` n=30: present 0.02 ms; absent with WSL PATH 109 ms; absent without /mnt 0.13 ms. Cost is entirely the drvfs entries (109 ms vs 0.114 ms for all Linux dirs).
- Server e2e, dprint missing, WSL PATH: Write 114 ms median, burst of 50 file_changed 5912 ms; patched: Write 3.0 ms, burst 300 ms. dprint present: no regression. Cache expiry verified (dprint added mid-session is found after 30 s).
- Reachability is narrow: watch-paths.mjs prints no watch list when dprint is missing, so the FileChanged hook rarely fires in that state.

## Code locations

- `DprintLsp.noDprintUntil` (field), `NOT_FOUND_RETRY_MS`, and `start()` in dprint/src/mcp/lsp.mts: first `if (this.ready)`, then `Date.now() < this.noDprintUntil` rejects, then `findDprint()`; a miss sets `noDprintUntil`.
- tests: dprint/tests/mcp-server.test.mts "no dprint on PATH or in ~/.dprint/bin -> {}".

## Approach

Implemented as proposed but as an instance field (analysis proposed a module-level variable), so a new client (new cwd or evicted child) searches again. find-dprint.mts unchanged (skill scripts call it once per process).

## Verification

- Existing test above (behavior).
- Timing: server with PATH lacking dprint, 20 sequential format_pre Writes; calls 2+ should be ~3 ms.
- `pnpm --filter dprint build && pnpm --filter dprint test`.

## Constraints

- Edit src/, never plugin/*.mjs; fail open; TSDoc on every symbol; version bump for further changes.

## Related

- F14: same rejection path for timeouts (per document); F27: other 9P stat costs.
