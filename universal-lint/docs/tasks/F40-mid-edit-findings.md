---
id: F40
title: Mid-edit findings - route to the editing agent, report a burst's final state once, sweep at turn end
status: done
priority: high
area: universal-lint/src/hooks/lint-file.ts (ownerOf, recordEdit, pendingRanges, settleFindings, sweepHandler, lintFileHandler, fileChangedHandler, main), universal-lint/plugin/hooks/hooks.json
---

## Status

Shipped in 0.17.0 on user request (2026-11-15): the user reported that the plugin "kept reporting mid-edit findings", asked for a log analysis and a plan, and chose all three phases of it.

## Problem

Findings woke Claude for states of a file that were never meant to last, although 0.16.0 had added the settle window (F34) for exactly that.

## Evidence

Mining of the local transcripts, 2026-11-07 to 2026-11-15 (15 sessions, all in this repository): every `queue-operation` `enqueue` record whose content is a `universal-lint: <tool> found issues in` hook error is one wake-up (delivery: a `user` string record = a turn of its own, an `attachment` `queued_command` = absorbed into the running turn). Each wake-up was joined to the Write/Edit calls of the main transcript and of every subagent transcript below the session (`subagents/**`). 133 wake-ups: 115 oxlint, 17 markdownlint-cli2, 1 test stub. The mining scripts are kept outside the repo.

| Finding                                                                                  |       Number |
| ---------------------------------------------------------------------------------------- | -----------: |
| Triggered by a subagent's or workflow agent's edit, delivered to the main conversation   |    82 of 133 |
| of those delivered as a turn of their own                                                |           81 |
| of those where the finding text never appears in the editing agent's transcript          |           65 |
| Triggered by the main conversation's own edit                                            |    51 of 133 |
| of those with only "change not finished" rules (see below)                               |           35 |
| Wake-ups after 0.16.1 was live (from 2026-11-14 16:00 UTC)                               |           48 |
| of those reported less than 5 s after the latest edit of the same file                   |           18 |
| of those held the full 5 s and reported anyway                                           |           30 |
| Next edit of the same file after a wake-up: median                                       |         25 s |
| Next edit of the same file within 5 s of the wake-up                                     |    21 of 110 |
| Trigger followed by another edit of the same file by the same agent within 5 / 20 / 60 s | 13 / 53 / 71 |
| Wake-ups from FileChanged lints, all transcripts                                         |           15 |

"Change not finished" rules: `no-unused-vars`, TS2304 (unknown name), TS2305/TS2307 (missing export or module), TS2554 (argument count), `no-unsafe-*` on a value typed `error`, parse errors. They are repaired on another line or in another file than the one they are reported on.

Causes:

1. Wrong recipient. Exit 2 of an `asyncRewake` hook wakes the main conversation, also when a subagent made the edit; the hook ignored the payload's `agent_id`. The main conversation's reply was each time that an agent was mid-edit and that it would not touch the file.
2. F34's supersession was line-local: a finding was dropped only when a later edit rewrote exactly its line. Declare-then-use and use-then-import are repaired elsewhere.
3. 5 s was too short, and an edit landing while the linter ran (`d0 !== d1`) skipped the hold altogether.
4. Every edit of a burst reported its own intermediate state (four wake-ups in one second for one file).

Not part of this task: 8 of the 133 are `MD025` on task documents (a markdownlint config matter of this repository).

## Code locations

`ownerOf`, `recordEdit` (owner in the record name, `ranges`/`fp`/`cwd` in the record, activity stamp, 24 h prune), `pendingRanges`/`pendingUnion`, `settleClean`, `settleFindings` (quiet-time hold, newest-record rule, claim), `sweepHandler`/`sweepFile`/`pruneActivity`, `lintFileHandler`, `fileChangedHandler`, `main`, `settleWaitMs`; `gateFinding` lost its predicate form and the `keepParseErrors` parameter. `plugin/hooks/hooks.json`: `Stop`, `SubagentStop`.

