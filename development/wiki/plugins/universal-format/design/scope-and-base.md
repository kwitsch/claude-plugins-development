# Scope: `cwd` is a hint, the base directory is the anchor (do not "fix" without reading this)

Which files `format_pre` formats, which directory each project-scoped lookup anchors at, which paths are excluded, and why there is no cwd tracking.

## `resolveBase`

- There is no outside-cwd guard: a Write/Edit to any path is formatted, also a file in no project. `resolveBase(cwd, file)` returns, in order:
  1. `cwd`, when it is not empty and contains the file;
  2. else the nearest ancestor directory of the file that holds a `.git` entry;
  3. else the file's own directory.
- Everything project-scoped anchors on that base: the input of `isExcludedPath`, `<base>/.prettierignore`, the resolution of a prettier config's `plugins`, the bound of the `.editorconfig` and tool-native-config walks, the cwd of a CLI formatter and the key of the ignore cache. A file outside the cwd is therefore formatted against its own project's config.
- The base is always the file's directory or an ancestor of it, so the base-relative path never starts with `..` and the bounded upward walks end at the base.
- `.git` is existence-checked, never `isDirectory()`-checked: a linked worktree's and a submodule's `.git` is a file.
- The git-root walk ends at `$HOME` without checking it: a git-tracked dotfiles checkout there must not become "the project" of an unrelated scratch file. A project below `$HOME` still resolves to its own, nearer root.
- The walk is memoised per file directory for the life of the process (`gitRootCache`); a `git init` after the first miss is not seen (accepted, tested).
- `relativeIfContains` uses `path.relative`. The older `resolved.startsWith(dir + path.sep)` form answered "no" for every file when the directory had a trailing separator or was `/`, which silently disabled the plugin for the session. Do not go back to a prefix test, and do not re-add a project-membership gate.
- A relative `file_path` with an empty `cwd` is the one unresolvable case and answers `{}`.
- The only skip reasons are: extension, the path exclusions below, the dprint gate ([dprint-gate.md](dprint-gate.md)) and `<base>/.prettierignore`.

## Path exclusions

- `isExcludedPath` skips `node_modules`, `vendor` and `.git` segments, two subtrees Claude Code owns (`.claude/worktrees/`: harness-created worktrees; `.claude/agent-memory/`: agent runtime state) and any base name containing `.local.` (`settings.local.json`, the `*.local.*` convention of `.claude/.gitignore`).
- Deliberately narrow, not a blanket `.claude/` exclusion: `rules/`, `agents/`, `skills/` and `settings.json` are tracked content and stay formatted.
- It must be evaluated on the base-relative path. Absolute segments would exclude a session's own worktree for good: its path is `<repo>/.claude/worktrees/<name>/…`, and that worktree is the session's cwd once `EnterWorktree` moved it there.
- The absolute path is checked for `.claude/worktrees` and `.claude/agent-memory` only when the base is not the cwd. Reason: a file written by absolute path into another agent's worktree would anchor the base at that worktree's root (its `.git` file ends the walk there), which removes `.claude/worktrees` from the relative path, and this agent would reformat state it never entered. When the base is the cwd, the write is inside the session's own root and must stay formatted.

## The payload `cwd` follows the session

- Claude Code reports the worktree as `cwd` on every hook call after `EnterWorktree`, in the command-hook payload and in the `${cwd}` placeholder of an `mcp_tool` hook alike; no `CwdChanged` event fires for it (live 2.1.326: a headless session with this plugin and a throwaway probe plugin logging both; a Write inside the worktree was formatted and its notice named the relative path; first seen on 2.1.303 with an instrumented server).
- So `cwd` is used as it is, only passed through `path.resolve`: a trailing separator would never equal a walked directory, and the walks bounded by the base would run to the filesystem root. Do not add cwd tracking or a per-agent override.

## History

- 0.13.0 to 0.18.0 carried a `worktree_entered` hook (PostToolUse `EnterWorktree`) and a per-agent `cwdOverrides` map, because an older Claude Code kept reporting the pre-worktree `cwd`. 0.19.0 deleted the hook, the map and the `agent_id`/`session_id` plumbing.
- Before that the plugin had a cwd gate (`relativeInCwd`): files outside the cwd were skipped.
