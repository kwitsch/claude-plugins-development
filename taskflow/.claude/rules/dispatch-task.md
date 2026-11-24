---
paths:
  - "assets/skills/dispatch-task/**"
---

# Rule: the dispatch-task skill

`SKILL.md` dispatches `/taskflow:build-task --skip-branch-check <task text>` into a new worktree-isolated background session (`claude --worktree <name> --model … --effort … --permission-mode auto --bg`) and reports the CLI's own session id. Reasons and rejected alternatives: [dispatch-task.md](../../../development/wiki/plugins/taskflow/design/dispatch-task.md).

- Self-contained: no file under `assets/skills/dispatch-task/` names another plugin (the tests grep it for `coding-toolbox`, `dispatch-agent`, `superpowers`). It is a fork of `coding-toolbox:dispatch-agent`, never a call into it; do not "deduplicate".
- `disable-model-invocation: true`; `--permission-mode auto` is always forced; `allowed-tools` is bare `Bash`, not `Bash(claude:*)`. The skill's own Bash never touches `git`.
- `--model=` / `--effort=` overrides, defaults `sonnet` / `xhigh`; the resolved values are validated against `^[A-Za-z0-9._-]+$` before substitution.
- The task text travels in a single-quoted heredoc read back by direct command substitution (no temp file); the delimiter is the fixed `DISPATCH_TASK_PROMPT_EOF`, never a per-invocation token.
- Worktree base: `claude --worktree` bases the worktree on `origin/<default branch>` unless the project's `worktree.baseRef` setting is `"head"` (default `"fresh"`), then on the dispatching session's local `HEAD`. Never assume `"fresh"` in docs or `SKILL.md`; describe the conditional and do not override the project's choice.
- The worktree is on an auto-generated branch name, so the payload's first instruction is `git checkout -b "feature/<same-slug>"` and it passes `--skip-branch-check`, which skips `build-task` step 1's clean check and worktree creation (without the flag it would not fire here either: step 1 only creates a `feature/<slug>` worktree when the current branch equals `BASE_BRANCH`).
- The report step says a dispatched run may pause at an `AskUserQuestion` checkpoint with nobody present and points at `claude attach <id>`; the payload is the bare command plus the task text, no autonomy nudging.
