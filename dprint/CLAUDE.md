# dprint

Plugin with one model-invocable skill `init-dprint` (`plugin/skills/init-dprint/SKILL.md`) and one PreToolUse
format hook.

Skill: two zero-dep scripts and one data file, all in `plugin/skills/init-dprint/`:

- `check-dprint.mjs`: dprint detection and minimum-version check (contract: `check-dprint.reference.md`).
- `scan-plugins.mjs`: read-only scan of the project's file types against its dprint config (contract:
  `scan-plugins.reference.md`).
- `dprint-plugins.json`: hand-written plugin reference data read by `scan-plugins.mjs`. It is **not** build
  output; edit it in place.

Hook: `plugin/hooks/hooks.json` (hand-written) wires PreToolUse `Write|Edit` as an `mcp_tool` hook to tool
`format_pre` of the MCP server `dprint-hooks` (`plugin/.mcp.json`, hand-written, `command: node`). The server is
`plugin/mcp/` (zero-dep):

- `server.mjs`: MCP stdio loop (newline-delimited JSON-RPC), tools `format_pre`, `cwd_changed` (CwdChanged hook)
  and `worktree_entered` (PostToolUse EnterWorktree hook).
- `lsp.mjs`: `dprint lsp` client (one lazily spawned child, Content-Length JSON-RPC, 30 s request timeout,
  respawn after a crash, `applyTextEdits`). Needs dprint >= 0.50 (`findDprint` from
  `skills/init-dprint/find-dprint.mjs`: `PATH`, then `~/.dprint/bin`).
- `format.mjs`: `formatPre` (Write: `formatting`; Edit: `rangeFormatting` over the edited lines, whole-file
  `formatting` on a JSON-RPC error), `lineDiff` and `trimToEdit` (keep only hunks touching the edit, widen
  `old_string` until it is unique), one `DprintLsp` per cwd, per session/agent cwd overrides, and universal-format's
  path exclusions. Every failure returns `{}` (fail open), including a diff above the size guard.

`check-dprint.mjs`, `find-dprint.mjs`, `scan-plugins.mjs`, `plugin/mcp/*.mjs` and `plugin/.claude-plugin/plugin.json` are **build
output** (`pnpm build`) of `src/skills/init-dprint/{check-dprint,find-dprint,scan-plugins}.mts`,
`src/mcp/{server,lsp,format}.mts` and `plugin.json`. Do not edit them here.

## Sources vs. build output

- `src/**/*.{mts,ts}` are written for humans: every function, method, class, type, type member and
  module-level constant carries a TSDoc comment (`@param name - text`, `@returns`, `@remarks`, one blank line
  before the first tag). `pnpm lint` (ESLint + typescript-eslint, `eslint-plugin-tsdoc`, `eslint-plugin-jsdoc`;
  config `eslint.config.mjs`) enforces it; CI runs it. `plugin/` is ignored by the linter.
- `pnpm build` compiles with `tsc` (`.mts` → `.mjs`, `.ts` → `.js`) and then minifies every emitted file with
  terser: no comments, mangled locals, shebang and export names kept. The output is optimized for size and
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
