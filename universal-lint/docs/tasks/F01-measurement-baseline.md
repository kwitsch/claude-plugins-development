---
id: F01
title: Per-event cost baseline and re-measurement harness
status: measurement-only
priority: medium
area: universal-lint/plugin/hooks/lint-file.mjs (built hook, measured from outside), universal-lint/.claude/rules/hook-design.md, universal-lint/.claude/rules/tests.md
---

# F01 Per-event cost baseline and re-measurement harness

## Status

Measurement-only, open. Merges the watch-filechanged docs-only finding (skip-path baseline, confirmed), the real-sessions measurement-gap finding (adjusted) and the per-type medians of all five dimensions. No code change. Every other task's Verification compares against this baseline, so do it first.

## Problem

There is no written baseline of what one hook event costs, and the analysis harness lived in a temporary scratchpad. Hook durations, hook kills at the 90 s timeout and clean lints leave no trace in transcripts: only `--debug-file` logs `PostToolUse:Edit [... lint-file.mjs] finished with status N (ms)`. 0.14.0 findings appear as `hook_blocking_error` attachments carrying `toolUseID` (0.10.x used `async_hook_response` without it).

## Evidence

Medians, universal-lint 0.14.0, real PATH (63 dirs, 44 on /mnt/c) unless noted:

- Floor: `node -e 0` 20-26 ms; hook with payload `{}` 40-47 ms; out-of-scope file (.json/.txt/node_modules/outside cwd) 38-44 ms. `NODE_COMPILE_CACHE`: no gain.
- Missing linter (.sh/.py/.yml/.java/.kt): 143-215 ms real PATH vs 42-73 ms without /mnt dirs; .php 240-266 (two misses).
- .ts without lint config (ts300): Write 1318, Edit 1194 ms (N=7); with no eslint reachable 344 ms.
- This repo, `universal-lint/src/hooks/lint-file.mts` Write: 890-1127 ms (oxlint through rtk-fail + npx; tsc skipped by oxlint typeCheck). CLAUDE.md: 1254-1644 ms.
- .md warm npx: 1113-1137 ms; cold npx 4012-5577 ms. Go warm 495-546 ms; Rust warm no-change 185-329 ms, leaf edit 770-925 ms.
- SessionStart: this repo 56-77 ms (161 paths); /mnt/c blocky-dev 2320-2711 ms (242-266 files).
- FileChanged tracked-unchanged skip: 41-61 ms ext4, 202-340 ms 9P (git status 139-180 ms); unlink exit 43 ms.
- Bursts (ts200, real tools): N=10 modified 5.0 s wall / 22.6 s CPU; N=50 32.5 s / 112 s CPU, 8.5 GB summed RSS. 200 identical rewrites 1.9 s / 19.7 s CPU.
- Real sessions: 3443 Write/Edit in 95 sessions (3185 lintable: .md 1343, .mjs 717, .ts 477, .mts 332, .py 84, .sh 76, .rs 53); estimated hook CPU per session median 7 s, p90 88 s. 0 timeout records in 71 transcripts mentioning lint-file.
- Installs: universal-lint 0.14.0 at user scope; 0.10.3 project-pinned only for /home/kwitsch/repos/repo-explorer-mcp (not verified which one runs there).

## Code locations

None changed. Measured entry points: `main`, `lintFileHandler`, `fileChangedHandler`, `watchPathsHandler` in universal-lint/src/hooks/lint-file.mts (built to plugin/hooks/lint-file.mjs).

## Approach

1. Re-create a small harness under `universal-lint/scripts/perf/` or keep it in a scratchpad (decide; scripts in `scripts/` are `.mts` run by Node 24): spawn the built hook with a PostToolUse/FileChanged/SessionStart JSON on stdin from a FILE (a node pipe makes `readFileSync(0)` throw EAGAIN on large or late payloads, see F05), cwd = fixture root, `CLAUDE_PLUGIN_DATA` = scratch dir; report median/min/max over N runs with `process.hrtime`.
2. A `--import` preload that wraps `spawnSync`/`execFileSync` and the fs sync calls, then calls `syncBuiltinESMExports`, gives per-subprocess breakdowns.
3. Run each case with the real PATH and with the /mnt dirs removed, so WSL effects are separated (F28).
4. Real sessions: `claude -p --debug-file <f>`; grep `lint-file.mjs.*finished with status`; join `hook_blocking_error.toolUseID` to the tool_use.
5. Write the table above (refreshed) into a short "Measured cost" note in hook-design.md and point to the harness. Check the repo-explorer-mcp pin with one debug run there and drop it if it shadows 0.14.0.

## Verification

The harness reproduces the medians above within noise on this machine; the debug-file recipe reproduces live per-hook durations (live run: .ts Write 1358 ms, .ts Edit 1191-1271, .sh 138, .md Edit 1082-1148).

## Constraints

No telemetry or logging in the shipped plugin; no `userConfig`. Label every number with machine and date. Keep hook-design.md under 40,000 characters.

## Related

All tasks. F05 (stdin harness caveat), F28 (WSL PATH), F32 (echo race), F33 (watchPaths size). dprint F22 (same kind of baseline for dprint).
