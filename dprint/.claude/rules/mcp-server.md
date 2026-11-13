---
paths:
  - "src/mcp/**"
  - "plugin/mcp/**"
  - "plugin/.mcp.json"
  - "tests/mcp-*.test.mts"
---

# dprint-hooks MCP server

`plugin/hooks/hooks.json` (hand-written) wires PreToolUse `Write|Edit` as an `mcp_tool` hook to tool `format_pre` of
the MCP server `dprint-hooks` (`plugin/.mcp.json`, hand-written, `command: node`), plus the other tools below.
`findDprint`/`findConfig` resolution: see the skill-scripts rule. Limits and timeouts are named constants in the
sources; this rule records behaviour and constraints only.

## Constraints

- Every failure returns `{}` (fail open), including a diff above the size guard.
- `watch-paths.mts` and `watch-list.mts` must not import `server.mts` (`watch-list.mts` not `format.mts` either):
  `watch-paths` runs as its own `command` hook.
- Scope never uses `process.cwd()`.
- Needs dprint >= 0.50.
- Every tool in `tools/list` carries `_meta: { ui: { visibility: ["app"] } }` (`HOOK_ONLY_META`): the model never sees
  the tools (ToolSearch finds none), `mcp_tool` hooks still call them. Live-checked on 2.1.323 with a local stdio
  server (a deny rule behaves the same but a plugin cannot ship one); the docs name the field only for cloud sessions,
  so `mcp-server.test.mts` pins it.
- The server is dual-era (rule `.claude/rules/mcp-dual-era.md` at the repo root): 2025-11-25 `initialize`, and 2026-07-28 `server/discover` plus modern `ping`/`tools/list`/`tools/call` with `resultType`, `ttlMs`/`cacheScope`, serverInfo meta; an unsupported `_meta` version answers `-32022`. No tasks (every tool is a short hook call). `mcp-server.test.mts` covers both eras.

## Modules

- `server.mts`: MCP stdio loop (newline-delimited JSON-RPC), tools `format_pre`, `cwd_changed` (CwdChanged hook),
  `worktree_entered` and `worktree_exited` (PostToolUse EnterWorktree/ExitWorktree hooks), `file_written`
  (PostToolUse Write|Edit), `file_changed` (FileChanged), `bash_started`/`bash_finished` (PreToolUse/PostToolUse
  `Bash`) and `drain_notices` (PreToolUse `Edit|Write|Read|Bash|MultiEdit`, UserPromptSubmit). Typed by `HookInputs`
  (see the hook-inputs rule).
- `lsp.mts`: `dprint lsp` client: one lazily spawned child per cwd, Content-Length JSON-RPC, a request timeout
  (constructor option `timeoutMs`, tests only), a cooldown after a request timeout during which formats of that
  document fail at once, a per-client pause before `findDprint` is retried after dprint was not found, stdout of a
  replaced child ignored, respawn after a crash, `applyTextEdits`.
- `watch-list.mts`: `dprintFilePaths` (`dprint file-paths` + `WATCH_LIMIT`), shared by `watch-paths.mts` and
  `bashFinished`.
- `watch-paths.mts`: `command` hook for SessionStart and CwdChanged (SessionStart `mcp_tool` hooks are skipped while
  the server connects). Runs `dprint file-paths` (fallback `output-file-paths` for dprint 0.50-0.54) in the cwd,
  filters through `inScope`, caps at `WATCH_LIMIT` (above it nothing is watched) and prints
  `hookSpecificOutput.watchPaths`.

## `format.mts`

- Scope: `scopeOf` (effective cwd: per session/agent override, else payload `cwd`) and `inScope` (real path strictly
  inside the real cwd, not excluded, not inside `scratchpad_dir`; dangling links rejected); universal-format's path
  exclusions apply. One `DprintLsp` per cwd; the least recently used child is disposed past the child cap.
- `fileWritten` records Edit/Write content per real path, as a SHA-256 digest, only where a config exists.
- `fileChanged` formats a watched file whole on disk unless it is out of scope, has a lone CR (CRLF files are
  formatted on their LF view), equals the recorded content, is gitignored, or is tracked and unchanged against the git
  index. One `git --no-optional-locks status --porcelain --untracked-files=normal --ignored=matching` decides: `!!` or
  empty output skips; a git failure means format. It uses its own `dprint lsp`, runs a bounded number of events at once
  (git + dprint), queues a bounded number more and drops beyond that with a stderr line, and skips oversized files.
- `formatPre`: config gate first (`{}` and no `dprint lsp` spawn unless `findConfig` finds a config in the effective
  cwd or an ancestor), then the gitignore check (`git check-ignore`; Write/Edit skip ignored files). Write: whole-file
  `formatting`; Edit: whole-file `formatting` of the edited text.
- `lineDiff` and `trimToEdit`: keep only hunks touching the edit, widen `old_string` until it is unique (bounded
  single-line widening steps, then one jump to the widest span). Accepted only if the trimmed file formats like the
  intended edit; skipped when the trim reproduces dprint's output, else one extra whole-document `formatting`. CRLF
  files are trimmed on their LF view.
- `formatOnDisk` is the shared core of `fileChanged` (queues the file for `drainNotices`) and `bashFinished` (reports
  directly; it formats every cached watch-list file with mtime > `bash_started` − 1 s, so the Bash result is not
  stale; the digest in `written` makes the later FileChanged a no-op). All three are keyed by `overrideKey`.
