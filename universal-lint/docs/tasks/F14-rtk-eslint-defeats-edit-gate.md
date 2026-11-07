---
id: F14
title: Bypass rtk lint on Edit; its compacted output has no line locations, so the edit-range gate passes everything
status: done
priority: medium
area: universal-lint/src/hooks/lint-file.mts (gateFinding, LOC_PATH_RE, LOC_ROW_RE, LOC_SHELLCHECK_RE, runLintTool, getRtkPrefix, tryRtk), universal-lint/.claude/rules/hook-design.md
---

# F14 Bypass rtk lint on Edit so the edit-range gate works

## Status

Obsolete since universal-lint 0.15.0: rtk support was removed, so this problem no longer exists. The text below is kept as history.

Open. real-sessions finding (confirmed, medium) plus the static missed item (same reproduction). hook-design.md documents "rtk-compacted text" as a fail-open residual; its cost was never measured.

## Problem

`rtk lint` (eslint) compacts output to `ESLint: N errors … Top rules … Top files: a.js (1 issues)` with no file:line. `gateFinding` sees no located line, fails open and reports the whole file's findings on every Edit: a rewake per Edit of any file with a pre-existing eslint error, regardless of the edited lines. `rtk tsc` keeps `a.ts(1,7)` locations and is gated correctly, so this is eslint-specific.

## Evidence

Fixture with eslint on PATH, a `no-unused-vars` error on line 1, Edit with structuredPatch on line 4: with rtk exit 2, stderr `ESLint: 1 errors … Top files: a.js (1 issues)`, 288 ms; with rtk removed from PATH exit 0 (gated), 229 ms. Same result in a second temp project (patch on line 2). History: 30-31 rtk-summary eslint findings, all surviving the 0.14.0 gate, e.g. repeated full-file reports on successive Edits of one file (203 → 119 → 50 errors). markdownlint (located output) is gated normally: 16 of 54 dropped.

## Code locations

`gateFinding` (returns the finding unchanged when no line is located); `runLintTool` (rtk attempts in the on-PATH and npx branches); `getRtkPrefix`; `tryRtk`.

## Approach

When `ranges` is non-null (an Edit), skip rtk for eslint and run the plain tool with its default stylish format (matches `LOC_ROW_RE`), gate, then truncate. Keep rtk for Write/FileChanged/skill driver (whole file). Hardcoding eslint is acceptable as a narrow rule, or detect generically: an rtk result with no `LOC_*` match on an Edit → re-run plain. Alternative: gate rtk's `[full output: <tee path>]` file. Update the residual note in hook-design.md.

## Verification

Test: Edit payload with structuredPatch outside a pre-existing eslint error, rtk stub printing a summary → exit 0 and the eslint stub called directly. Write of the same file still goes through rtk. Re-run the gate simulation over historical findings: out-of-range eslint findings dropped.

## Constraints

This partly reverses the documented "tool on PATH and rtk on PATH → run through rtk" rule (hook-design.md "rtk compaction"). The explicit trade-off: an Edit finding is uncompacted (more tokens) but gated, so it wakes Claude less often. Confirm with the user. It touches the same rtk-lint path as F02, so do it after F02. `buildArgv`/`classifyExit` contracts unchanged; gate stays fail-open for formats it cannot parse; rtk discovery stays "discovered, not hardcoded" for everything else. Version bump.

## Related

F02 (rtk banners for eslint), F04 (direct local bins have located output anyway), F23 (wake count), F27.
