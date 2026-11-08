# CLAUDE.md — jevfort

Mods-API plugin: one TypeScript function-hooks module and its pure helper modules, the `/jev` command, no skills,
agents, command hooks or MCP servers. A port of nim-f/jev-pilot (https://github.com/nim-f/jev-pilot, version 0.5.0,
commit 90cc1f1, directory `hooks/`) into this repository's layout. Upstream has no LICENSE file; it is credited in
`plugin/README.md`.

## Differences from upstream

- No shadow mode: `mode` is `active` or `off`. `/jev shadow` is gone, every "apply only when active" guard is
  unconditional, the report has no shadow rows. `Entry.applied` stays and means "acted" vs "pass" (status suffix
  ` (pass)`). A stored legacy `mode: "shadow"` falls back to the configured mode, a configured `"shadow"` to `active`.
- The endpoint is read per request from the `JEV_URL` environment variable (`$.env.get`), trimmed; unset or blank
  means `https://api.typesafe.ai/v1/systemone` (`DEFAULT_JEV_URL` in `jev.mts`). `http:` and `https:` are accepted for
  any host; any other value is a logged Jev error (`JEV_URL must be an http(s) URL`), no request is sent and Claude
  proceeds unchanged. No `userConfig` entry for the URL.
- Every `$` use and every `on(...)` call lives in `src/hooks/register.mts` (engine rule, see
  `.claude/rules/register-hooks.md`); upstream's `askJev`, `record`, `readLog`, `clearLog`, `stats`, `readTurn`,
  `previousReply`, `buildCandidates`, `packageRunner`, `summarizeResult`, `skillOptions`, `currentMode` and the
  `register*` functions of `prompt`/`agents`/`compact`/`view` moved there. Upstream `mode.ts` and `view.ts` have no
  file. The other `src/hooks/*.mts` are pure.
- No `claude-code` type import: `$`, events and `on` are typed structurally at the top of `register.mts`.
- Upstream blocks `Stop`. Here the done check runs on `turn.complete` (main-loop turns ending with `reason: "answer"`)
  and sends one framed follow-up message (`DONE_PROMPT`) through `$.prompt.submit`, because `cc-plugin-sec-default`
  skips user-tier `classic.Stop` hooks. The unfinished answer stays visible. Background Bash work is not detected,
  only subagents (`$.agent.list()`).

## Layout

`package.json` is the only manifest source (`claudePlugin.userConfig`, 18 options). `pnpm build` compiles
`src/**/*.mts` to `plugin/**/*.mjs` (`plugin/hooks/` unmangled and uncompressed) and generates
`plugin/.claude-plugin/plugin.json`. Tests (`tests/*.test.mts`, vitest + `claude-engine-vitest`) run against `plugin/`.

## Commands

```bash
pnpm --filter jevfort build
pnpm --filter jevfort test
pnpm lint
claude plugin validate jevfort/plugin
```
