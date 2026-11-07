---
id: F11
title: Persist onPath probe results across hook processes
status: open
priority: medium
area: universal-lint/src/hooks/lint-file.mts (onPath, probeCache, isToolAvailable, selectLintTool, runLintTool, runTypeCheck)
---

# F11 Persist onPath probe results across hook processes

## Status

Open. Merges the PATH-probe findings of all four measuring dimensions (bench-js-ts, bench-other-langs, real-sessions, static; each adjusted from high to medium) and the verifier missed item that the stale "server-lifetime" doc comments belong here. Setup-specific (WSL `appendWindowsPath`); the lints run in the background (asyncRewake), so the cost delays the rewake and burns CPU but does not block the agent.

## Problem

`onPath` does one `accessSync` per PATH directory and caches in `probeCache`, which lives for one process; every hook event is a new process, so each lint re-probes. On this WSL2 machine 44 of 63 PATH dirs are on /mnt/c (9P), and a miss costs about 90-107 ms. Most chains miss at least one tool: markdown (markdownlint-cli2 + markdownlint) and PHP (phpstan + psalm) miss two, Go (golangci-lint), YAML, Java, Kotlin, CSS, sh, py one each, plus the npx routes. The doc comments on `probeCache` and `rtkPrefixCache` still say "server-lifetime" (MCP-server leftover), which is wrong for command hooks.

## Evidence

- onPath miss: 86-107 ms real PATH (63 accessSync), 0.1-0.6 ms without /mnt; hit 0.02-0.2 ms. Repeated probes are not cached by the OS.
- Hook medians, real vs no-/mnt PATH (N=7-9): .sh 143-151/43-44, .py 133-152/42-45, .yml 153-215/43-70, .java 193/63, .kt 178/73, .php 266/53, .md 1113-1364/930-1077 (two misses ≈ 215 ms).
- Not all of the gap is onPath: .mts 890-1026 vs 575-621 ms, but only about 110 ms is onPath; `rtk oxlint` costs 241-257 ms vs 59-72 ms because rtk scans PATH itself (F28). Go's gap is about half `go vet`'s own gccgo PATH scan (F30).
- Probing all chain names in one parallel async pass: 45-60 ms total.

## Code locations

`onPath` (accessSync loop over `process.env.PATH`), `probeCache` (per-process Map, stale "server-lifetime" comment), `isToolAvailable`, `selectLintTool` (probes every chain entry, then npx), `runLintTool` (`onPath(tool.name)`, `onPath("rtk")`), `runTypeCheck` (`onPath("tsc")`), `rtkPrefixCache` comment.

## Approach

Persist `{ tool: absoluteDir | null }` in `${CLAUDE_PLUGIN_DATA || tmpdir()}/probe-<hashPath(PATH)>.json`: read once per process, write back (temp + `renameSync`) after a fresh probe. Negative entries get a short TTL (e.g. 10 min) so a newly installed linter appears within it; positive entries are re-validated with one `accessSync` on the cached absolute path. A PATH change changes the file name. Unreadable/corrupt file = probe again. Fix both "server-lifetime" comments. Cheaper non-persistent alternative if state is unwanted: one readdir per PATH dir, or a single parallel async probe pass (needs async `main`). Document the TTL in hook-design.md.

## Verification

Bench with the real PATH: .sh/.yml/.py second and later runs about 45 ms (from 140-215), .md about 180 ms faster. Unit tests: a cache hit makes no accessSync over PATH (logging PATH dir); a PATH change invalidates; a stub tool added after a negative entry is found after the TTL.

## Constraints

First-on-PATH-wins semantics unchanged. No `userConfig`. Writes only under CLAUDE_PLUGIN_DATA/tmpdir, never the project. Fail open. Version bump.

## Related

F17 (rtk probe; share the file), F09 option 2 (cached npx bin path in the same file), F28 (the larger WSL cost outside the plugin), F04 (not additive), F27.
