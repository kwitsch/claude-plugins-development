---
paths:
  - "src/mcp/**"
  - "plugin/mcp/**"
  - "plugin/.mcp.json"
  - "tests/mcp-*.test.ts"
---

# dprint-hooks MCP server

`plugin/hooks/hooks.json` (hand-written) wires PreToolUse `Write|Edit` as an `mcp_tool` hook to tool `format_pre` of
the MCP server `dprint-hooks` (`plugin/.mcp.json`, hand-written, `command: node`), plus the other tools below.
`findDprint`/`findConfig` resolution: see the skill-scripts rule. Limits, timeouts, retry delays and git/dprint
arguments are named constants or comments in the sources; this rule records behaviour and constraints only.

## Constraints

- Every failure returns `{}` (fail open), including a diff above the size guard.
- `watch-paths.ts` and `watch-list.ts` must not import `server.ts` (`watch-list.ts` not `format.ts` either):
  `watch-paths` runs as its own `command` hook.
- Scope never uses `process.cwd()`.
- Needs dprint >= 0.50.
- Every tool in `tools/list` carries `HOOK_ONLY_META` (`ui.visibility: ["app"]`, effect: repo rule
  `.claude/rules/mcp-dual-era.md`). A deny rule behaves the same, but a plugin cannot ship one; the docs
  name the field only for cloud sessions, so `mcp-server.test.ts` pins it.
- Dual-era (repo rule `.claude/rules/mcp-dual-era.md`), no tasks (every tool is a short hook call). `mcp-server.test.ts` covers both eras.
- `notifications/cancelled` (repo rule): one stderr line; handlers get the `AbortSignal` as second argument
  (`formatOnDisk` checks it also after the slot wait). A format already sent to `dprint lsp` runs on until the LSP answers or times out.

## Modules

- `server.ts`: MCP stdio loop, tools `format_pre`, `cwd_changed` (CwdChanged), `worktree_entered`/`worktree_exited`
  (PostToolUse EnterWorktree/ExitWorktree), `file_written` (PostToolUse Write|Edit), `file_changed` (FileChanged),
  `bash_started`/`bash_finished` (PreToolUse, and PostToolUse plus PostToolUseFailure `Bash`: a non-zero exit fires
  the failure event) and `drain_notices` (PreToolUse `Edit|Write|Read|Bash|MultiEdit`, UserPromptSubmit). Typed by
  `HookInputs` (see the hook-inputs rule).
- `lsp.ts`: `dprint lsp` client, one lazily spawned child per cwd. A request timeout puts that document in a cooldown
  (fails at once); idle exit (next format respawns); respawn after a crash; `close()` (eviction/shutdown) makes later
  formats fail instead of spawning; after dprint was not found, `findDprint` is retried only after a pause.
- `watch-list.ts`: `dprintFilePaths` (`dprint file-paths`, capped at `WATCH_LIMIT`), shared by `watch-paths.ts` and
  `bashFinished`.
- `watch-paths.ts`: `command` hook for SessionStart and CwdChanged (SessionStart `mcp_tool` hooks are skipped while
  the server connects). Lists the cwd's files, filters through `inScope`, prints `hookSpecificOutput.watchPaths`;
  above `WATCH_LIMIT` nothing is watched. Opt-in `DPRINT_WATCH_DIRECTORIES=1` watches directories instead
  (`watchDirectories`: no lost watches, new files seen, but every event below them).

## `format.ts`

- Scope: `scopeOf` (effective cwd: per session/agent override, else payload `cwd`) and `inScope` (real path strictly
  inside the real cwd, not excluded, not inside `scratchpad_dir`; dangling links rejected); universal-format's path
  exclusions apply. One `DprintLsp` per cwd; the least recently used child is disposed past the child cap.
- `fileWritten` records Edit/Write content per real path, as a digest, only where a config exists.
- `fileChanged` formats a watched file whole on disk unless it is out of scope, oversized, has a lone CR or mixed
  line endings (pure CRLF is formatted on its LF view), equals the recorded content, is gitignored, or is tracked and
  unchanged against the index. One `git status` decides (`!!` or empty output skips; a git failure means format). Own
  `dprint lsp`; a bounded number of events run at once, a bounded number queue, the rest are dropped with a stderr line.
- `formatPre`: config gate first (no `dprint lsp` spawn without a config in the effective cwd or an ancestor), then the
  size guard (`MAX_CHANGED_BYTES`), then `git check-ignore` (ignored files skipped). Write and Edit: whole-file
  `formatting` of the resulting text.
- `lineDiff` and `trimToEdit`: keep only hunks touching the edit, widen `old_string` until it is unique (bounded
  single-line steps, then one jump to the widest span). Accepted only if the trimmed file formats like the intended
  edit; skipped when the trim reproduces dprint's output, else one extra whole-document `formatting`. CRLF files are
  trimmed on their LF view.
- `formatOnDisk` is the shared core of `fileChanged` (queues the file for `drainNotices`) and `bashFinished` (reports
  directly, so the Bash result is not stale). `bashFinished` formats every file of the cached watch list (first read
  started by `bash_started`; failed and empty reads retried after a delay) whose mtime is after the Bash start minus a
  slack; on slow file systems (stat sample) the slack is wider and only files `git status` reports are stat-ed. The
  digest in `written` makes the later FileChanged a no-op. FileChanged, `file_written` and `drain_notices` are keyed by
  `overrideKey`, the Bash start by `bashKey` (plus `tool_use_id`; stale entries pruned by age).
