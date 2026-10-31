# dprint

Plugin with one model-invocable skill `dprint` (`plugin/skills/dprint/SKILL.md`; actions `init`, `check`, `fmt`,
no argument = `fmt`), one PreToolUse format hook, one FileChanged format hook (`file_changed`) with its PostToolUse
`Write|Edit` recorder (`file_written`), three cwd-tracking hooks (CwdChanged, PostToolUse
EnterWorktree/ExitWorktree), one SessionStart/CwdChanged `command` hook that sets the FileChanged watch list
(`plugin/mcp/watch-paths.mjs`) and one Claude Code function-hooks module `plugin/hooks/notice.mjs` (15 s toast when
the working directory has no dprint config).

Skill: three zero-dep scripts (plus the shared `find-dprint.mjs`, `find-config.mjs` and `config-names.mjs`, the six
dprint config file names in `CONFIG_NAMES`) and one data file, all in
`plugin/skills/dprint/`:

- `check-dprint.mjs`: dprint detection and minimum-version check (contract: `check-dprint.reference.md`).
- `scan-plugins.mjs`: read-only scan of the project's file types against its dprint config (contract:
  `scan-plugins.reference.md`).
- `run-dprint.mjs`: check/fmt dispatcher with the not-set-up gate (contract: `run-dprint.reference.md`).
- `dprint-plugins.json`: hand-written plugin reference data read by `scan-plugins.mjs`. It is **not** build
  output; edit it in place.

`find-dprint.mjs` exports `findDprint` (binary: `PATH`, then `~/.dprint/bin`); `find-config.mjs` exports `findConfig`
(first of `CONFIG_NAMES` in a directory or its ancestors, never above the git/worktree root), shared by
`run-dprint.mjs`, `scan-plugins.mjs` and `mcp/format.mjs`.

Hook: `plugin/hooks/hooks.json` (hand-written) wires PreToolUse `Write|Edit` as an `mcp_tool` hook to tool
`format_pre` of the MCP server `dprint-hooks` (`plugin/.mcp.json`, hand-written, `command: node`). The server is
`plugin/mcp/` (zero-dep):

- `server.mjs`: MCP stdio loop (newline-delimited JSON-RPC), tools `format_pre`, `cwd_changed` (CwdChanged hook),
  `worktree_entered` and `worktree_exited` (PostToolUse EnterWorktree/ExitWorktree hooks), `file_written`
  (PostToolUse Write|Edit) and `file_changed` (FileChanged).
- `lsp.mjs`: `dprint lsp` client (one lazily spawned child per cwd, Content-Length JSON-RPC, 30 s request timeout,
  respawn after a crash, `applyTextEdits`). Needs dprint >= 0.50 (`findDprint` from
  `skills/dprint/find-dprint.mjs`: `PATH`, then `~/.dprint/bin`).
- `format.mjs`: scope via `scopeOf` (effective cwd: override, else payload `cwd`, never `process.cwd()`) and
  `inScope` (real path strictly inside the real cwd, not excluded, not inside `scratchpad_dir`; dangling links
  rejected); `fileWritten` records Edit/Write content per real path; `fileChanged` formats a watched file whole on
  disk unless it is out of scope, has a lone CR (CRLF files are formatted on their LF view), equals the recorded content (a SHA-256 digest; `fileWritten` records only where a config exists), or is tracked and unchanged against the git index
  (`git --no-optional-locks status --porcelain --ignored` empty; git failure means format); it uses its own `dprint lsp` and drops events beyond 50 in flight; at most 8 `dprint lsp` children live, the least recently used is disposed; `formatPre` (config gate first: `{}` and no `dprint lsp` spawn unless `findConfig` finds a config in the
  effective cwd or an ancestor (never above the nearest dir holding `.git`: repo root or worktree root); Write: `formatting`; Edit: `rangeFormatting` over the edited lines, whole-file
  `formatting` on a JSON-RPC error), `lineDiff` and `trimToEdit` (keep only hunks touching the edit, widen
  `old_string` until it is unique; accepted only if the trimmed file formats like the intended edit, two extra
  whole-document `formatting` calls; CRLF files are trimmed on their LF view), one `DprintLsp` per cwd, per session/agent cwd overrides, and universal-format's
  path exclusions. Every failure returns `{}` (fail open), including a diff above the size guard.
- `watch-paths.mjs`: `command` hook for SessionStart and CwdChanged (SessionStart `mcp_tool` hooks are skipped while
  the server connects). Runs `dprint file-paths` (fallback `output-file-paths` for dprint 0.50-0.54) in the cwd,
  filters through `inScope`, caps at `WATCH_LIMIT` (5000; above it nothing is watched) and prints
  `hookSpecificOutput.watchPaths`. Must not import `server.mjs`.

