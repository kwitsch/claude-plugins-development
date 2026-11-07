---
id: F17
title: Persist rtk rewrite probe results across hook processes
status: open
priority: low
area: universal-lint/src/hooks/lint-file.mts (getRtkPrefix, rtkPrefixCache, parseRtkPrefix, runLintTool, RTK_PROBE_TIMEOUT_MS), universal-lint/.claude/rules/hook-design.md
---

# F17 Persist rtk rewrite probe results across hook processes

## Status

Open. Merges the rtk-probe findings of four dimensions (bench-js-ts adjusted medium; bench-other-langs, watch-filechanged, static: low). Priority low: 40-100 ms in a background hook of 0.8-1.6 s, only with rtk on PATH; it rises to about 25% of a TS edit once F03 removes the eslint waste.

## Problem

`rtkPrefixCache` is per process, every event is a process, so each lint spawns `rtk rewrite <tool> <static args> __RTK_PROBE__` again; TS files pay it twice (chain tool + tsc). For tools without an rtk verb (markdownlint-cli2, stylelint) the probe always answers empty: pure waste on every edit. A FileChanged burst multiplies the probes and load slows them.

## Evidence

- Probe medians (N=7): eslint 37-52 ms, tsc 40-47, shellcheck 55, markdownlint-cli2 38-48 (exit 1, empty stdout), oxlint with `-c` args 18-30, go vet 38-43 (exit 3, stdout `rtk go vet __RTK_PROBE__`), stylelint 23. Independent of PATH.
- A TS edit pays about 80-100 ms of probes.
- FileChanged bursts: N=10 → 20 probes (p50 90 ms, max 121); N=30 → 60; traced N=50 → 100 probes, p50 147 ms, max 655 ms.

## Code locations

`getRtkPrefix` (spawnSync `rtk rewrite …` with `RTK_PROBE_TIMEOUT_MS`), `rtkPrefixCache` (per-process Map; "server-lifetime" comment fixed in F11), `parseRtkPrefix`, `runLintTool` (both branches), `runTypeCheck` via `runLintTool`.

## Approach

Store `{ "<tool.name> <static args without the per-project -c pair>": prefix | null }` in the F11 cache file (or `rtk-probe.json` next to it), keyed additionally by the resolved rtk binary's path + mtime + size, so an rtk upgrade re-discovers filters (keeps hook-design.md's "discovered, not hardcoded" rule). Keep not caching transient probe failures (timeout/signal). Write atomically; corrupt file = probe again. Reword hook-design.md "discovered per hook process".

## Verification

Trace: no `rtk rewrite` spawn after the first run; burst N=50: ≤ 2 probes instead of 100. Unit test: cache hit skips the rtk stub's rewrite call; touching the stub (new mtime) re-probes; a probe timeout is not cached.

## Constraints

Upgrading rtk must invalidate. Fail open. Version bump.

## Related

F11 (shared cache file; do first), F31 (rtk wrapper cost itself), F29 (probe term in the timeout budget).
