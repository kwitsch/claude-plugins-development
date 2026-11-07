---
id: F28
title: Document the WSL Windows-PATH penalty (mostly inside child processes)
status: docs-only
priority: medium
area: universal-lint/plugin/README.md (troubleshooting), universal-lint/.claude/rules/hook-design.md
---

# F28 Document the WSL Windows-PATH penalty

## Status

Docs-only, open. Merges the static missed item and the real-sessions missed item (both: most of the real-vs-Linux-PATH gap is outside the plugin's `onPath`), plus the bench-other-langs missed item on `go vet`'s gccgo PATH scan as an optional mitigation.

## Problem

On WSL with `appendWindowsPath` (default), PATH carries the Windows dirs on /mnt/c (9P). Every PATH lookup that misses scans them at about 1.5-2 ms per dir. The plugin's own `onPath` misses explain only part of the cost; npx, npm, rtk and go scan PATH themselves inside the child processes, which no plugin-side cache (F11) can remove.

## Evidence

Real vs Linux-only PATH, end to end: .mts 890-1026 vs 575-621 ms (onPath ≈ 110 ms of the gap), .md 1364-1644 vs 1038-1077 ms (onPath ≈ 180-215 ms), .ts with eslint+tsc 985 vs 659 ms. `rtk oxlint` 241-257 ms vs 59-72 ms (rtk searching PATH for oxlint). `go vet` scans PATH for gccgo on every run: small package 210 ms vs 106-114 ms with a gccgo stub early on PATH or `GCCGO=/nonexistent/gccgo`; 337 → 244 ms on a bigger package; this explains most of Go's 495 vs 255 ms gap. Running Claude processes have 61-63 PATH dirs, 44 of them /mnt/*; hooks inherit it.

## Code locations

None in code. Related symbols for context: `onPath`, `runLintTool`, `REGISTRY.go`.

## Approach

Add a short troubleshooting note to plugin/README.md: on WSL, `[interop] appendWindowsPath=false` in `/etc/wsl.conf` (or a trimmed PATH for Claude Code) speeds up every lint by 0.1-0.6 s; give the measured numbers. Mention in hook-design.md that the plugin cannot rewrite PATH (it would change which tools are found). Optional code follow-up (decide separately, low): set `GCCGO` to an absolute non-existent path in the go vet spawn env when unset (9 .go edits in transcripts).

## Verification

Docs review; the numbers reproduce with F01's harness (real vs /mnt-trimmed PATH).

## Constraints

No PATH rewriting by default (skipping /mnt/* dirs could hide intentionally installed Windows tools). Keep README user-facing and short.

## Related

F11 (plugin-side part), F04, F30 (Go), F01.
