---
id: F13
title: Run tsc / go vet / cargo once per FileChanged burst, not once per file
status: open
priority: medium
area: universal-lint/src/hooks/lint-file.mts (runTypeCheck, runChainLint, tsBuildInfoPathFor, resolveCargoManifest, fileChangedHandler)
---

# F13 Run whole-project checks once per FileChanged burst

## Status

Open. watch-filechanged finding (adjusted: high → medium; payoff small on native TS 7) merged with part (2) of the bench-js-ts tsc finding (lock per tsconfig for overlapping lints, adjusted medium, parallel CPU not re-measured).

## Problem

`tsc -p`, `go vet <dir>` and `cargo clippy --manifest-path` check the whole project/package/crate, yet every FileChanged process runs its own copy: N changed files in one project give N identical checks. Concurrent tsc runs share one `--tsBuildInfoFile`; concurrent cargo runs block on cargo's build-directory lock. A run that starts after file X changed already covers X.

## Evidence

- Burst N=50 on ts200: 50 `tsc --noEmit --incremental` on one tsconfig (peak 6 concurrent); each warm run 0.10-0.12 s / 51-61 MB on native tsc 7.0.2. Verifier N=30: 30 tsc spawns, about 3 s of 61 s burst CPU (most cost is npx/eslint startup). Traced N=200: one tsc took up to 1270 s under contention.
- rs20: 20 cargo clippy runs on one crate (88-235 ms each), 64 processes, 1.8 GB. go20: 20 go vet runs on one package (447-621 ms each), 10.5 s CPU instead of about 0.5 s. Go 4 concurrent same-package edits 690-790 ms each; Rust burst of 4 in one crate 910-985 ms each.
- 5 parallel ts1000 Edits (PostToolUse): wall 2.5-4.0 s, CPU 15.6-17.6 s (single 1.4 s / 2.6 s CPU).
- Real session: 20 changed .ts files gave about 22 tsc processes.

## Code locations

`runTypeCheck` (tsconfig from `resolveTsconfig`, cache key from `tsBuildInfoPathFor`); `runChainLint` (`targetsDir` tools → directory target, `manifestPath` → `resolveCargoManifest`); `lintResolved`; `fileChangedHandler`.

## Approach

FileChanged only. Per project key (`hashPath` of the real tsconfig / Go package dir / Cargo.toml, like `tsBuildInfoPathFor`): try `<key>.lock` with flag `wx` (pid). If a live process holds it, touch `<key>.dirty` and skip the whole-project check. FileChanged has no range gate, so the holder's output covers this file. For TS, still run and report the chain linter (eslint/oxlint) for this file and skip only tsc. For Go (`targetsDir`) and Rust (`manifestPath`), the chain tool IS the package/crate check, so the chain run itself is skipped. The holder runs the check; afterwards, if `<key>.dirty` exists, removes it and re-runs once (skip the re-run when the remaining 90 s budget is short), then reports and releases. Stale lock: dead pid or mtime > 90 s. Must keep the documented "tsc findings in other files still exit 2". PostToolUse untouched (no debounce). Note in typescript-check.md that the buildinfo is no longer written concurrently during bursts.

## Verification

Burst N=50 modified with spawn-counting wrappers: tsc ≤ 2 (was 50); rs20/go20 N=20: cargo / go vet ≤ 2 each. Vitest: 10 concurrent FileChanged events in one stub TS project with a stub tsc that sleeps 300 ms and records calls: ≤ 2 calls, an injected tsc finding reported exactly once.

## Constraints

The dirty-flag re-run is coalescing, the mechanism the 2026-11-06 no-debounce decision removed for Write/Edit. Bringing it back for FileChanged only is an explicit trade-off: confirm with the user and say in hook-design.md that it is limited to FileChanged. Fail open on any lock error (run the check as today). Fit the 90 s budget including a possible second run. Zero-dependency; TSDoc; version bump.

## Related

F10 (do first; bounds the peak), F18 (overlap for single PostToolUse lints), F16 (same dedup idea in the driver), F30 (Go/Rust cost model), F29.
