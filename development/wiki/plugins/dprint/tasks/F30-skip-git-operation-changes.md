---
id: F30
title: Skip files changed by git operations in FileChanged and bash_finished
status: done
priority: medium
area: dprint/src/mcp/format.ts (formatOnDisk, gitDirOf, LOCK_WAIT_MS, MERGE_STAGED, MERGE_MARKERS)
---

## Status

Done in dprint 0.15.0. `formatOnDisk`, the shared core of `fileChanged` (FileChanged) and `bashFinished` (`bash_finished`), leaves files alone whose content a git operation put there: inside the held change slot, right before the existing `git status`, it finds the file's git dir (`gitDirOf`: nearest `.git` directory, or the `gitdir:` target of a `.git` file in a linked worktree or submodule), waits while `index.lock` exists there (poll 100 ms, at most `LOCK_WAIT_MS` = 5 s, `DPRINT_HOOKS_LOCK_WAIT_MS` for tests, abort checked after every sleep), then runs the unchanged status and also skips unmerged and staged-only files (`MERGE_STAGED` XY codes) while `MERGE_HEAD`, `rebase-merge` or `rebase-apply` exists in that git dir. Same exception as universal-lint F41 (0.19.0), adapted to dprint's hook design. `formatPre` (Write/Edit) is unchanged: the agent's own edits stay in the plugin's responsibility, also inside a conflicted file.

## Problem

The plugin formats its own changes; changes made by git (pull, merge, rebase, checkout/switch, the files of a new or entered worktree) come from outside. The existing git gate (empty status or `!!` skips) covered the steady state but not two windows:

1. While git still writes the worktree under `index.lock`, the index is not final and `git status` reports ` M` for a file git just wrote, so FileChanged formatted it.
2. A merge or rebase stopped on a conflict leaves unmerged files (`UU`, `AA`, ...) and auto-merged staged files (`M `, `A `, ...); the gate formatted them and altered git's conflict content.

## Approach

- Verdict from git state at format time, not from the git command. Worktree changes during a stopped merge (` M`, `MM`, `??`, `AM`) still format: someone changed the file after git.
- How the named operations end up skipped: pull and branch switch, after git finishes, leave files equal to the index (existing skip), and the lock wait covers the write window; a pull/merge/rebase stopped on a conflict is the new merge-state skip; a worktree switch (EnterWorktree, `git worktree add`, `cd` into another worktree) shows files equal to that worktree's index (existing skip), and the new checks read the worktree's own git dir through its `gitdir:` file. EnterWorktree/ExitWorktree only move the cwd, so no hook of their own is needed.
- Fail open as before: no git, no repository, a git error or a lock that outlives the wait means "format"; `gitDirOf` returning `null` only disables the new checks. A skip queues no notice and leaves `written` untouched; FileChanged has no channel to the model, so skips stay silent.
- Rejected alternatives:
  - A. One shared 10 s deadline for lock wait and status (as F41): under a never-removed lock the status gets 1 ms, is killed, and fail-open formats every file, including gitignored files and files equal to the index. The separate 5 s wait followed by the unchanged 10 s status keeps today's verdicts after a stale lock; worst case 15 s stays below the 30 s `bash_finished` and 60 s `file_changed` hook timeouts.
  - B. Lock wait before `acquireChangeSlot` (as F41 waits before `admitGit`): the slot wait can be long, a git operation starting during it would not be waited for; the check must sit right before the status call.
  - C. Detect the git command in the Bash call (`bash_started` regex): misses pulls from a terminal or IDE, `git -C`, aliases and scripts, suppresses the agent's own non-git changes in the same Bash call, and needs a hook-input template change.
  - D. `git rev-parse --absolute-git-dir` per file: one extra spawn (130-330 ms on 9P) for what a few stats answer.
- `gitDirOf` is a copy of universal-lint's (plugins cannot import each other; moving it to `development/shared/src` would force a version bump of every `@shared` consumer).
- Not covered (possible follow-ups): `CHERRY_PICK_HEAD`, `REVERT_HEAD` and stash-pop conflicts; refreshing the watch list after a checkout or EnterWorktree.
- Risks: a stale `index.lock` delays each formatting event by up to 5 s (the slot is held, concurrent events queue); git itself refuses to work until the lock is removed. During a stopped merge a file the agent changed via Bash that is still `UU` is not formatted; one that is ` M`/`MM` is.

## Verification

- Process tests in `dprint/tests/mcp-server.test.ts`, all named `git operation: ...`: stopped merge (`UU` and `M ` left alone, a later ` M` edit formatted), marker table (`MERGE_HEAD`, `rebase-merge`, `rebase-apply` skip a staged-only file, no marker formats it), linked worktree (merge marker only in `.git/worktrees/wt`), lock wait (lock file renamed onto the index after 300 ms, file unchanged), stale lock with `DPRINT_HOOKS_LOCK_WAIT_MS=200` (modified file formatted, ignored and clean files still skipped), `bash_finished` after a Bash-run `checkout` and a stopped `merge`.
- Revert check: run against the old `formatOnDisk` before the change, the stopped-merge test, the three marker rows, the linked-worktree test, the lock-wait test and the `bash_finished` merge row failed; the no-marker row, the stale-lock test and the `checkout` row passed there as intended (they pin behaviour that must not change).
- `pnpm lint && pnpm --filter dprint build && pnpm --filter dprint test`, `claude plugin validate dprint/plugin`.

## Constraints

Edit `src/`, never `plugin/`; `node:` builtins only; every git spawn keeps `--literal-pathspecs`, `--no-optional-locks`, the real path, `cwd: path.dirname(s.real)`, `timeout: 10_000` and fails open; `formatPre`, `isGitIgnored`, `gitChanged`, the watch list and the hook templates unchanged; TSDoc on every added symbol; version bump in `dprint/package.json`.

## Related

universal-lint F41 (the same exception, shared deadline instead of a separate lock wait), F06 (one git spawn per FileChanged event), F24 (watch list after checkout), F29 (`bash_finished` candidates).
