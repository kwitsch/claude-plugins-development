---
id: F41
title: Skip files that git pull, a branch switch or a worktree switch changed
status: done
priority: medium
area: file-detection
---

## Status

Shipped in 0.19.0 on user request (2026-11-28). The skip policy is a user decision (q1): a clean or ignored git verdict skips the FileChanged lint and deletes its journal record for every cause, not only for a detected pull or branch switch.

## Problem

A `git pull` (fast-forward, merge, rebase), a branch switch (`git checkout <branch>`, `git switch`) or a worktree switch changes files that the plugin did not write; linting them is outside its purpose (lint its own changes). Before 0.19.0 such files were still linted: the FileChanged record stayed in the journal after the git gate said "clean" and the Stop sweep linted the file whole, and events that arrived while git was still writing saw `M` and linted inline. A pull stopped on conflicts left unmerged (`UU`) and staged-only (`M `) files that linted too.

## Evidence

- Stop-sweep path, read in code: `fileChangedHandler` journals a whole-file record (`recordEdit`) before the git gate; the gate's `{}` for a clean or ignored file kept the record; `sweepHandler`/`sweepFile` claim every pending record of the owner and lint without a git gate.
- Mid-operation race, from git semantics (not reproduced live): git writes the worktree while it holds `<gitdir>/index.lock`, then commits the index, then updates HEAD; a `git --no-optional-locks status` in that window compares against the old index and HEAD.
- Stopped pull, from git semantics: `MERGE_HEAD`, `rebase-merge/` or `rebase-apply/` in the per-worktree git dir; conflicted files `UU`/`AA`/..., auto-merged files staged-only.
- Worktree switch: EnterWorktree, ExitWorktree and `git worktree add` rewrite no file of the start directory; the watch list stays on it (R12, live 2.1.332), so no FileChanged lint arises.

## Code locations

- `universal-lint/src/hooks/lint-core.ts`: `fileChangedHandler` (lock wait, `skip` closure deleting `rec.name`, merge-state check), `gitDirOf` (next to `admitGit`).
- `universal-lint/tests/file-detection.test.ts`: the `(F41)` tests.

## Approach

- After `recordEdit` (still before the first `await`): `gitDirOf(path.dirname(real))`; while `<gitdir>/index.lock` exists, poll every 100 ms without an `admitGit` permit, up to one `GIT_TIMEOUT_MS` deadline shared with `git status` (whose timeout is what is left, at least 1 ms); a cancelled call returns and keeps its record.
- Empty or `!!` status: delete the call's own record and return. During a stopped merge or rebase, XY unmerged (`DD AU UD UA DU AA UU`) or staged-only (X in `MADRC`, Y a space): the same.
- Any git error lints (fail open); `gitDirOf` null means no wait and no merge-state check.
- Rejected: (B) reflog attribution (tail of `<gitdir>/logs/HEAD`, ctime vs entry time, `git diff --quiet`): about 60 more lines, one more spawn per file, a timing heuristic with residuals, git-version-specific reflog wording, still needs the lock wait, and the user chose the every-cause policy. (C) a Bash `tool.call` matcher or PostToolUse Bash hook opening a skip window: misses a pull in the user's terminal, `git -C`, aliases, chains and scripts, the matcher is unverified on the current mods engine, a time window would silence real external edits. (D) dropping the record before the gate: `recordEdit` must run before the first `await` (generation marker, `settle-window.md`) and the verdict cannot be had synchronously.
- No new hook, dependency, Map, constant or config.

## Verification

- `tests/file-detection.test.ts`: branch switch, fast-forward pull, pull stopped on a conflict (conflicted and auto-merged skipped, an outside ` M` edit linted), staged-only without merge state linted, the same in a linked worktree (`gitdir:` file; `MERGE_HEAD` only in the worktree's git dir), lock wait (the server's `git status` runs only after the lock is released, nothing linted), a lock that never goes away (lints after `GIT_TIMEOUT_MS`).
- Reverting the `journal.delete` makes the branch-switch, pull and stopped-pull tests fail; reverting the lock wait makes the lock-wait test fail (checked locally once).

## Constraints

- Only the call's own record is deleted; earlier records (the agent's own Write/Edit) stay.
- No `userConfig` toggle (`universal-lint/CLAUDE.md`).

## Related

- [file-detection.md](../design/file-detection.md) "FileChanged skip order" (residuals), [settle-window.md](../design/settle-window.md) "Journal", [hook-design.md](../design/hook-design.md) "git".
- F15 (watch-list refresh after a checkout) and the R12 follow-up (watch list after EnterWorktree) stay open as they were.
