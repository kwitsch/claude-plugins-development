---
id: F18
title: Overlap chain lint and tsc; kill the whole process tree on timeout
status: open
priority: low
area: universal-lint/src/hooks/lint-file.mts (lintResolved, runChainLint, runTypeCheck, runLintTool, tryRtk, buildSpawnOpts, *_SPAWN_TIMEOUT_MS, CARGO_SPAWN_TIMEOUT_MS), universal-lint/.claude/rules/hook-design.md
---

# F18 Overlap chain lint and tsc; kill the whole process tree on timeout

## Status

Open. Merges static overlap finding (adjusted: low), part (1) of the bench-js-ts tsc finding (adjusted medium; verifier: "only helps for leaf edits" overstated), static timeout-orphan finding (adjusted: low) and bench-other-langs cargo orphan finding (adjusted: low). Grouped because both need the same async spawn rewrite.

## Problem

1. `lintResolved` runs `runChainLint` then `runTypeCheck`, both with `spawnSync`. The phases are independent (tsc is skipped when oxlint runs with typeCheck, decidable up front via `oxlintConfigTypeChecks`), so wall time is their sum, and the documented worst case (cold npx 60 s + tsc 45 s = 105 s > 90 s) comes from the serialization.
2. A `spawnSync` timeout sends SIGTERM to the direct child only (rtk, a shell wrapper, cargo). Grandchildren (the real linter, rustc/clippy-driver) keep running, compete with the rtk-then-direct fallback copy and hold cargo's build lock. npx forwards SIGTERM, so npx-run linters die.

## Evidence

- TS project with eslint config: .ts 985 ms vs .mjs 791 ms, so the tsc phase adds about 190 ms; tsc direct 98 ms, `rtk tsc` 121 ms. 9P .ts: rtk lint 1.14-1.32 s then rtk tsc 0.32 s, total 1.9-2.15 s. Saving = min(chain, tsc), about 0.1-0.5 s typically.
- tsc incremental: thin ts1000 warm 138-154 ms, shape edit of a widely imported module 169-281; fat ts1000 (111 importers) warm 254-284, shape edit 468-486 (about cold), cold 424. Incremental saves 30-65% except on exported-type changes of widely imported modules.
- Orphans: `spawnSync` with timeout 1000 on an sh wrapper or `rtk shellcheck` with a sleeping stub: SIGTERM at 1004-1072 ms, the sleep survives. Cold `cargo clippy` with timeout 5000: about 5 orphan rustc at 0 ms, 0 at 500-1500 ms (the claimed 2 after 3.5 s did not reproduce).
- Cold leaf crate through the hook: 45,068 ms, hit `CARGO_SPAWN_TIMEOUT_MS` (45 s), silently skipped; next run 13,664 ms.

## Code locations

`lintResolved` (sequential phases); `runLintTool` / `tryRtk` / `runTypeCheck` (`spawnSync`); `buildSpawnOpts` (timeout only, no process group); `SPAWN_TIMEOUT_MS`, `TSC_SPAWN_TIMEOUT_MS`, `NPX_SPAWN_TIMEOUT_MS`, `CARGO_SPAWN_TIMEOUT_MS`.

## Approach

Make the lint path async: spawn children with `child_process.spawn` (`detached: true`, own process group), same timeouts and maxBuffer, `Promise.all` over chain and tsc; on timeout `process.kill(-pid, "SIGTERM")`, escalate to SIGKILL. Decide tsc eligibility up front; if oxlint was expected but did not run, start tsc afterwards (only that rare case stays sequential). The skill driver must follow (async `lintFileHandler` or a sync wrapper). Re-derive the timeout budget: nominal worst case max(chain, tsc) instead of the sum (F29). `timeout`/`setsid` wrappers are not portable (no `timeout` on stock macOS).

## Verification

Spawn log shows chain and tsc starting within a few ms. tsc.test.mts and oxlint.test.mts (typeCheck skip, oxlint-unavailable-keeps-tsc) green. New test with an in-process timeout seam (dprint F28's `timeoutMs` precedent, no production env var): a stub that forks `sleep` exceeds the timeout → `{}` and no surviving sleep pid.

## Constraints

rtk-then-direct fallback and every classification unchanged; fail open (timeout = skip). Two heavy children at once: fine on 12 cores, note it for small machines. No new production env override. Version bump.

## Related

F13 (dedup for bursts), F29 (budget), F30 (cold Rust leaf), F27.
