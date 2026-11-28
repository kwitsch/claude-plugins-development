# Drawing the status line

Why statusbar's mod substitutes the StatusLine site's text from a 10 s timer instead of shipping a status line command, and what the live checks showed.

## Decisions (user, 2026-11-28)

- The mod produces the line itself (USER DECISION q1): it hooks the StatusLine render and reads the context percent and the `five_hour` / `seven_day` rate limits from `$.session.usage()`. It recomputes at every `turn.complete`, at `session.measure` and on a 10 s `$.clock.every`, with a pure formatter ported from the user's `statusline-command.sh`. Reason: hour-long workflows use up the 5-hour quota without a turn completing, and the status line command only re-runs on its own triggers. No cache file.
- The git lookup behaves like the script's `git -C <cwd>` (USER DECISION 1): walk up from the cwd to `.git`; a `.git` file (linked worktree, submodule) is followed through its `gitdir:` line; branch = everything after `refs/heads/`; a detached HEAD shows the first 7 hash characters; no `.git` = red folder and no branch segment. Read through `$.fs` (not permission-checked, works from the timer), no process spawn.
- Drawing is substitution (USER DECISION 2): the StatusLine hook passes the formatter's ANSI string as `e.props.text` to `next`, replacing the command's output. No own tree, no append, no `$.ui.status`; the user's `statusLine` settings entry stays and the line is not doubled. Before the first successful refresh `e` passes unchanged.
- One live check covers the stated reason (USER DECISION 3): after a turn ended and a background workflow keeps calling the API, the timer still fires and the 5h figure moves; a frozen figure stops the work.
- `$.fs` is handed to `gitBranch` as two closures (`exists`, `read`), not as `$.fs` itself: the engine's static check rejects a bare `$.<noun>` value ([claude-code-hook-facts.md](../../../../../.claude/rules/claude-code-hook-facts.md)).

## Rejected alternatives

- B. A status line command (`bin/statusbar.mjs`) with `statusLine.refreshInterval: 10`, the mod only checking the wiring: needs a manual edit of the user's settings (plugins cannot set `statusLine`), an unverified `plugin/bin` PATH for the status line, a Node and git spawn every 10 s, and the mod does nothing visible. Lost to q1.
- C. An own `Box`/`Text` row, appending to `next(e)`, or `$.ui.status(text)`: an own tree loses the command line's layout handling, appending doubles the line while the `statusLine` entry exists, `$.ui.status` has no colour and is a second surface. Lost to decision 2.
- D. The branch through `$.process.run(["git", ...])` in-frame only: from the 10 s timer it is out of frame (a permission dialog per call in default mode, denied headless), so the branch would update only on turn ends. Lost to decision 1.

## Residuals

- `.git` parsing ignores `GIT_DIR` / `GIT_WORK_TREE` overrides, `core.worktree` and symbolic refs outside `refs/heads/`; a detached HEAD shows 7 hash characters even where git would print more.
- Non-finite percentages count as absent (the shell errors there); the shell's `printf "%b"` re-interpretation of the folder name is not replicated.
- No `session.end` hook: after `/clear` or `/resume` the next trigger (at most 10 s) redraws.
- Another plugin's StatusLine hook beneath sees the mod's text once a line exists.

## Live checks

Results and stamps: [mods-engine-status-line.md](../../../facts/mods-engine-status-line.md).

- L1: passed: substitution stands; the site also renders without a `statusLine` entry (`props.text: null`).
- L2: passed: the timer meets the requirement; the 5h figure moves while a background workflow runs after the turn ended.
- L3: passed: the git lookup through `$.fs` runs from the timer too (no dialog, no denial; headless runs exit with the timer armed).
- L4: passed: validate accepts `session.measure` and `usage()` does not raise it; the hook stays.
