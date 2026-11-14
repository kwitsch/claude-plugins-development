---
paths:
  - "*/src/**"
  - "*/tests/**"
---

# Rule: caches, buffers and regression tests in hook code

Learned from the jevfort performance worklist (F01-F08) and the bug hunt after it (14 rounds, 78+ fixes): most defects were regressions of the performance fixes or tests that could not fail. Every point below was a reproduced defect.

## A cache added for speed

- Write down, next to the cache, every event that changes its inputs, and drop it there: turn end, `session.end` (/clear, /resume), `session.start`, a command run between turns, a blocklist or setting write, a cwd change mid-turn (a carried-over `cd`, a worktree switch), a transcript that shrank (mid-turn compaction, a delivered message). One test per drop point.
- A value read once at session start is stale for the first turn when its source is still filling (MCP servers connect after `session.start`): drop it after the baseline.
- An incremental scan ("only rows not seen yet") must restart when the earlier rows changed (fewer rows, a different first row), and must count a row only once it is final (a tool call without its result yet is not).
- A budget loop over partly cached items uses `continue`, not `break`, once the budget is spent: items cached by an earlier pass are free.
- Merging two requests into one keeps the old failure semantics explicitly (all or nothing), and the caller of the merged answer must not ask the second question again.
- State read before an `await` and used after it is re-read after the `await` (an expiry, a flag, a timer epoch); bail out when it moved.

## Buffered writes

- A write buffer is flushed at every exit of its owner: normal end, inactive/early-return paths, session end, and before any reader (a status command). A flush with nothing pending still waits for the queued flushes, so a reader after it sees their writes. Clearing the store clears the buffer and the in-memory view too.

## Text and names

- Every cut of user or model text (`slice`, a status line, a table cell, a tail) goes through one helper that drops a split surrogate; the "N more chars" note counts what was really dropped.
- A name allowlist (scripts, targets) also checks each word of the name (split at `:`, `-`, `_` and camelCase humps, also after an acronym run) against a deny list (`fix`, `write`, `format`, `update`, `watch`, `dev`, `serve`, ...).
- Path deny patterns ignore case (APFS, Windows, WSL `/mnt/c`), refuse suffixed backups (`settings.json.bak`, `~`) and any `..` segment.
- A model's choice outside the offered options (blocklisted, gone, made up) is no answer: check it with `Object.hasOwn(offered, choice)`.

## Regression tests

- Revert the fix and run the test; a test that passes on the old code is not a regression test. Typical ways a test cannot fail: it reads the last recorded call (`at(-1)`) when the step under test recorded nothing, so an earlier step's call answers (take `slice(before)`); the fixture never reaches the branch (the guard returns earlier for another reason); the asserted value is the default.
- Every decision constant (threshold, cap, cut point, option that turns a feature off with 0 or `false`) gets a test on both sides of the edge.
- No wall-clock thresholds in tests; inject the clock.
- Docs, task files and rules that state numbers, defaults or "scanned once" claims are updated in the commit that changes the behaviour.