Toast: `plugin/hooks/hooks.json` also lists `"modules": ["./notice.mjs"]` (Claude Code function hooks, early-access
API). `notice.mjs` hooks `session.start`, `classic.CwdChanged` and `tool.call` for `EnterWorktree`/`ExitWorktree`,
lets the event run, then checks the resulting cwd (`new_cwd` for CwdChanged, the tool result's `worktreePath`/`restoredCwd` for the
worktree tools, else `$.session.cwd()`) and its ancestors (up to the dir holding `.git`) for the `CONFIG_NAMES` (an inlined copy: the module has no
imports; a test checks it against `config-names.mts`) with `$.fs.exists` detached (errors swallowed), at most one toast
per directory per 15 s, and calls `$.ui.toast(text, { timeoutMs: 15000 })` when none exists. `scripts/hooks.mjs` validates only the
`hooks` map; `claude plugin validate plugin` checks the module and warns "gating hook without .catch" for three of
its hooks (expected: the check is detached with `.catch`).

`check-dprint.mjs`, `config-names.mjs`, `find-config.mjs`, `find-dprint.mjs`, `run-dprint.mjs`, `scan-plugins.mjs`,
`plugin/mcp/*.mjs`, `plugin/hooks/notice.mjs` and `plugin/.claude-plugin/plugin.json` are **build output**
(`pnpm build`) of
`src/skills/dprint/{check-dprint,config-names,find-config,find-dprint,run-dprint,scan-plugins}.mts`,
`src/mcp/{server,lsp,format,watch-paths}.mts`, `src/hooks/notice.mts` and `plugin.json`. Do not edit them here.

## Sources vs. build output

- `src/**/*.{mts,ts}` are written for humans: every function, method, class, type, type member and
  module-level constant carries a TSDoc comment (`@param name - text`, `@returns`, `@remarks`, one blank line
  before the first tag). `pnpm lint` (ESLint + typescript-eslint, `eslint-plugin-tsdoc`, `eslint-plugin-jsdoc`;
  config `eslint.config.mjs`, type-checked rules incl. `no-explicit-any`/`no-unsafe-*`) enforces it; CI runs
  it. `plugin/` is ignored by the linter.
- `plugin/hooks/hooks.json` is the hook-input contract. `scripts/hooks.mjs` validates it (`mcp_tool` hooks, plus
  `command` hooks (non-empty `command`, timeout checked, no input, no generated types), `server` =
  `plugin:dprint:<.mcp.json key>`, every `${…}` placeholder a real input field of its event
  and, for `Write`/`Edit` matchers, of those tools, one input shape per tool) and generates
  `src/mcp/hook-inputs.d.mts` (one interface per tool plus the `HookInputs` map) from the `input` templates.
  `server.mts` types its tool table by `HookInputs`, so a tool missing on either side is a compile error.
  `pnpm build` regenerates the file; `pnpm lint` runs `scripts/hooks.mjs --check` first and fails while it is
  stale. Never edit the `.d.mts` by hand. A new hook event needs its input fields in `EVENT_FIELDS` there.
- `pnpm build` compiles with `tsc` (`.mts` → `.mjs`, `.ts` → `.js`) and then minifies every emitted file with
  terser: no comments, mangled locals, shebang and export names kept. `plugin/hooks/*.mjs` (function-hooks modules) are neither compressed nor mangled: Claude Code's static
  module check needs named hook functions, `$`/`on` spelled as such and no shadowed names. The output is optimized for size and
  load time, not for reading; debug against `src/`.

`MIN_VERSION` is defined only in the `.mts` source. Changing it: edit there, update the
"Minimum dprint version" line in `README.md`, rebuild. Tests read the value from that source (the built
script is minified).

## Refreshing `dprint-plugins.json`

1. Regenerate `plugins` from the `latest` array of `https://plugins.dprint.dev/info.json`, keeping registry order
   (it is the candidate preference order):
   - `id`: the URL path between `https://plugins.dprint.dev/` and `-<version>` (the name `dprint config add` accepts)
   - `npm`: the registry's `npm.name`; omit the key when there is none
   - `extensions`: the registry's `fileExtensions`, lower-cased, deduplicated, without a leading dot; drop dotted
     entries (for example `component.html`)
   - `fileNames`: the registry's `fileNames` verbatim; omit the key when there are none
   - skip entries with neither extensions nor file names (`exec`-only)
   - store no versions or URLs
2. Update `snapshot` to the refresh date (`YYYY-MM-DD`).
3. Run `pnpm --filter dprint test`.
