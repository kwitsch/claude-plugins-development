---
id: F38
title: Settle-window docs still describe the 0.16.0 parse-error rule
status: open
priority: low
area: universal-lint/plugin/README.md, universal-lint/.claude/rules/settle-window.md (docs)
---

## Status

Open. Found by [EVALUATION-2026-11-14b](../EVALUATION-2026-11-14b.md) (docs drift check on 0.16.1). Docs only, no code change.

## Problem

F36 (0.16.1) changed the post-hold filter from `gateFinding(f, survives, resolved, false)` to `gateFinding(f, survives, resolved, "drop")`: a held own-file parse error is now dropped by **any** later edit, not only by one that rewrote its line. Two texts were not updated:

1. The user-facing `plugin/README.md` says "If a later edit of the file rewrites the line a finding sits on during that window, the finding is dropped (...); edits elsewhere drop nothing." Since 0.16.1 an edit elsewhere does drop a held parse error (correct behaviour, wrong sentence).
2. `.claude/rules/settle-window.md`, bullet "Lines.", still reads "Supersession = `gateFinding(f, line0 => ..., resolved, false)`: per diagnostic, parse-error exception off." The residual (9) of the same file already describes the F36 rule, so the file contradicts itself, and the rule is what a session reads before it touches `settleFindings`.

Minor, same file: `settle-window.md` is the only rule file of the plugin whose first heading is `##` (it was cut out of `hook-design.md` by F37); the others start with `#`.

## Evidence

- `src/hooks/lint-file.mts` `settleFindings` at HEAD `8197268`: `gateFinding(f, survives, resolved, "drop")` (filter) and `gateFinding(f, () => false, resolved, "drop")` (F35 precheck).
- `grep -n "edits elsewhere drop nothing" universal-lint/plugin/README.md`: 1 hit (the settle paragraph).
- `grep -n "resolved, false)" universal-lint/.claude/rules/settle-window.md`: 1 hit (bullet "Lines.").
- Behaviour itself confirmed by EVALUATION-2026-11-14b "Parse-error repro": the Write's held `SC1009` at EOF is dropped after the Edit that fixed line 2.

## Code locations

None (docs). `plugin/README.md` (the settle-window paragraph under the overview), `.claude/rules/settle-window.md` (bullet "Lines.", first heading).

## Approach

- README: replace "edits elsewhere drop nothing" with the actual rule, e.g. "edits elsewhere drop nothing, except a held parse error, which any later edit drops (its own lint reports the error again if it persists)".
- settle-window.md "Lines.": `gateFinding(f, line0 => ..., resolved, "drop")`: per diagnostic; an own-file parse error is dropped by any later record (F36). Net-neutral wording; the file is 5,846 characters.
- First heading of settle-window.md: `#` instead of `##`, like the other rule files.

## Verification

`grep` above gives 0 hits; `dprint check` clean on the touched files; `wc -m` of every rule file below 40,000. `plugin/README.md` is under `universal-lint/`, so the change needs a version bump unless it ships with another change of the same release.

## Constraints

Docs only. No behaviour change. Keep the README wording user-facing (no task ids beyond what it already carries).

## Related

F34 (settle window), F35 (precheck), F36 (parse errors in the hold), F37 (moved the section into settle-window.md).
