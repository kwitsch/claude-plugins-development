---
name: refactor-plugin
description: Refactor one plugin of this repository end to end in a fresh worktree on its own branch cut from a freshly fetched origin/main - perf-worklist, then bughunt-loop, then a merge-ready PR. Use when the user asks to refactor, overhaul or run the full performance and bug hunt pass on a plugin.
argument-hint: "<plugin-name>"
---

# refactor-plugin

The argument is the plugin directory name, seen from the repository root. Stop with one line if `<plugin>/package.json` does not exist or has no `claudePlugin` key.

The user's request for this skill is the opt-in for the Workflow tool that `perf-worklist` and `bughunt-loop` use (load `workflow-authoring` first if it is not loaded). Never merge the PR.

## 1. Worktree on a fresh origin/main

1. `git fetch origin main`.
2. Not in a linked worktree (`git rev-parse --git-dir` equals `--git-common-dir`): call `EnterWorktree` (load it via ToolSearch if deferred) with `name: "refactor-<plugin>"`. Never nest. Already in a linked worktree: continue only when `git status --short` is empty and `git rev-list origin/main..HEAD` is empty, else stop with one line.
3. The worktree base follows the `worktree.baseRef` setting, so check `git rev-parse HEAD` equals `git rev-parse origin/main`; if not, `git reset --hard origin/main` (safe: the worktree is new and has no commits of its own).
4. `git switch -c refactoring/<plugin>-$(date +%y%m%d)`. Stop with one line if that branch already exists.
5. Note the worktree's absolute path and the branch. Run `pnpm install` when `node_modules` is missing.

## 2. perf-worklist, then 3. bughunt-loop

Run `Skill(perf-worklist, <plugin>)`, wait for its Workflow to finish (the completion notification), then run `Skill(bughunt-loop, <plugin>)` in the same worktree (both edit the same files, never in parallel). In both, "Start: worktree and branch" is already done: skip it and create no `perf/` or `fix/` branch; the work stays on the refactoring branch. A blocked job or stop is noted, not fatal.

## 4. Merge-ready PR

Both sub-skills may have opened the PR as a draft with their own title: this step owns its final state.

1. Version: `<plugin>/package.json` is higher than on `origin/main` (one bump for the whole branch, not one per stage; fix when a stage bumped twice or none did and `<plugin>/` changed) and the tag `<plugin>-<version>` is free here and in kwitsch/claude-plugins (`git ls-remote --tags` on both). Then `pnpm --filter <plugin> build`.
2. `git fetch origin main`, merge `origin/main` into the branch, resolve all conflicts (rebuild `<plugin>/plugin/` after a conflict in build output, never hand-edit it).
3. `pnpm lint`, `pnpm --filter <plugin> test`, `claude plugin validate <plugin>/plugin` green; commit and push; clean tree, head equal to its upstream.
4. PR (`gh pr view` first, `gh pr create --draft` when none): title `<plugin>: refactoring (<n> perf jobs, <m> bug fixes)`, body = result of each stage (perf jobs with status and commit, bug hunt rounds and fixes, stop reason, what stayed unexercised). No attribution lines.
5. Wait for the checks (`gh pr checks --watch`), `changed-plugins` included. Fix red checks on the branch and push again.
6. All checks green and no blocked stage: `gh pr ready`. Otherwise leave it a draft and say why.

## Report

PR URL, whether it is ready or still a draft, the outcome per stage, and the limits of the hunt (from `bughunt-loop`).
