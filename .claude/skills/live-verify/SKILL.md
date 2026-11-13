---
name: live-verify
description: Verify a plugin's hooks and skills in a real Claude Code session (`claude -p --plugin-dir`) with a throwaway repo, the debug log and an inotify watch counter. Use when a behaviour depends on Claude Code itself (hook events, watchPaths, tool input rewriting, skills) and the unit tests cannot show it, or to measure on a slow file system.
argument-hint: "<plugin-name> <scenario>"
---

# live-verify

Recipe worked out for the dprint plugin; see `.claude/rules/claude-code-hook-facts.md` for the facts it established.

## Setup (always a throwaway)

- Repo under the session scratchpad (never in this repository): `git init`, a config, a few unformatted files, one commit. For slow-file-system checks use a writable `/mnt/c/Users/Public/<name>` in WSL and delete it afterwards.
- Put the steps in a bash/node script in the scratchpad and run it with one plain command (worktree sessions refuse compound commands).

## Run

```bash
claude -p --plugin-dir <worktree>/<plugin>/plugin \
  --debug-file "$S/debug.log" --allowedTools "Write,Edit,Read,Bash" --max-budget-usd 1 \
  "<exact tool steps; end with: Reply with the single word done.>"
```

- Narrow `--allowedTools`; never `--dangerously-skip-permissions`. Budget cap 1 USD per run, a handful of runs.
- Slash commands work as the prompt (`"/<plugin>:<skill> check"`); asking the model to _call_ the Skill tool only prints "Launching skill". `AskUserQuestion` is disabled in `-p`: flows stop at their first question (assert nothing was changed).
- Keep the session alive while an outside harness changes files: ask for **one Bash command that waits, written as `node -e "setTimeout(()=>{},45000)"`** (a foreground `sleep` can be blocked by a hook).
- Count inotify watches of the claude process: sum `inotify wd:` lines over `/proc/<pid>/fdinfo/<fd>` for fds whose link is `anon_inode:inotify`.
- Read the log: `grep -E "calling|provided|FileChanged"` (`Hooks: mcp_tool calling plugin:<p>:<server>/<tool>`, `Hook <Event> (...) provided additionalContext`, `FileChanged: watching N paths`, `FileChanged: change <file>`). A throwaway logging plugin (SessionStart command hook printing `watchPaths`, FileChanged command hook appending events to a file) isolates Claude Code behaviour from the plugin under test.

## Checks worth repeating

- Write, Edit (also with an empty `new_string`), Bash that rewrites a watched file, Bash that exits non-zero: file content afterwards and the notice in the log.
- Skills: `check` (exit code, files untouched), `fmt`, `init` (up to its first question).
- Same scenarios with the cwd on a slow mount; measure with a small JSON-RPC script against the built server (median of several runs), compare the old and the new path.
- Repeat a racy scenario at least 2-3 times (watch loss was racy: one run proved nothing).

## Report

Numbers from one machine, the Claude Code version, what was not exercised. Put results in the plugin's `docs/` evaluation, and stop when the next run would repeat an earlier one.
