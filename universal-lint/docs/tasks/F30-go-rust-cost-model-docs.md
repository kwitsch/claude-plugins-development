---
id: F30
title: Document the Go/Rust cost model (scope, cold caches, bursts)
status: done
priority: low
area: universal-lint/.claude/rules/languages.md (Rust, Go), universal-lint/src/hooks/lint-file.mts (CARGO_SPAWN_TIMEOUT_MS, resolveCargoManifest, REGISTRY.go)
---

## Status

Closed docs-only in 0.15.27. bench-other-langs finding (adjusted, low); the verifier corrected the cold-leaf statement (exceeded, not "just under") and did not reproduce the burst-gap percentages. languages.md now has the Rust scope, warm cost, concurrency and burst bullets and a new Go section. Claims reconciled against the 0.15.26 code:

1. Burst: "N edits run N full invocations" holds only for PostToolUse `Write`/`Edit` (no debounce, user decision). FileChanged coalesces per package or `Cargo.toml` key through `coalesceProjectCheck` (F13).
2. With golangci-lint on `PATH`, `go vet` never runs (`selectLintTool` takes the first chain tool). The Go figures were taken with golangci-lint absent (a stub in the analysis), so they are `go vet` timings; a golangci-lint run is unmeasured.
3. The cold leaf-crate loss is documented by F29 and the gccgo PATH scan by F28 (measured about 95 ms, not "about 100"). languages.md restates both figures with that provenance: the cold leaf in the Rust `CARGO_SPAWN_TIMEOUT_MS` bullet, the gccgo scan in the Go cost bullet.
4. Dependents are not checked: confirmed in `buildArgv` (`--manifest-path`, no `-p`/`--workspace`). The lock serialization is cargo's own build-directory lock; the hook adds only a per-`Cargo.toml` lock, and only under FileChanged.
5. Not re-measured. Every number is from the 0.14.0 analysis of 2026-11-07 (one machine under load); the session-share percentages are dropped because they are method-dependent.

## Problem

languages.md says "warm/incremental runs are fast" and "a cold first build may exceed it" with no numbers. Undocumented: a leaf-crate edit after a core edit re-checks the dependent chain while blocking on the target-dir lock; a burst of N edits in one crate/package runs N full cargo/go invocations (cargo serializes on the lock, go vets the same package N times); `--manifest-path` checks only the edited crate and its deps, not its dependents.

## Evidence

- Rust (8-crate real workspace copy): warm no-change hook 185-329 ms (direct clippy 130-307); leaf edit 770-925 ms; core lib.rs edit 630-712 ms median, 4880 ms max (first edit invalidating dependents); core + leaf concurrent 0.79 s and 2.5-2.7 s; burst of 4 in one crate 910-985 ms each; check/clippy alternation thrashes once (3.9 s, then 0.4 s). Cold core 6.8 s; cold leaf 45,068 ms (timed out, see F29).
- Go (14.6k-line module): warm 495-546 ms (go vet 338-381), cold GOCACHE 8.7-9.4 s, 4 concurrent same-package edits 690-790 ms each. About 100 ms of each go vet is its own gccgo PATH scan on WSL (F28).
- Sessions: .rs 53-104 edits, .go 9. Share of consecutive same-extension edits under 3 s is method-dependent (finder 59% .rs, verifier 25% per transcript file); cite only with the method.

## Code locations

`CARGO_SPAWN_TIMEOUT_MS`, `resolveCargoManifest`, `REGISTRY.go` (`targetsDir`), `runChainLint`.

## Approach

Add the numbers and scope semantics to languages.md (Rust: per-crate check, dependents not checked, lock serialization, cold-leaf loss; Go: package scope, cold cache, gccgo scan). No code change; no-debounce stands.

## Verification

Docs review; numbers reproducible with F01's harness on a Rust workspace and a Go module.

## Constraints

No debounce (user decision). languages.md under 40,000 characters.

## Related

F13 (burst dedup), F18 (orphans on timeout), F28 (gccgo), F29.
