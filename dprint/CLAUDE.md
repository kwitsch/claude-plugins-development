# dprint

Plugin parts, each with its own path-scoped rule in `.claude/rules/` (loaded when you work on matching files):

- Skill `dprint` (`plugin/skills/dprint/SKILL.md`; actions `init`, `check`, `fmt`, no argument = `fmt`), scripts in
  `src/skills/dprint/`: `skill-scripts.md` (also `findDprint`/`findConfig` resolution, changing `MIN_VERSION`,
  refreshing `dprint-plugins.json`).
- MCP server `dprint-hooks` (format, cwd-tracking and FileChanged hooks, watch-list `command` hook) in `src/mcp/`:
  `mcp-server.md`; the `hooks.json` → `hook-inputs.d.ts` contract of `scripts/hooks.mts`: `hook-inputs.md`.
- Function-hooks module `register` (toast when a dprint config exists but dprint cannot run) in `src/hooks/` (entry `register.ts`, helpers bundled into `lib.mjs`):
  `notice-hook.md`.

## Tests

The shared vitest config sets `testTimeout: 30_000` for the files that spawn processes.

`tests/skill.test.ts` pins the `package.json` `description`: line 3 of `plugin/README.md` must equal it, and regexes fix its phrases (the toast clause, `needs node and dprint >= 0.50 on PATH or in ~/.dprint/bin, or npx).`). A changed description, also a new `MIN_VERSION` in it, needs the README line and those regexes updated.
