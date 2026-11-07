---
id: F29
title: Timeout budget doc misses the cold Rust leaf crate and SessionStart on 9P
status: docs-only
priority: low
area: universal-lint/.claude/rules/hook-design.md (Timeout budget), universal-lint/src/hooks/lint-file.mts (RTK_PROBE_TIMEOUT_MS, NPX_SPAWN_TIMEOUT_MS TSDoc)
---

# F29 Timeout budget doc corrections

## Status

The rtk terms are gone since 0.15.0 (rtk removed, budget re-derived in hook-design.md). The cold Rust leaf crate and SessionStart-on-9P items remain.

Docs-only, open. Merges static timeout-budget finding (adjusted, low), the watch-filechanged missed item (SessionStart budget line wrong on 9P) and the cold-leaf part of the bench-other-langs missed items. Re-derive again after F10, F13, F17 or F18 change the budget.

## Problem

hook-design.md's "Timeout budget" derives worst cases from the SPAWN/TSC/NPX constants and rtk-then-direct doubling, but:

- each phase can spend `RTK_PROBE_TIMEOUT_MS` (5 s) on `rtk rewrite` first. A probe that times out returns null and skips the rtk attempt (probe 5 s + direct 30 s = 35 s), so probe timeout and rtk doubling are mutually exclusive per phase; the theoretical upper bound with every probe finishing just under 5 s is 5+30+30+5+45+45 = 160 s for an on-PATH TS lint, and 5+5+55 = 65 s for the npx chain (doc says 60 s).
- "SessionStart/CwdChanged: git 10 s plus one realpath per listed file, inside the 30 s hook timeout" does not hold on 9P: about 8-14 ms per listed file (F12).
- Rust: "a cold first build may exceed it" understates it: the first leaf-crate lint after a fresh clone or `cargo clean` timed out.

## Evidence

Normal probes 18-55 ms. SessionStart blocky-dev (9P, 266 listed) 2320-2711 ms; extrapolated 30 s at about 2,000-3,500 listed files (estimate). Cold leaf crate through the hook: 45,068 ms vs `CARGO_SPAWN_TIMEOUT_MS` 45,000 → silently skipped; next run 13,664 ms; cold core crate 6.8 s.

## Code locations

`getRtkPrefix` (`RTK_PROBE_TIMEOUT_MS`) before each `tryRtk` in `runLintTool` (also used by `runTypeCheck`); constants `RTK_NPX_ATTEMPT_TIMEOUT_MS`, `SPAWN_TIMEOUT_MS`, `NPX_SPAWN_TIMEOUT_MS`, `TSC_SPAWN_TIMEOUT_MS`, `CARGO_SPAWN_TIMEOUT_MS`, `GIT_TIMEOUT_MS`; `watchList`.

## Approach

Add the probe term with the mutual-exclusion note, the 9P per-file cost to the SessionStart line, and the cold-leaf observation (first clippy finding of a session can be lost; fail open) to hook-design.md / languages.md "Rust". Update the `NPX_SPAWN_TIMEOUT_MS` TSDoc. A separate first-run budget or warmup for cargo is a possible code follow-up (not part of this task).

## Verification

Doc review against the constants.

## Constraints

Documentation only. hook-design.md under 40,000 characters.

## Related

F12, F17, F18, F10, F13, F30.
