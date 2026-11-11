---
id: F18
title: Overlap chain lint and tsc; kill the whole process tree on timeout
status: done
priority: low
area: universal-lint/src/hooks/lint-file.mts (spawnGroup, KILL_GRACE_MS, spawnBin, runNpx, runLintTool, runChainLint, runTypeCheck, lintResolved, coalesceProjectCheck, lintFileHandler, fileChangedHandler, lintFilesHandler, main), universal-lint/src/skills/universal-lint/lint-files.mts, universal-lint/.claude/rules/hook-design.md
---

## Status

Done in 0.15.15. One helper `spawnGroup` (`child_process.spawn`, `detached: true`, own timeout timer: SIGTERM to the process group, SIGKILL after `KILL_GRACE_MS` = 1 s; per-stream cap `MAX_BUFFER_BYTES`, ENOBUFS kills the group; spawnSync-shaped result; resolves on `close`; never rejects) replaces every lint `spawnSync` (`spawnBin`, `runNpx`, `runLintTool`, `runTypeCheck`); the lint path is async end to end (`runChainLint`, `runTypeCheck`, `coalesceProjectCheck` with an async 100 ms sleep, `lintResolved`, `lintFileHandler`, `fileChangedHandler`, `lintFilesHandler`, `main`, the driver's top-level await); `acquireSlot` stays sync. One SIGTERM/SIGINT/SIGHUP handler per process SIGKILLs the live groups and re-raises (user decision at spec approval); SIGKILL of the hook leaves the children to EPIPE. tsc is decided up front in `lintResolved`: concurrent (`Promise.all`, findings order chain then tsc) iff the file is type-check-eligible and has no oxlint config with `typeCheck: true`; otherwise chain first and tsc iff oxlint did not run (`!chain.ran`), never speculative; the same predicate as before. Budget (hook-design.md "Timeout budget"): PostToolUse TS concurrent max(30, 45) + 1 = 46 s (npx 56 s); sequential fallback 30 + 45 + 2 = 77 s (npx 102 s, accepted, now rare); FileChanged worst end = max(slot deadline + sequential phases, lock-wait deadline + check timeout) + 1 s per phase: `.ts` concurrent 86 s, `.ts` fallback 87 s, `.rs` 86 s, `.go` 86 s, all < 90 s; the per-file slot reservation stays the sum chain + tsc (`.ts` give-up at uptime 10 s) and every lock deadline is unchanged. hooks.json unchanged (90/30). Tests: `tests/spawn-group.test.mts` (timeout kills a forked sleep, ETIMEDOUT; SIGTERM-trapping child SIGKILLed; ENOENT; ENOBUFS; normal exit; hook SIGTERM kills live groups), two start-order tests in `tests/tsc.test.mts` (tsc.start < eslint.end without a typeCheck config; tsc.start >= oxlint.end with one), the five `coalesceProjectCheck` tests awaited. hook-design.md measured-cost bullets F06/F08/F09/F10/F11/F12 moved to their task docs (F06 and F11 verbatim under `## Measured`, the rest pointer lines); hook-design.md is 37214 bytes (limit 40,000). Residuals: Windows unsupported for the group kill (POSIX-only plugin); a `setsid` grandchild holding a pipe delays `close` until the backstop (as spawnSync); the FileChanged non-TS npx-route overrun and the TS fallback npx overrun stay accepted; `FILE_CHANGED_SLOTS` bounds lints, not children, so a FileChanged burst may run 2K heavy children (chain + tsc per `.ts` lint without an oxlint typeCheck config), accepted (user decision at review). Measurements: "Measured" below (baseline vs after; this repo's oxlint config type-checks, so the overlap shows only on an eslint+tsc fixture, covered by the start-order test).

## Problem

