---
id: F29
title: Timeout budget doc misses the cold Rust leaf crate and SessionStart on 9P
status: done
priority: low
area: universal-lint/.claude/rules/hook-design.md (Timeout budget), universal-lint/.claude/rules/languages.md (Rust), universal-lint/src/hooks/lint-file.mts (NPX_SPAWN_TIMEOUT_MS TSDoc)
---

# F29 Timeout budget doc corrections

## Status

Closed docs-only in 0.15.26. Each of the four original claims was checked against the 0.15.25 code and rules:

1. rtk probe term: obsolete (rtk support removed in 0.15.0; no `RTK_*` constant or rtk helper is left in code or rules).
2. SessionStart on 9P: the hook-design.md sentence holds (re-measured 2026-11-10, see "Measured"); hook-design.md is unchanged.
3. Cold Rust leaf crate: languages.md "Rust" updated with the observed loss.
4. NPX TSDoc: the `NPX_SPAWN_TIMEOUT_MS` TSDoc corrected (comment-only).

Merges static timeout-budget finding (adjusted, low), the watch-filechanged missed item (SessionStart budget line wrong on 9P) and the cold-leaf part of the bench-other-langs missed items. F18 (0.15.15) re-derived the budget in hook-design.md: max of the overlapped phases plus 1 s kill grace, the sum only on the oxlint-`typeCheck` fallback; FileChanged worst ends 86-87 s.

## Problem

- Obsolete: rtk support removed in 0.15.0 (the probe term and the rtk doubling no longer exist in the budget).
- SessionStart on 9P (from the 0.14.0 analysis (2026-11-07), before F12): "git 10 s plus one realpath per listed file, inside the 30 s hook timeout" measured about 8-14 ms per listed file on 9P. F12 (0.15.11) replaced the per-file work with an extension filter, one `lstat` per lintable listed file and one realpath per distinct directory; the sentence in hook-design.md describes that and holds.
- Rust (from the 0.14.0 analysis (2026-11-07)): "a cold first build may exceed it" understated it: the first leaf-crate lint after a fresh clone or `cargo clean` timed out.

## Evidence

From the 0.14.0 analysis (2026-11-07): SessionStart blocky-dev (9P, 266 listed) 2320-2711 ms (superseded: F12 measured 2190 -> 801 ms). Cold leaf crate through the hook: 45,068 ms vs `CARGO_SPAWN_TIMEOUT_MS` 45,000, killed and silently skipped; next run 13,664 ms; cold core crate 6.8 s. A timeout is `status === null`: `chainOutcome` returns null on `signal` and `classifyExit` returns "skip", so `runChainLint` returns without trying a second chain entry (no `cargo check` retry) and that edit's clippy finding is lost.

## Measured (0.15.25 build, 2026-11-10)

Built `plugin/` of 0.15.25, WSL2 6.18.33.2, node v24. Harness (scratchpad only, not committed): `node <scratchpad>/ss-time.mjs universal-lint/plugin/hooks/lint-file.mjs /mnt/c/repos/<repo> 5`, which spawns `node plugin/hooks/lint-file.mjs` with stdin `{"hook_event_name":"SessionStart","cwd":"<repo>"}` and a fresh `CLAUDE_PLUGIN_DATA`, 5 runs each, wall ms. Raw output saved as `perf-F29-ss-9p-0.15.25.txt` in the build-task scratchpad.

| Repo (9P, /mnt/c/repos) | git ls-files | watchPaths | runs ms             | median |
| ----------------------- | -----------: | ---------: | ------------------- | -----: |
| blocky-dev              |          266 |        242 | 842 852 861 863 875 |    861 |
| claude-plugins          |           77 |         53 | 471 475 476 480 484 |    476 |
| copilot-qa-suite        |           44 |         21 | 676 676 681 686 689 |    681 |

Derivation: (861 - 476) / (242 - 53) = about 2.0 ms per watched file on 9P (copilot-qa-suite's higher floor is per-repo git cost, not per-file). Worst case: 5000 lintable files (`WATCH_LIMIT`) x about 2 ms = about 10 s, plus `GIT_TIMEOUT_MS` 10 s, plus the hook floor, about 20 s, inside the 30 s hook timeout. This is an extrapolation from 21-242 watched files, not a measured 5000-file 9P run; per-file cost on 9P varies with Windows-side load.

## Code locations

Constants `SPAWN_TIMEOUT_MS`, `NPX_SPAWN_TIMEOUT_MS`, `TSC_SPAWN_TIMEOUT_MS`, `CARGO_SPAWN_TIMEOUT_MS`, `GIT_TIMEOUT_MS`, `KILL_GRACE_MS`; `watchList`; `classifyExit` (null status -> skip); `chainOutcome`; `runChainLint`; `planChainLint`; `runNpx` (passes `NPX_SPAWN_TIMEOUT_MS` for the npx-cached bin and for bare `npx --yes`).

## Approach

Done: languages.md "Rust" last bullet names the cold leaf-crate loss and the fail-open mechanism; the `NPX_SPAWN_TIMEOUT_MS` TSDoc now covers the npx-cached bin and the npx-route combinations past 90 s (hook-design.md "Timeout budget", Accepted). hook-design.md is not edited and stays 39,305 bytes by `wc -c` (the 0.15.8 "Measured cost" table stays; refreshing it is F01's business). A first-run budget or warmup for cargo, and a watchList time budget, are possible code follow-ups (not part of this task).

## Verification

- `wc -c universal-lint/.claude/rules/hook-design.md` -> 39305; `git diff --quiet 63c2597 HEAD -- universal-lint/.claude/rules/hook-design.md` exits 0.
- `grep -n '45,068' universal-lint/.claude/rules/languages.md` -> 1 match in the Rust section; `wc -c` of languages.md under 40,000.
- `grep -n 'npx-cached' universal-lint/src/hooks/lint-file.mts` shows the new TSDoc; `const NPX_SPAWN_TIMEOUT_MS = 55000;` unchanged.
- `pnpm --filter universal-lint build`, `pnpm lint`, `pnpm --filter universal-lint test`, `claude plugin validate universal-lint/plugin` pass.

## Constraints

Documentation plus one comment-only TSDoc change. hook-design.md under 40,000 characters (unchanged).

## Related

F12, F17, F18, F10, F13, F30.
