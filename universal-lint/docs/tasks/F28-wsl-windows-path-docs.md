---
id: F28
title: Document the WSL Windows-PATH penalty (mostly inside child processes)
status: done
priority: medium
area: universal-lint/plugin/README.md (troubleshooting), universal-lint/.claude/rules/hook-design.md
---

## Status

Closed docs-only in 0.15.25, no code change. Shipped: a "Troubleshooting" section ("Slow lints on WSL") at the end of `plugin/README.md` (cause, the `go vet` example, the two user options `appendWindowsPath = false` in `/etc/wsl.conf` or a `/mnt`-trimmed PATH for Claude Code, and the statement that the plugin never rewrites PATH), and one sentence on the "Selection (`selectLintTool`)" bullet of `.claude/rules/hook-design.md`. The re-measurement on 0.15.25 (Evidence) refutes this task's original premise that a trimmed PATH speeds up every lint by 0.1-0.6 s: after rtk's removal (0.15.0), the direct local and npx-cached bins (F04, F09) and the persisted `onPath` probes (F11), the hook itself shows no real-vs-/mnt gap in the direction a /mnt penalty would cause (largest median difference 15 ms, and there the real PATH is the faster one). The remaining WSL cost is inside child processes that search PATH themselves; `go vet` is the one measured example.

GCCGO env on the go vet spawn: not pursued (user decision). The cost stays at about 95 ms per `go vet` run on WSL (go 1.22.2, one-file package). Reasons: Go's `work` package `init()` runs `LookPath` on `GCCGO` (or `gccgo`) on every go command (`go vet`, and `go list` under golangci-lint too) regardless of `-compiler`; an OS env `GCCGO` overrides a user's `go env -w GCCGO=...` (`cfg.Getenv` reads `os.Getenv` first, then the GOENV file; verified empirically), so an unconditional spawn-env override breaks gccgo users with exit 2 on every edit, unless the hook spawns `go env` first, which costs more than it saves. The benefit is WSL-only and gccgo-absent-only (9 `.go` edits in the mined transcripts); the README's `appendWindowsPath = false` fix removes the cost for every child process at once; and the plugin does not rewrite tool-resolution env (this task's PATH stance; F24 set only output-noise npm flags).

Reopen trigger: only if Go edits become a measured budget problem on WSL AND the hook can read `GCCGO`/`GOFLAGS` from `go env` (or the GOENV file) without an extra spawn per run. No follow-up task.

User-side Go workaround (this doc only, not the README): a user who never uses gccgo can run `go env -w GCCGO=/nonexistent/gccgo` once; go then checks that one absolute path instead of scanning PATH for `gccgo`.

## Problem

On WSL with `appendWindowsPath` (the default), PATH carries the Windows dirs under /mnt (9P, slow lookups); on the measuring machine 44 of 63 dirs. Every PATH lookup that misses scans all of them. The plugin's own `onPath` misses are cached across hook processes since F11; tools that search PATH themselves inside child processes (`go vet` looking for `gccgo`) pay on every run, which no plugin-side cache can remove.

## Evidence

Measured 2026-11-10 on 0.15.25, WSL2, probe cache warm.

- `node universal-lint/scripts/perf.mts 5` header: `universal-lint 0.15.25 perf, 2026-11-10T22:29:36.031Z, 6.18.33.2-microsoft-standard-WSL2, 12 cores, 9.5 GB RAM, node v24.22.2, tsc 7.0.2, linters found (of shellcheck/ruff/yamllint/markdownlint-cli2/eslint/oxlint/stylelint): real PATH none; no /mnt none, local oxlint yes, PATH 63 dirs (44 on /mnt), load 1.12 -> 1.37, runs 5 (+1 warm-up)`
- Medians real PATH vs no /mnt (ms), 16 rows: floor node -e 0 26 vs 26; empty payload 44 vs 42; out-of-scope .json Write 39 vs 44; .sh Write 49 vs 49; .py Write 49 vs 48; .yml Write 48 vs 48; .md Write 291 vs 306; .css Write (no stylelint config) 49 vs 47; .ts Write (no eslint config) 150 vs 148; .ts Edit (no eslint config) 152 vs 147; .mts Write (this repo) 275 vs 287; FileChanged tracked unchanged 54 vs 52; FileChanged ignored 52 vs 51; FileChanged unlink 41 vs 41; SessionStart fixture 47 vs 47; SessionStart this repo 57 vs 56.
- Largest median difference 15 ms (.md Write; ranges real 288-295, no /mnt 294-310): the real PATH is the faster one, the opposite of a /mnt penalty, so this is run order or load noise, not a hook-side cost (5 runs, ranges barely overlap, so not proof of equality either); the >50 ms investigate guard (real slower than no /mnt) is not tripped.
- `go vet`: go 1.22.2 (`/usr/bin/go`, `gccgo` not on PATH), module = `go.mod` + one-file `package main`, command `go -C <module dir> vet ./...` after one warm-up run, 3 runs per mode: real PATH 169, 169, 176 ms (about 170); real PATH + `GCCGO=/nonexistent/gccgo` 73, 70, 75 ms (about 75); `PATH=/usr/bin:/bin` 73, 72, 76 ms (about 75). Gap about 95 ms per run; GCCGO set and the minimal PATH give about the same time, so the cost is the gccgo PATH scan.
- Caveats: probe cache warm (a cold probe pays once per 10 min miss TTL, F11); go 1.22.2 and one trivial package only, vet cache state not forced or verified; perf.mts has no Go row (the go numbers are a separate run); numbers are machine- and load-dependent (about +/-15%); a machine without /mnt dirs on PATH gets a single perf column.

## Code locations

None in code. Related symbols for context: `onPath`, `runLintTool`, `REGISTRY.go`.

## Approach

Superseded by Status: the original "trimmed PATH speeds up every lint by 0.1-0.6 s" premise and the GCCGO follow-up were dropped; see Status and Evidence.

## Verification

Docs review. Re-measure with `pnpm --filter universal-lint build`, then `node universal-lint/scripts/perf.mts 5` (real vs /mnt-trimmed PATH) and the `go vet` loop described in Evidence. Checks: `wc -c universal-lint/.claude/rules/hook-design.md` below 40000; the README section names `appendWindowsPath = false`, `wsl --shutdown` and the trimmed-PATH one-liner and contains no `GCCGO` and no hook-side figure; `pnpm --filter universal-lint test` and `claude plugin validate universal-lint/plugin` pass.

## Constraints

No PATH rewriting by default (skipping /mnt/* dirs could hide intentionally installed Windows tools). Keep README user-facing and short.

## Related

F11 (plugin-side part), F04, F09, F30 (Go), F01.
