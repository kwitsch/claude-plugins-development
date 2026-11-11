---
id: F10
title: Cap concurrent FileChanged lints across hook processes (slot files)
status: done
priority: high
area: universal-lint/src/hooks/lint-file.mts (fileChangedHandler, lintResolved, acquireSlot, slotStale, FILE_CHANGED_SLOTS, FILE_CHANGED_BUDGET_MS, main), universal-lint/.claude/rules/hook-design.md
---

# F10 Cap concurrent FileChanged lints across hook processes

## Status

Done in 0.15.9. Shipped: after the git status skip and before `lintResolved`, `fileChangedHandler` takes one of `FILE_CHANGED_SLOTS` = `max(2, floor(os.availableParallelism() / 4))` (3 on 12 cores) slot files `${CLAUDE_PLUGIN_DATA || os.tmpdir()}/fc-slots/<i>` through `acquireSlot` (exclusive `wx` create holding the pid; `slotStale` reclaims a slot whose pid is dead or whose mtime is at least 90 s old or at least 90 s in the future; 100 ms `Atomics.wait` polls) and releases it in a `finally`; a slot error lints without a slot (fail open); the `shortcut:` comment is gone. Deviation from the 45 s give-up below: the 90 s hook timeout counts from process start and git (up to 10 s) runs before the wait, so a fixed 45 s wait breaks the timeout for TS (10 + 45 + 30 + 45 = 130 s). The wait instead ends at process uptime `FILE_CHANGED_BUDGET_MS` (85 s) minus the file's nominal lint budget: `.ts/.tsx/.mts/.cts` 10 s, `.rs` 40 s, every other lintable extension 55 s; no slot by then returns `{}` with the stderr note `universal-lint: FileChanged: no lint slot free in time, <path> not linted` (exit 0). PostToolUse Write/Edit and the skill driver stay uncapped (no-debounce user decision). Measured (manual burst, ts200-f10 fixture, label in hook-design.md "Measured cost"), medians of 3, K = 3, 0.15.8 -> 0.15.9: N=10 wall 1095 -> 986 ms, peak concurrent lints (hook processes with a live non-`git` descendant) 10 -> 3, peak summed RSS 1442 -> 799 MB, linted 10 -> 10 (skipped 0), killed 0 -> 0; N=50 wall 4769 -> 3515 ms, peak concurrent lints 50 -> 3, peak summed RSS 6562 -> 2964 MB, linted 50 -> 50 (skipped 0), killed 0 -> 0. The `git status` children of waiting hooks are not bounded (N=50 peaked at 6/7/4 with them counted; the git gate runs before the slot gate by design).

## Problem

Claude Code starts one FileChanged hook process per changed watched file, all at once, and there is no cross-process admission control. Every process that passes the skips runs its full lint simultaneously (hook node, rtk, npm/npx, linter node, tsc). Bash-driven bulk changes that differ from HEAD (formatters, `sed -i`, codegen, builds of tracked output) exhaust RAM and CPU; load pushes the rtk npx attempt past `RTK_NPX_ATTEMPT_TIMEOUT_MS` (5 s), so each process also runs bare npx, doubling the work. `git checkout` mostly takes the cheap git-status skip.

## Evidence

Measured on 0.14.x with the rtk route; rtk was removed in 0.15.0 and the npx route is now local bin -> npx-cached bin -> npx (F04/F09).

- ts200 (200 .ts, tsconfig, eslint config, real tools, stdin from a file): N=10 modified 5.0 s wall, 22.6 s CPU, 42 processes, 2.2 GB summed RSS; N=50 32.5 s, 112 s CPU, 151 processes, 8.5 GB on a 9.7 GB machine (all 50 rtk-lint attempts fell back to `npx --yes eslint`, npx p50 8.2 s, max 23.3 s); traced N=200 1364 s wall (swap thrash), 600 processes, 16.4 GB.
- Verifier (ts60): N=1 1.4 s / 1.9 s CPU / 249 MB; N=10 3.1 s / 20.9 s / 2.0 GB; N=30 7.2 s / 61.3 s / 5.5 GB, 38 npx spawns, 8 of them `npx --yes` fallbacks. Summed RSS double-counts shared pages.
- Real session: a 20-file .ts change gave 20 concurrent hook processes, about 22 tsc and about 25 extra npm/npx/eslint processes, 3.8 GB summed RSS vs 0.45 GB baseline; "FileChanged settled" at 4.6-6.8 s. Claude Code delivered 50 events within 934 ms with no throttling of its own.
- Skip paths are cheap: 200 identical rewrites 1.9 s wall, 19.7 s CPU.

## Code locations

`fileChangedHandler` (skip order unlink → scope → digest → git status → slot (`acquireSlot`) → `lintResolved`, slot released in `finally`); `acquireSlot`, `slotStale`; constants `HOOK_TIMEOUT_MS`, `FILE_CHANGED_BUDGET_MS`, `FILE_CHANGED_SLOTS`; `lintResolved`; `main`.

## Approach

In `fileChangedHandler`, after the cheap skips and before `lintResolved`, acquire one of K slots under `${CLAUDE_PLUGIN_DATA || tmpdir()}/fc-slots/<i>`: create with `writeFileSync(..., { flag: "wx" })` holding the pid; reclaim a slot whose pid fails `process.kill(pid, 0)` or whose mtime is older than the 90 s hook timeout; while none is free poll every 50-100 ms with `Atomics.wait` on a SharedArrayBuffer; release in `finally`. K = `max(2, floor(os.availableParallelism() / 4))` (3 here). Give up when process uptime reaches `FILE_CHANGED_BUDGET_MS` (85 s) minus the file's lint budget (shipped: `.ts/.tsx/.mts/.cts` 10 s, `.rs` 40 s, others 55 s; a fixed 45 s breaks the 90 s timeout for TS): return `{}` with a stderr note. FileChanged only; PostToolUse Write/Edit stays immediate. Acquire after the cheap skips, never before (lesson of dprint F05/F13). Replaced the "no cross-process cap (accepted)" line in hook-design.md and re-derived the timeout budget (git + slot wait + lint ≤ 85 s nominal).

## Verification

Manual burst N=10 and N=50 modified on the ts200-f10 fixture (driver in the session scratchpad, numbers in Status and hook-design.md "Measured cost"): peak lint processes ≤ K on 0.15.9 (lint = a hook process with a live non-`git` descendant), none killed, linted + skipped = N (measured split 50 + 0); summed RSS reported, not gated (the waiting hook node processes Claude Code spawns per event stay alive, blocked in `Atomics.wait`). Vitest in file-detection.test.mts: 20 concurrent FileChanged events with a stub that records start/end timestamps, max overlap ≤ `FILE_CHANGED_SLOTS`, all 20 linted, slots released; an unusable data dir lints without a slot; a `.ts` file with every slot held gives up at uptime 10 s with the stderr note, exit 0. registry.test.mts: `acquireSlot` give-up and held cases, stale reclaim for a dead pid and an mtime 91 s old or 91 s in the future.

## Constraints

No debounce for Write/Edit (user decision). Must fit the 90 s hook timeout. Fail open on any slot error (lint as today). Zero-dependency; TSDoc; version bump.

## Related

F13 (dedup inside the cap), F15 (checkout), F29 (budget), F27 (tests), dprint F05/F13 (in-process analogue).
