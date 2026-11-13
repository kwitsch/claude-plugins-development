---
name: worktree
description: Makes sure work happens on its own branch or worktree, not on main or in the user's checkout. Use before executing a plan or starting a bug fix.
---

# worktree

1. **Where am I?** `git branch --show-current` and `git rev-parse --show-toplevel`. Already in a linked worktree (git dir differs from the common dir) or on a work branch: stay, and say so. Never nest a worktree in a worktree.
2. **Uncommitted changes** belong to the user: do not stash, reset or discard them. If they would be in the way, ask through `AskUserQuestion`.
3. **Branch name** by track: `feat/<slug>`, `fix/<slug>`, following the repo's conventions if it has any.
4. **Create it:** prefer the harness's own worktree tool (EnterWorktree) when available; otherwise `git worktree add <path> -b <branch>` from the default branch. Use the repo's own worktree directory convention if one exists, and make sure it is git-ignored.
5. **Set up and baseline:** install dependencies the repo's way, run the tests once. A failing baseline is reported to the user before any change, so new failures can be told apart.
6. Report the branch and the worktree path.
