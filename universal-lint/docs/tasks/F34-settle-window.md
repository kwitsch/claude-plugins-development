---
id: F34
title: Settle window - a finding that the next edit already repaired never wakes Claude
status: done
priority: medium
area: universal-lint/src/hooks/lint-file.mts (recordEdit, settleFindings, editHunks, carryLine, gateFinding, lintResolved, lintFileHandler, fileChangedHandler)
---

## Status

Shipped in 0.16.0 on user request (2026-11-14): "the linters register findings internally first; if within the next 5 seconds the lines with findings are edited and the edit does not reproduce the linter error, it is not reported to Claude."

## Problem

Every Write/Edit lint that found something exited 2 at once, so Claude was woken for an error that its very next edit (1-3 s later, the median same-file gap is 2.8 s, F23) already repaired.

## Decision

Hold the **report**, never the lint: a lint with findings sleeps `SETTLE_MS` (5 s) and then drops the diagnostics, located in the linted file, on lines that a later edit removed or replaced; the later edit's own lint reports what persists there. Full contract, journal format, coordinate anchor and residuals: `.claude/rules/hook-design.md` "Settle window (F34)".

Approaches (design/spec in the session scratchpad, jev-api `choice` A at 0.81):

|     | Approach                                                                                  | Verdict                                                                                             |
| --- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| A   | Per-edit journal on disk (hunks + digest), hold, line-mapped supersession, no second lint | chosen                                                                                              |
| B   | Re-lint after the hold, keep what is still present                                        | rejected: a second full lint per finding (tsc, cargo) while the later edit's hook lints anyway      |
| C   | Debounce before linting                                                                   | rejected: delays clean files too, contradicts "no debounce" (here only the report waits)            |
| D   | Persistent MCP server with in-memory pending list                                         | rejected: reverses the 2026-11-06 command-hook decision                                             |
| A-  | Overlap by edit ranges without carrying lines                                             | rejected: an insertion above a finding shifts it into a later edit's range and drops a real finding |

Relation to F23 (closed 2026-11-10 with "no drop, no wait"): this narrows both. A finding is dropped only when a later edit rewrote exactly its line, never for an edit elsewhere (F23's Edit A / Edit B counterexample stays intact), and the lint is not delayed. F23's residual (the later lint dies or skips after the drop) stays and is accepted by the request.

Decider findings of the design review (headless run) that shaped the result: record FileChanged edits only after the digest-match skip (the echo of a Write/Edit is no later edit); release the FileChanged slot before the hold (`lintResolved` returns `Finding[]`, the hold sits in `settleFindings`); anchor the finding's coordinates with file digests (`d0`/`d1` around the lint, digest in every journal record) instead of assuming the state of the lint's own edit; one rule for foreign and unlocated findings (never dropped).

## Verification

- `pnpm lint`, `pnpm --filter universal-lint build`, `pnpm --filter universal-lint test` (358 tests; `tests/settle.test.mts` units, `tests/settle-process.test.mts` real hook processes with a stub shellcheck: hold length, line rewritten without reproducing, edit elsewhere, reproduced error, Write and FileChanged supersession, echo records nothing, empty patch records nothing, slot free during the hold).
- Live, Claude Code 2.1.325, interactive (tmux), stub shellcheck flagging `BAD` lines, `UNIVERSAL_LINT_SETTLE_MS=15000`: Write of a flagged line then an Edit of that line 1 s later: no wake in 50 s; Write then an Edit of another line: the finding woke Claude 16 s after the Write. Not exercised: the 5 s default in a live session (the seam only changes the number), slow file systems, tsc-length lints (supersession is off there when an edit lands during the lint).
- Headless `claude -p` (same version): the PostToolUse hook is **not** backgrounded (debug log "Slow PostToolUse hooks: 46026ms for Write", the next tool call starts after the hook ended), so there the hold delays the turn by up to 5 s per lint with findings and can never be superseded; the finding reaches the model in the same turn as before. Accepted, documented in the README and `hook-design.md`.

## Constraints

Never write into the project tree; fail open; the hold must end before the 90 s hook backstop; no toggle (CLAUDE.md "No userConfig"): `UNIVERSAL_LINT_SETTLE_MS` is a test and perf-harness seam. Version bump (0.16.0).

## Reopen trigger

A user report that the 5 s delay hurts headless runs (detect headless and skip the hold), or Claude Code starting to background `asyncRewake` hooks in `-p` mode.

## Related

F23 (superseded and duplicate wakes), F13 (FileChanged dedup that is not a debounce), F10 (slot cap: a held finding never keeps a slot), F32 (digest echo).
