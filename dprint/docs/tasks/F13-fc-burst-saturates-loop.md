---
id: F13
title: Bound FileChanged burst load on the MCP server event loop
status: done
priority: none
area: dprint/src/mcp/format.mts (fileChanged, acquireChangeSlot, releaseChangeSlot, MAX_ACTIVE_CHANGES, MAX_WAITING_CHANGES)
---

# F13 Bound FileChanged burst load on the MCP server event loop

## Status

Done. FileChanged handling admits at most 8 concurrent events (`MAX_ACTIVE_CHANGES`), queues up to 1000 more (`MAX_WAITING_CHANGES`, dropped beyond with a stderr line), and runs one git spawn per event instead of two.

## Problem

Claude Code fires FileChanged mcp_tool hooks concurrently (real session: 120 events within ~180 ms, 115 in flight). The server started one handler per stdin line with no admission control; each event did synchronous realpath/findConfig/readFileSync/digest and two git spawns. Event loop utilization was 99% of a 50-event burst (~0.2 s busy); a format_pre landing in the burst waited 196-213 ms instead of 5.9 ms (bench) or 90-96 ms (real session) vs ~9 ms quiet. With an inflated server RSS (F12) a spawn costs up to 36 ms, so 100 spawns block the loop seconds.

## Evidence

- Real session log: file_changed n=122, max in flight 115, latency median 154.9 / p90 319.9 / max 385.5 ms vs 0.9 ms isolated.
- Prototype matrix (median ms, 50-event chunk / paced-122 burst wall / format_pre during burst): built 189.7 / 242.5 / 213; 4-slot semaphore alone 184.6 / 333.6 (+38%) / 24; single git spawn alone 86.4 / 185.7 / 138; semaphore + single spawn 98 / 226 / 21-26. Only the combination meets the pass criteria (format_pre < 30 ms, burst wall within 20%).
- Single `git status --porcelain --ignored -- <file>` replaces isGitIgnored + status: skip when stdout is "" or starts with "!!".

## Code locations

- `acquireChangeSlot` / `releaseChangeSlot` (FIFO hand-over of the slot to `waitingChanges`) and constants `MAX_ACTIVE_CHANGES = 8`, `MAX_WAITING_CHANGES = 1000`, `activeChanges`, `waitingChanges` in dprint/src/mcp/format.mts.
- `fileChanged` in the same file: size check, then `acquireChangeSlot`, file read only after the slot is held, then one `execFileAsync("git", ["--no-optional-locks","status","--porcelain","--untracked-files=normal","--ignored=matching","--", fp])`; `releaseChangeSlot` in `finally`.

## Approach

Implemented as validated: (1) slot semaphore (8 slots, FIFO, bounded queue) acquired after the cheap early exits (unlink, scope, config, size) and released in `finally`; (2) one git spawn: empty or `!!` output means skip, git failure means format. `--untracked-files=normal` is required, otherwise `status.showUntrackedFiles=no` makes git reject `--ignored`. Trap: never ship the semaphore without the single spawn (paced bursts get 30-38% longer). The text is read after the slot is held so waiting events do not each hold up to 1 MiB.

## Verification

- tests/mcp-server.test.mts: "60 concurrent file_changed events are all formatted".
- Re-measure: send 50-122 file_changed events at once plus a format_pre 50 ms into the burst; target format_pre < 30 ms.
- `pnpm --filter dprint build && pnpm --filter dprint test`.

## Constraints

- Edit src/, never plugin/*.mjs; keep fail-open; TSDoc on every symbol; version bump if touched again.

## Related

- F05/F06: drop-at-50 and double-spawn findings fixed by the same change.
- F24: watch list dies after the first checkout, so bursts only matter if F24 is solved.
- F12: spawn cost grows with server RSS.