## Approach

1. Owner routing: a subagent's edit is journaled and not linted; `SubagentStop` lints the agent's pending files once and reports to that agent.
2. The newest edit owns the report: a held lint reports nothing when a newer record of file and owner exists; every lint gates against the lines of all pending edits (hunks carried forward, chain-checked by digests, whole file when the chain is broken). The hold is quiet time: 20 s without a Write/Edit of the owner, on any file.
3. `Stop` sweeps what is still pending for the main conversation. The sweep is what makes the drops of step 2 lossless (F23's residual: the later lint dies or skips).

Full contract and residuals: `.claude/rules/settle-window.md`.

Rejected: a per-language list of "change not finished" rules that are deferred (a table per linter to maintain; steps 2 and 3 cover the same cases); a longer fixed hold alone (does not help the 82, and delays real findings); reporting only at turn end (long autonomous turns would get their findings hours late).

Decisions changed (user, 2026-11-15): "no debounce" (2026-11-06) is narrowed further (the lint still starts at once; the report waits for quiet time; a subagent's edit is linted at its stop); F23's "no superseded-lint drop" is replaced by the hand-off; F35 and F36 are obsolete (their code is removed).

## Verification

- `pnpm lint`, `pnpm --filter universal-lint build`, `pnpm --filter universal-lint test`: 432 tests. `tests/settle.test.ts` 31 (before: 33; the three `gateFinding` predicate and `"drop"` tests went with the code, the 16 line-local `settleFindings` cases became 5 `pendingRanges` and 9 `settleFindings` cases, plus one `ownerOf` and two more `settleWaitMs` tests), `tests/settle-process.test.ts` 28 real-process tests (before: 22): hand-off to the later lint with the earlier edit's line, early end of a superseded lint, quiet time renewed by an edit of another file, subagent edit journaled and not linted, sweep gated to all edits of the agent with one lint per file, the stop after a report let through, a stop continued by another hook still swept, Stop claiming a held lint, a finding repaired outside Write/Edit never reported. `tests/manifest.test.ts` pins the two new hooks as synchronous.
- Live, Claude Code 2.1.325, headless `claude -p` with throwaway plugins and repositories (2026-11-15):
  - payload facts: a PostToolUse payload of an Agent-tool subagent and of a workflow agent carries `agent_id` and `agent_type` (`general-purpose`, `workflow-subagent`), the main conversation's does not; `SubagentStop` and `Stop` exit 2 with stderr make the stopping agent continue and act on the text, and the following stop carries `stop_hook_active: true`; hooks see `CLAUDE_CODE_ENTRYPOINT=sdk-cli` (interactive: `cli`).
  - the built plugin with a stub shellcheck flagging `BAD` lines: the main conversation's Write was reported at once (hook 66 ms, no hold) and fixed; a subagent's Write and Edit ended with status 0 in about 40 ms and no linter run; its `SubagentStop` ran one lint of the final file, exited 2, the subagent fixed the line, and its second stop passed in 44 ms without a lint; `Stop` with nothing pending took 40 ms.
- Not exercised live: an interactive session (hooks in the background, the 20 s quiet time, `Stop` claiming a held lint); those paths are covered by the process tests only. Not measured: the cost of the sweep on a large TypeScript project.

## Constraints

Never write into the project tree; fail open; no toggle (CLAUDE.md "No userConfig"): `UNIVERSAL_LINT_SETTLE_MS` stays a test and perf-harness seam. A stop is blocked at most once.

## Reopen trigger

A user report of findings that arrive too late (shorten `SETTLE_MS`), of findings a subagent never got (residuals 1 and 2 of `settle-window.md`), or of a slow turn end (the sweep). Re-mine the transcripts with the recipe above after a few days on 0.17.0 and compare with the table.

## Related

F34 (settle window, rebuilt here), F23 (superseded and duplicate wakes), F35, F36 (obsolete), F38 (closed by this task's docs rewrite), F39 (test wall time).
