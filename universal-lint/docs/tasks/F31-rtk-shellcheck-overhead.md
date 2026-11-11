---
id: F31
title: Measure rtk's overhead for shellcheck/ruff with the real tools
status: done
priority: low
area: universal-lint/src/hooks/lint-file.mts (runLintTool on-PATH branch, tryRtk)
---

## Status

Obsolete since universal-lint 0.15.0: rtk support was removed, so this problem no longer exists. The text below is kept as history.

Measurement-only, open. bench-js-ts finding (confirmed, low). Measured with stub linters only; rtk compaction is a deliberate feature, so no change without a real-tool measurement and a user decision.

## Problem

With shellcheck on PATH and rtk present, every .sh lint runs the probe plus `rtk shellcheck`, about 100 ms even when shellcheck takes 2 ms. Compaction only matters when there are findings, and clean runs probably dominate.

## Evidence

Stub shellcheck (exit 0): hook 177-185 ms through rtk vs 46-47 ms without rtk (N=9); `rtk shellcheck s.sh` alone 96-130 ms (full PATH) / 107 ms (trimmed); stub direct 2 ms. .py with stub ruff + rtk 120-139 ms; `rtk ruff check p.py` 35 ms. Sessions: .sh 76 edits, .py 84.

## Code locations

`runLintTool` (on-PATH branch: rtk first, then direct), `tryRtk`, `getRtkPrefix`.

## Approach

Install real shellcheck and ruff into a temp prefix (no global install), compare hook medians direct vs rtk on clean and dirty files, and count the clean/finding ratio in real sessions (F01 mining). If clean runs dominate and rtk costs about 100 ms, one option is: run the tool directly first, re-run through rtk only when it reports issues (doubles the cost on findings).

## Verification

A table of medians (clean/dirty × direct/rtk) and the session ratio; decision recorded here.

## Constraints

rtk compaction is a deliberate feature; any change needs a user decision.

## Related

F17 (probe cost), F14 (rtk and the gate), F01.
