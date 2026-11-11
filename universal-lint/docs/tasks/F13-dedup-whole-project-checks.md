---
id: F13
title: Run tsc / go vet / cargo once per FileChanged burst, not once per file
status: done
priority: medium
area: universal-lint/src/hooks/lint-file.mts (coalesceProjectCheck, runTypeCheck, runChainLint, lintResolved, slotStale, FILE_CHANGED_BUDGET_MS), universal-lint/.claude/rules/hook-design.md
---

## Status

Done in 0.15.12. Shipped: `coalesceProjectCheck` wraps the whole-project spawn (`tsc -p` in `runTypeCheck`; `go vet`/`golangci-lint run <dir>` and `cargo check`/`cargo clippy --manifest-path` in `runChainLint`) for FileChanged only (`lintResolved` passes `coalesce = hookEventName === "FileChanged"`). State under `${CLAUDE_PLUGIN_DATA || os.tmpdir()}/fc-locks/`: `<key>.lock` (F10's `wx` + pid claim, `slotStale` reclaim) and `<key>.last` (`Date.now()` taken before the spawn of the last run that completed without error or signal), key = `hashPath` of `<tool name>:<tsconfig path | package dir | Cargo.toml path>`. See hook-design.md "Project-check lock".

Measured (manual burst, harness and counting `tsc`/`go`/`cargo` wrappers in the session scratchpad; baseline = committed `plugin/hooks/lint-file.mjs` of e840434 (0.15.11) copied with `git show`, vs 0.15.12; 2026-11-08, Linux 6.18.33.2-microsoft-standard-WSL2, 12 cores, 9 GB RAM, node v24.22.2, tsc 7.0.2, go 1.22.2, cargo 1.97.1 / clippy 0.1.97; medians of 3 runs after one N=1 warm-up per version and case; fresh `CLAUDE_PLUGIN_DATA` per run; every file written before the hooks fire):

- ts200 N=50: baseline 50 `tsc` spawns, wall 3418 ms; 0.15.12 1 `tsc`, wall 822 ms; exit 2 / exit 0 / killed 1 / 49 / 0.
- go20 N=20: baseline 20 `go vet` spawns, wall 1675 ms; 0.15.12 1 `go vet`, wall 460 ms; exit 2 / exit 0 / killed 1 / 19 / 0.
- rs20 N=20: baseline 20 `cargo clippy` spawns, wall 970 ms; 0.15.12 1 `cargo clippy`, wall 358 ms; exit 2 / exit 0 / killed 1 / 19 / 0.

Acceptance (<= 2 spawns per burst, baseline N; none killed; wall not above baseline): met.

Originally: watch-filechanged finding (adjusted: high → medium; payoff small on native TS 7) merged with part (2) of the bench-js-ts tsc finding (lock per tsconfig for overlapping lints, adjusted medium, parallel CPU not re-measured).

## Problem

`tsc -p`, `go vet <dir>` and `cargo clippy --manifest-path` check the whole project/package/crate, yet every FileChanged process runs its own copy: N changed files in one project give N identical checks. Concurrent tsc runs share one `--tsBuildInfoFile`; concurrent cargo runs block on cargo's build-directory lock. A run that starts after file X changed already covers X.

## Evidence

- Burst N=50 on ts200: 50 `tsc --noEmit --incremental` on one tsconfig (peak 6 concurrent); each warm run 0.10-0.12 s / 51-61 MB on native tsc 7.0.2. Verifier N=30: 30 tsc spawns, about 3 s of 61 s burst CPU (most cost is npx/eslint startup). Traced N=200: one tsc took up to 1270 s under contention.
- rs20: 20 cargo clippy runs on one crate (88-235 ms each), 64 processes, 1.8 GB. go20: 20 go vet runs on one package (447-621 ms each), 10.5 s CPU instead of about 0.5 s. Go 4 concurrent same-package edits 690-790 ms each; Rust burst of 4 in one crate 910-985 ms each.
- 5 parallel ts1000 Edits (PostToolUse): wall 2.5-4.0 s, CPU 15.6-17.6 s (single 1.4 s / 2.6 s CPU).
- Real session: 20 changed .ts files gave about 22 tsc processes.

## Code locations

`coalesceProjectCheck` (new); `runTypeCheck` (tsconfig from `resolveTsconfig`, key `tsc:<tsconfig path>`); `runChainLint` (`targetsDir` tools → key `<tool>:<package dir>`, `manifestPath` → key `<tool>:<Cargo.toml>` from `resolveCargoManifest`); `lintResolved` (derives `coalesce`); `slotStale` (reused for the lock); `FILE_CHANGED_BUDGET_MS`; `fileChangedHandler` (unchanged code).

## Approach

FileChanged only: `lintResolved` sets `coalesce = hookEventName === "FileChanged"`; PostToolUse Write/Edit and the skill driver never touch `fc-locks` (no-debounce decision 2026-11-06; `gateFinding`'s Edit-range contract needs every Edit's own tsc). `coalesceProjectCheck(key, file, reserveMs, run)` takes `changed = statSync(file).ctimeMs` (ctime, not mtime: `cp -p`/`rsync -t`/`touch -d` keep an old mtime; `statSync`, not `lstatSync`: a symlink's target is what the check reads) right before the first `.last` read. Covered iff `Number(.last) > changed && Number(.last) <= Date.now()` (strict; NaN/empty/future-dated = not covered): skip, return null, no finding (the process that ran the check reported). Otherwise claim `<key>.lock` (`wx` + pid, stale per `slotStale`); while a live process holds it, re-check `covered` every 100 ms (`Atomics.wait`) until process uptime reaches `FILE_CHANGED_BUDGET_MS` (85 s) minus `reserveMs` (the check's spawn timeout: `.ts` and `.rs` 45 s → lock wait ends at 40 s, `.go` 30 s → 55 s), then run unlocked (never skip). After a successful claim re-check `covered` once more (the holder may have finished between the last check and the claim). Holding the lock: `start = Date.now()`, run, write `.last` = `start` (plain `writeFileSync`) only after a run with no error and no signal, release in `finally`. The lock is taken after the F10 slot (the slot stays held while waiting) and held at most one check timeout (45 s) < `slotStale`'s 90 s rule. Any stat, mkdir, claim or `.last` error runs the check unlocked (fail open, as before F13). File-scoped chain tools (eslint, oxlint, shellcheck, ...) are never coalesced; for TS the per-file chain lint still runs. No dirty flag, no holder re-run, no second budget reservation, no new timeout constant, no stderr note on a skip.

Why one run per burst: Claude Code fires FileChanged after the files changed, so when a burst's writes landed before the first run started every file's ctime precedes the holder's `start`; every other process, waiting on the lock or arriving later, sees `.last > changed` and skips. A file changed during or after a run (ctime > start) runs again, serialised by the lock; a burst whose writes spread over longer than one check gives about 1 + span/duration runs.

Budget (<= `FILE_CHANGED_BUDGET_MS` = 85 s by construction): git <= 10 s + slot wait (ends at uptime 85 s − lint budget) + TS chain <= 30 s + lock wait (ends at uptime 85 s − `reserveMs`) + check <= `reserveMs`. `.ts`: slot by 10 s + chain 30 s = 40 s = lock deadline, tsc 45 s → 85 s; `.rs`: slot by 40 s = lock deadline, cargo 45 s → 85 s; `.go`: slot by 55 s = lock deadline, go vet 30 s → 85 s.

Residuals (hook-design.md "Project-check lock"): WSL drvfs/9P clock skew between ctime and `Date.now()` can cover a file too early (lost finding) or too late (one extra run); the coarse kernel timestamp clock can lag `Date.now()` by up to one tick for a write landing in the first ms of a run; a holder killed between its `.last` write and its stderr/additionalContext output loses that burst's report (waiters already skipped); the report target is the tsconfig dir / package / crate, not the waiter's file; shared data dir and pid namespaces as for the slot cap; `.last` files are never cleaned up (one tiny file per project key); the F10 stale-reclaim race (slotStale, rmSync, wx create are not one atomic step) lets two processes both claim a dead holder's lock: both run, both write .last, one extra run and the already-accepted buildinfo interleave (typescript-check.md), never a wrong result; a completed run whose verdict was skip or a config failure (any exit status, no error/signal) still writes .last and covers the burst: every waiter runs the same whole-project command and would get the same verdict, so N identical failing runs are the waste F13 removes; a run that errored, timed out or was killed writes no stamp and the next process runs again.

## Verification

Vitest (`tests/file-detection.test.mts`): 10 concurrent FileChanged `.ts` events whose writes landed before the first run, stub tsc sleeping 1000 ms with one injected finding: exactly 1 call, the finding reported by exactly one process (exit 2), the other nine exit 0 with empty stderr; 5 `.go` events: exactly 1 `go vet` call; 5 `.rs` events: exactly 1 `cargo check` call; a write after the last completed run: one more call, and a newer non-future stamp covers the next change; an unusable `fc-locks` dir runs tsc unlocked. Unit tests of `coalesceProjectCheck` (`tests/registry.test.mts`): covered skip, stamp + release, errored run (no stamp), stale-lock reclaim, deadline runs unlocked. Manual burst (Status): ts200 N=50 and go20/rs20 N=20, <= 2 spawns per burst (measured above), assuming the writes landed before the first run.

## Constraints

User decision 2026-11-08 (q1 (a)): per-project lock + last-completed-run stamp, FileChanged only; the dirty-flag + holder re-run variant (q1 (b)) and no coalescing (q1 (c)) were rejected. Binding conditions: `coalesce` derived from `hookEventName` in `lintResolved`; ctime taken inside the helper, strict `>` plus the future-stamp guard; `.last` only after a run without error/signal; fail open on every error, deadline runs unlocked; lock after the F10 slot, `reserveMs` = the check's spawn timeout, no new timeout constant, `slotStale` unchanged; no dirty flag, no re-run, no stderr note on skip. hook-design.md names F13 as the FileChanged-only dedup exception next to F10 in the No-debounce bullet (not a debounce: the first event runs immediately, nothing waits for more events). Zero-dependency; TSDoc; version bump to 0.15.12.

## Related

F10 (done first; bounds the peak), F18 (overlap for single PostToolUse lints), F16 (same dedup idea in the driver), F30 (Go/Rust cost model), F29 (budget text).
