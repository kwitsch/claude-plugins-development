# statusbar

Mod-only plugin: `src/hooks/register.ts` (every hook and every `$` use) and the pure `src/hooks/line.ts` (`statusLine`, a 1:1 port of the user's `statusline-command.sh`; `gitBranch`, the `git -C <cwd>` lookup through `$.fs`). No bin, MCP server, cache file, settings access or `userConfig`. Decisions, rejected alternatives and live results: [drawing-the-status-line](../development/wiki/plugins/statusbar/design/drawing-the-status-line.md).

## Constraints

- `statusLine` stays identical to the script's output: glyphs, `\x1b[0;3Xm` / `\x1b[0m` codes, thresholds, `" | "`, round half to even; any change needs a row in `tests/line.test.ts`.
- The `ui.render` hook (`{ component: "StatusLine" }`) makes no `$` call: `next(e)` unchanged until the first line exists, then `next` with only `props.text` replaced. No own tree, no append, no `$.ui.status`.
- The 10 s `$.clock.every(10_000, ...)` timer is armed only in `session.start`, after cancelling the previous one.
- `gitBranch` gets closures over `$.fs.exists` / `$.fs.read`, never `$.fs` itself (the engine rejects a bare `$.<noun>` value).
- Every `$` call after `next` is caught; `refresh` keeps the last line on failure and skips while one runs (`busy`). No `$.process.run`, `$.tool.call` or `$.http.fetch`.

## Tests

- `tests/line.test.ts`: formatter and git-lookup rows (pure, no kit).
- `tests/register.test.ts`: `claude-engine-vitest` bound to `src/hooks/register.ts`; the StatusLine site is mounted with `props.text: "cmd"` and a stub beneath records the text it gets.
- `claude-tests/register.test.ts`: one test per registered event on the built `register.js` (`pnpm --filter statusbar test:plugin`, needs `claude`).