1. `lintResolved` runs `runChainLint` then `runTypeCheck`, both with `spawnSync`. The phases are independent (tsc is skipped when oxlint runs with typeCheck, decidable up front via `oxlintConfigTypeChecks`), so wall time is their sum, and the documented worst case (cold npx 55 s + tsc 45 s = 100 s > 90 s) comes from the serialization.
2. A `spawnSync` timeout sends SIGTERM to the direct child only (a shell wrapper, cargo). Grandchildren (the real linter, rustc/clippy-driver) keep running and hold cargo's build lock. (rtk and its rtk-then-direct fallback were removed in 0.15.0.) npx forwards SIGTERM, so npx-run linters die.

## Evidence

- TS project with eslint config: .ts 985 ms vs .mjs 791 ms, so the tsc phase adds about 190 ms; tsc direct 98 ms, `rtk tsc` 121 ms. 9P .ts: rtk lint 1.14-1.32 s then rtk tsc 0.32 s, total 1.9-2.15 s. Saving = min(chain, tsc), about 0.1-0.5 s typically. (rtk figures predate 0.15.0.)
- tsc incremental: thin ts1000 warm 138-154 ms, shape edit of a widely imported module 169-281; fat ts1000 (111 importers) warm 254-284, shape edit 468-486 (about cold), cold 424. Incremental saves 30-65% except on exported-type changes of widely imported modules.
- Orphans: `spawnSync` with timeout 1000 on an sh wrapper or `rtk shellcheck` with a sleeping stub: SIGTERM at 1004-1072 ms, the sleep survives. Cold `cargo clippy` with timeout 5000: about 5 orphan rustc at 0 ms, 0 at 500-1500 ms (the claimed 2 after 3.5 s did not reproduce).
- Cold leaf crate through the hook: 45,068 ms, hit `CARGO_SPAWN_TIMEOUT_MS` (45 s), silently skipped; next run 13,664 ms.

## Code locations

`spawnGroup` (the one spawn helper), `spawnBin`, `runNpx`, `runLintTool`, `runChainLint`, `runTypeCheck` (callers), `lintResolved` (up-front tsc decision, `Promise.all`), `coalesceProjectCheck` (async lock wait), `lintFilesHandler` (driver batch entry, async), `buildSpawnOpts` (options `spawnGroup` applies); `SPAWN_TIMEOUT_MS`, `TSC_SPAWN_TIMEOUT_MS`, `NPX_SPAWN_TIMEOUT_MS`, `CARGO_SPAWN_TIMEOUT_MS`, `KILL_GRACE_MS`.

## Approach

Make the lint path async: spawn children with `child_process.spawn` (`detached: true`, own process group), same timeouts and maxBuffer, `Promise.all` over chain and tsc; on timeout `process.kill(-pid, "SIGTERM")`, escalate to SIGKILL. Decide tsc up front: concurrent unless an oxlint `typeCheck: true` config exists; then chain first and tsc only if oxlint did not run (only that case stays sequential). The skill driver follows (async `lintFilesHandler`, awaited by the driver; still one spawn at a time). Re-derive the timeout budget: nominal worst case max(chain, tsc) instead of the sum (F29). `timeout`/`setsid` wrappers are not portable (no `timeout` on stock macOS).

## Verification

Spawn log shows chain and tsc starting within a few ms. tsc.test.mts and oxlint.test.mts (typeCheck skip, oxlint-unavailable-keeps-tsc) green. New test with an in-process timeout seam (the exported `spawnGroup`'s timeout argument, in the spirit of dprint F28's `timeoutMs`; no production env var): a stub that forks `sleep` exceeds the timeout → `{}` and no surviving sleep pid.

## Constraints

Every classification unchanged (rtk is gone since 0.15.0); fail open (timeout = skip). Two heavy children at once: fine on 12 cores, note it for small machines. No new production env override. Version bump.

## Related

F13 (dedup for bursts), F29 (budget), F30 (cold Rust leaf), F27.

## Measured

### Baseline (0.15.14, committed `plugin/` of 6f98108, before any `src/` edit)

