---
id: F01
title: Per-event cost baseline and re-measurement harness
status: done
priority: medium
area: universal-lint/scripts/perf.mts (harness), universal-lint/plugin/hooks/lint-file.mjs (built hook, measured from outside), universal-lint/.claude/rules/hook-design.md, universal-lint/.claude/rules/tests.md
---

# F01 Per-event cost baseline and re-measurement harness

## Status

Done in 0.15.1. Shipped: the harness `universal-lint/scripts/perf.mts` (`node universal-lint/scripts/perf.mts [runs]`, default 5 runs, after `pnpm --filter universal-lint build`; 14 cases, each with the real PATH and with the `/mnt/` dirs removed, one warm-up round, every run checked against its expected exit status and observable, exit 1 on any failure; fixtures in `os.tmpdir()`, nothing written into the repo) and the "Measured cost" note at the end of `.claude/rules/hook-design.md` (0.15.1 medians, machine label, harness command, debug-file recipe). The harness is the flat `scripts/perf.mts`, not `scripts/perf/`, because the root `tsconfig.src.json` type-checks only `*/scripts/*.mts`. Cut, left as follow-ups: a burst case (N concurrent hook processes), a case-name filter, the `--import` preload for per-subprocess breakdowns (Approach step 2), live `claude -p --debug-file` runs (recipe documented only), and the repo-explorer-mcp 0.10.3 pin check (still unverified). No change to `src/`.

## Problem

There is no written baseline of what one hook event costs, and the analysis harness lived in a temporary scratchpad. Hook durations, hook kills at the 90 s timeout and clean lints leave no trace in transcripts: only `--debug-file` logs `PostToolUse:Edit [... lint-file.mjs] finished with status N (ms)`. 0.14.0 findings appear as `hook_blocking_error` attachments carrying `toolUseID` (0.10.x used `async_hook_response` without it).

## Evidence

0.14.0 (rtk era; rtk support was removed in 0.15.0) medians, real PATH (63 dirs, 44 on /mnt/c) unless noted:

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

0.15.1 medians in ms, real PATH / no /mnt (`node universal-lint/scripts/perf.mts 5`, 2026-11-07, WSL2 6.18.33.2-microsoft-standard-WSL2, 12 cores, 9.5 GB, node v24.22.2, tsc 7.0.2, PATH 63 dirs / 44 on /mnt/c); the same numbers as hook-design.md "Measured cost":

- Floor: `node -e 0` 24 / 24; hook with payload `{}` 41 / 40; out-of-scope `.json` Write 38 / 42.
- Missing linter: `.sh` (shellcheck) 132 / 41, `.py` (ruff) 138 / 44, `.yml` (yamllint) 134 / 43.
- `.md` Write, markdownlint-cli2 through npx (warm cache): 976 / 798.
- `.ts` Write 861 / 786, Edit 855 / 811: a 30-line `a.ts` with a strict `tsconfig.json`, eslint through npx (no eslint config: skip) plus tsc 7.0.2 warm incremental, so tsc is included. Not the 0.14.0 "ts300" fixture: comparable with the 0.14.0 `.ts` line in order of magnitude only.
- FileChanged, ext4: tracked-unchanged skip 44 / 46, ignored skip 43 / 43, unlink 41 / 39.
- SessionStart: fixture (6 lintable files) 45 / 46; this repo 59 / 60.

## Code locations

None changed. Measured entry points: `main`, `lintFileHandler`, `fileChangedHandler`, `watchPathsHandler` in universal-lint/src/hooks/lint-file.mts (built to plugin/hooks/lint-file.mjs).

## Approach

1. Re-create a small harness under `universal-lint/scripts/perf/` or keep it in a scratchpad (decide; scripts in `scripts/` are `.mts` run by Node 24): spawn the built hook with a PostToolUse/FileChanged/SessionStart JSON on stdin from a FILE (a node pipe makes `readFileSync(0)` throw EAGAIN on large or late payloads, see F05), cwd = fixture root, `CLAUDE_PLUGIN_DATA` = scratch dir; report median/min/max over N runs with `process.hrtime`. Done: the flat `universal-lint/scripts/perf.mts` (see Status).
2. A `--import` preload that wraps `spawnSync`/`execFileSync` and the fs sync calls, then calls `syncBuiltinESMExports`, gives per-subprocess breakdowns. Cut: no deliverable needed it; a later task that needs a breakdown adds it.
3. Run each case with the real PATH and with the /mnt dirs removed, so WSL effects are separated (F28). Done: every case runs with both PATH variants.
4. Real sessions: `claude -p --debug-file <f>`; grep `lint-file.mjs.*finished with status`; join `hook_blocking_error.toolUseID` to the tool_use. Cut for live runs (API cost, real hooks); the recipe is in hook-design.md "Measured cost".
5. Write the table above (refreshed) into a short "Measured cost" note in hook-design.md and point to the harness. Check the repo-explorer-mcp pin with one debug run there and drop it if it shadows 0.14.0. Done: the note carries the 0.15.1 numbers; the pin check is cut and still unverified.

## Verification

The harness reproduces the medians above within noise on this machine; the debug-file recipe reproduces live per-hook durations (live run: .ts Write 1358 ms, .ts Edit 1191-1271, .sh 138, .md Edit 1082-1148).

0.15.1: the harness ran with every row `ok` (`node universal-lint/scripts/perf.mts 5`, exit 0). The 0.14.0 medians are replaced, not reproduced 1:1, because rtk was removed in 0.15.0 and the `.ts` fixture differs (30-line `a.ts` with tsc, not ts300); the debug-file live-run check was not repeated (cut).

## Constraints

No telemetry or logging in the shipped plugin; no `userConfig`. Label every number with machine and date. Keep hook-design.md under 40,000 characters.

## Related

All tasks. F05 (stdin harness caveat), F28 (WSL PATH), F32 (echo race), F33 (watchPaths size). dprint F22 (same kind of baseline for dprint).
