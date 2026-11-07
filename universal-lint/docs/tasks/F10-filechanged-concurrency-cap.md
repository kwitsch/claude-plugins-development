---
id: F10
title: Cap concurrent FileChanged lints across hook processes (slot files)
status: open
priority: high
area: universal-lint/src/hooks/lint-file.mts (fileChangedHandler, lintResolved, runLintTool, main), universal-lint/.claude/rules/hook-design.md
---

# F10 Cap concurrent FileChanged lints across hook processes

## Status

Open. watch-filechanged finding (confirmed, high). This is the upgrade the `shortcut:` comment in `fileChangedHandler` already names ("add slot files under CLAUDE_PLUGIN_DATA if bulk changes overload the machine"), not a reversal of a design decision.

## Problem

Claude Code starts one FileChanged hook process per changed watched file, all at once, and there is no cross-process admission control. Every process that passes the skips runs its full lint simultaneously (hook node, rtk, npm/npx, linter node, tsc). Bash-driven bulk changes that differ from HEAD (formatters, `sed -i`, codegen, builds of tracked output) exhaust RAM and CPU; load pushes the rtk npx attempt past `RTK_NPX_ATTEMPT_TIMEOUT_MS` (5 s), so each process also runs bare npx, doubling the work. `git checkout` mostly takes the cheap git-status skip.

## Evidence

- ts200 (200 .ts, tsconfig, eslint config, real tools, stdin from a file): N=10 modified 5.0 s wall, 22.6 s CPU, 42 processes, 2.2 GB summed RSS; N=50 32.5 s, 112 s CPU, 151 processes, 8.5 GB on a 9.7 GB machine (all 50 rtk-lint attempts fell back to `npx --yes eslint`, npx p50 8.2 s, max 23.3 s); traced N=200 1364 s wall (swap thrash), 600 processes, 16.4 GB.
- Verifier (ts60): N=1 1.4 s / 1.9 s CPU / 249 MB; N=10 3.1 s / 20.9 s / 2.0 GB; N=30 7.2 s / 61.3 s / 5.5 GB, 38 npx spawns, 8 of them `npx --yes` fallbacks. Summed RSS double-counts shared pages.
- Real session: a 20-file .ts change gave 20 concurrent hook processes, about 22 tsc and about 25 extra npm/npx/eslint processes, 3.8 GB summed RSS vs 0.45 GB baseline; "FileChanged settled" at 4.6-6.8 s. Claude Code delivered 50 events within 934 ms with no throttling of its own.
- Skip paths are cheap: 200 identical rewrites 1.9 s wall, 19.7 s CPU.

## Code locations

`fileChangedHandler` (the `shortcut: one process per FileChanged, no cross-process cap` comment; skip order unlink → scope → digest → git status → `lintResolved`); `lintResolved`; `runLintTool` (`RTK_NPX_ATTEMPT_TIMEOUT_MS` fallback); `main`.

## Approach

In `fileChangedHandler`, after the cheap skips and before `lintResolved`, acquire one of K slots under `${CLAUDE_PLUGIN_DATA || tmpdir()}/fc-slots/<i>`: create with `writeFileSync(..., { flag: "wx" })` holding the pid; reclaim a slot whose pid fails `process.kill(pid, 0)` or whose mtime is older than the 90 s hook timeout; while none is free poll every 50-100 ms with `Atomics.wait` on a SharedArrayBuffer; release in `finally`. K = `max(2, floor(os.availableParallelism() / 4))` (3 here). Give up after about 45 s: return `{}` with a stderr note (fail open). FileChanged only; PostToolUse Write/Edit stays immediate. Acquire after the cheap skips, never before (lesson of dprint F05/F13). Replace the "no cross-process cap (accepted)" line in hook-design.md and re-derive the timeout budget (slot wait + lint ≤ 90 s).

## Verification

Burst N=50 modified on a ts200-like repo: peak lint processes ≤ K, summed RSS under 2 GB, no `npx --yes` fallback (rtk attempt no longer times out), every event linted. Vitest in file-detection.test.mts: 20 concurrent FileChanged events with a recording stub that appends start/end timestamps; max overlap ≤ K, all 20 recorded. Stale-slot test with a dead pid.

## Constraints

No debounce for Write/Edit (user decision). Must fit the 90 s hook timeout. Fail open on any slot error (lint as today). Zero-dependency; TSDoc; version bump.

## Related

F13 (dedup inside the cap), F15 (checkout), F29 (budget), F27 (tests), dprint F05/F13 (in-process analogue).