universal-lint 0.15.14 perf, 2026-11-10T17:41:49.174Z, 6.18.33.2-microsoft-standard-WSL2, 12 cores, 9.5 GB RAM, node v24.22.2, tsc 7.0.2, linters found (of shellcheck/ruff/yamllint/markdownlint-cli2/eslint/oxlint/stylelint): real PATH none; no /mnt none, local oxlint yes, PATH 63 dirs (44 on /mnt), load 1.26 -> 1.60, runs 5 (+1 warm-up)

| Case                             | real PATH med (min-max) ms | no /mnt med (min-max) ms | status |
| -------------------------------- | -------------------------: | -----------------------: | ------ |
| floor node -e 0                  |                 28 (28-30) |               28 (26-29) | ok     |
| empty payload                    |                 48 (44-51) |               46 (44-48) | ok     |
| out-of-scope .json Write         |                 46 (44-48) |               48 (43-52) | ok     |
| .sh Write                        |                 48 (46-55) |               50 (45-54) | ok     |
| .py Write                        |                 48 (45-49) |               52 (47-55) | ok     |
| .yml Write                       |                 47 (44-52) |               52 (46-63) | ok     |
| .md Write                        |              298 (292-305) |            302 (292-335) | ok     |
| .css Write (no stylelint config) |                 49 (48-52) |               47 (46-53) | ok     |
| .ts Write (no eslint config)     |              152 (146-156) |            154 (146-166) | ok     |
| .ts Edit (no eslint config)      |              157 (150-158) |            152 (144-157) | ok     |
| .mts Write (this repo)           |              325 (276-402) |            331 (300-370) | ok     |
| FileChanged tracked unchanged    |                 51 (50-55) |               54 (52-60) | ok     |
| FileChanged ignored              |                 52 (48-55) |               52 (49-63) | ok     |
| FileChanged unlink               |                 47 (44-51) |               48 (47-53) | ok     |
| SessionStart fixture             |                 56 (49-59) |               56 (53-64) | ok     |
| SessionStart this repo           |                 63 (62-66) |               63 (61-70) | ok     |

### After (0.15.15, same machine and session)

universal-lint 0.15.15 perf, 2026-11-10T18:00:48.172Z, 6.18.33.2-microsoft-standard-WSL2, 12 cores, 9.5 GB RAM, node v24.22.2, tsc 7.0.2, linters found (of shellcheck/ruff/yamllint/markdownlint-cli2/eslint/oxlint/stylelint): real PATH none; no /mnt none, local oxlint yes, PATH 63 dirs (44 on /mnt), load 1.20 -> 1.43, runs 5 (+1 warm-up)

| Case                             | real PATH med (min-max) ms | no /mnt med (min-max) ms | status |
| -------------------------------- | -------------------------: | -----------------------: | ------ |
| floor node -e 0                  |                 28 (27-32) |               26 (25-29) | ok     |
| empty payload                    |                 48 (44-49) |               49 (48-53) | ok     |
| out-of-scope .json Write         |                 47 (42-53) |               45 (44-51) | ok     |
| .sh Write                        |                 50 (46-54) |               49 (46-56) | ok     |
| .py Write                        |                 47 (46-52) |               48 (48-52) | ok     |
| .yml Write                       |                 48 (46-49) |               51 (49-51) | ok     |
| .md Write                        |              310 (293-326) |            302 (291-307) | ok     |
| .css Write (no stylelint config) |                 51 (47-54) |               49 (46-51) | ok     |
| .ts Write (no eslint config)     |              159 (149-167) |            153 (150-166) | ok     |
| .ts Edit (no eslint config)      |              153 (151-160) |            154 (147-155) | ok     |
| .mts Write (this repo)           |              310 (297-374) |            294 (285-337) | ok     |
| FileChanged tracked unchanged    |                 55 (50-59) |               54 (50-55) | ok     |
| FileChanged ignored              |                 52 (51-58) |               55 (54-58) | ok     |
| FileChanged unlink               |                 50 (44-53) |               48 (43-52) | ok     |
| SessionStart fixture             |                 55 (52-62) |               57 (54-57) | ok     |
| SessionStart this repo           |                 65 (63-67) |               63 (62-72) | ok     |
