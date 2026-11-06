# dprint

Plugin parts, each with its own notes (loaded when you work there):

- Skill `dprint` (`plugin/skills/dprint/SKILL.md`; actions `init`, `check`, `fmt`, no argument = `fmt`), scripts in
  `src/skills/dprint/`: see `src/skills/dprint/CLAUDE.md` (also where `findDprint`/`findConfig` resolution is stated).
- MCP server `dprint-hooks` (format, cwd-tracking and FileChanged hooks, watch-list `command` hook) and the
  `scripts/hooks.mts` hook-input contract: see `src/mcp/CLAUDE.md`.
- Function-hooks module `notice` (toast when a dprint config exists but dprint cannot run): see `src/hooks/CLAUDE.md`.

## Pitfalls

- `plugin/skills/dprint/dprint-plugins.json` is hand-written reference data, **not** build output: edit it in place
  (see below). Every `plugin/**/*.mjs` is build output; debug against `src/`, the output is minified.
- `plugin/hooks/hooks.json` is hand-written and validated by `scripts/hooks.mts`, which generates
  `src/mcp/hook-inputs.d.mts`: never edit that `.d.mts` by hand (details in `src/mcp/CLAUDE.md`).
- `src/mcp/watch-paths.mts` must not import `server.mts` (it runs as its own `command` hook).
- `src/hooks/notice.mts` imports nothing: it inlines copies of `MIN_VERSION`, check-dprint's version regex and
  `CONFIG_NAMES`; tests fail when a copy drifts, so change both places.

## Tests

`pnpm --filter dprint test` runs vitest over `tests/*.test.mts` against the built `plugin/`; the shared config sets
`testTimeout: 30_000` for the files that spawn processes. `tests/notice.test.mts` drives the built hooks module through
`createKit` from `claude-engine-vitest` (stubs for `fs.exists`, `session.cwd`, `env.get`, `process.run`, `ui.toast`;
`mock.clock(on).settle()` waits for the detached check).

`MIN_VERSION` is defined only in the `.mts` source. Changing it: edit there, update the
"Minimum dprint version" line in `README.md`, rebuild. Tests read the value from that source (the built
script is minified). `src/hooks/notice.mts` holds a copy; `tests/notice.test.mts` fails when the two differ, so change both.

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
