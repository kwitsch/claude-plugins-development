# dprint-hooks MCP server

`plugin/hooks/hooks.json` (hand-written) wires PreToolUse `Write|Edit` as an `mcp_tool` hook to tool `format_pre` of
the MCP server `dprint-hooks` (`plugin/.mcp.json`, hand-written, `command: node`), plus the other tools below.
`findDprint`/`findConfig` resolution: see `../skills/dprint/CLAUDE.md`.

- `server.mts`: MCP stdio loop (newline-delimited JSON-RPC), tools `format_pre`, `cwd_changed` (CwdChanged hook),
  `worktree_entered` and `worktree_exited` (PostToolUse EnterWorktree/ExitWorktree hooks), `file_written`
  (PostToolUse Write|Edit), `file_changed` (FileChanged), `bash_started`/`bash_finished` (PreToolUse/PostToolUse
  `Bash`) and `drain_notices` (PreToolUse `Edit|Write|Read|Bash|MultiEdit`, UserPromptSubmit).
- `lsp.mts`: `dprint lsp` client (one lazily spawned child per cwd, Content-Length JSON-RPC, 30 s request timeout
  (constructor option `timeoutMs`, tests only), a 60 s cooldown after a request timeout during which formats of that
  document fail at once, a 30 s per-client pause before `findDprint` is retried after dprint was not found, stdout of a
  replaced child ignored, respawn after a crash, `applyTextEdits`). Needs dprint >= 0.50.
- `format.mts`: scope via `scopeOf` (effective cwd: override, else payload `cwd`, never `process.cwd()`) and `inScope`
  (real path strictly inside the real cwd, not excluded, not inside `scratchpad_dir`; dangling links rejected);
  `fileWritten` records Edit/Write content per real path; `fileChanged` formats a watched file whole on disk unless it
  is out of scope, has a lone CR (CRLF files are formatted on their LF view), equals the recorded content (a SHA-256
  digest; `fileWritten` records only where a config exists), is gitignored, or is tracked and unchanged against the
  git index (a single `git --no-optional-locks status --porcelain --untracked-files=normal --ignored=matching`: `!!` or
  empty output skips; git failure means format); it uses its own `dprint lsp`, runs at most 8 events at once (git +
  dprint), queues up to 1000 more and drops beyond that with a stderr line; skips files above 1 MiB; at most 8
  `dprint lsp` children live, the least recently used is disposed; `formatPre` (config gate first, then the gitignore
  check (`git check-ignore`; Write/Edit skip ignored files): `{}` and no `dprint lsp` spawn unless `findConfig` finds a
  config; Write: `formatting`; Edit: whole-file `formatting` of the edited text), `lineDiff` and `trimToEdit` (keep
  only hunks touching the edit, widen `old_string` until it is unique, at most 1000 single-line widening steps, then
  one jump to the widest span; accepted only if the trimmed file formats like the intended edit, skipped when the trim
  reproduces dprint's output, else one extra whole-document `formatting`; CRLF files are trimmed on their LF view), one
  `DprintLsp` per cwd, per session/agent cwd overrides, and universal-format's path exclusions. `formatOnDisk` is the
  shared core of `fileChanged` (queues the file for `drainNotices`) and `bashFinished` (reports directly; it formats
  every cached watch-list file with mtime > `bash_started` − 1 s, so the Bash result is not stale; the digest in
  `written` makes the later FileChanged a no-op); all three keyed by `overrideKey`. Every failure returns `{}` (fail
  open), including a diff above the size guard.
- `watch-list.mts`: `dprintFilePaths` (`dprint file-paths` + `WATCH_LIMIT`), shared by `watch-paths.mts` and
  `bashFinished`; imports neither `server.mts` nor `format.mts`.
- `watch-paths.mts`: `command` hook for SessionStart and CwdChanged (SessionStart `mcp_tool` hooks are skipped while
  the server connects). Runs `dprint file-paths` (fallback `output-file-paths` for dprint 0.50-0.54) in the cwd,
  filters through `inScope`, caps at `WATCH_LIMIT` (5000; above it nothing is watched) and prints
  `hookSpecificOutput.watchPaths`. Must not import `server.mts`.

## Hook-input contract (`hook-inputs.d.mts`)

`plugin/hooks/hooks.json` is the hook-input contract. `../../scripts/hooks.mts` validates it (`mcp_tool` hooks, plus
`command` hooks (non-empty `command`, timeout checked, no input, no generated types), `server` =
`plugin:dprint:<.mcp.json key>`, every `${…}` placeholder a real input field of its event and, for `Write`/`Edit`
matchers, of those tools, one input shape per tool) and generates `hook-inputs.d.mts` (one interface per tool plus the
`HookInputs` map) from the `input` templates. `server.mts` types its tool table by `HookInputs`, so a tool missing on
either side is a compile error. `pnpm build` regenerates the file; `pnpm --filter dprint lint` runs
`scripts/hooks.mts --check` and fails while it is stale. Never edit the `.d.mts` by hand. A new hook event needs its
input fields in `EVENT_FIELDS` there. It validates only the `hooks` map, not `modules`.
