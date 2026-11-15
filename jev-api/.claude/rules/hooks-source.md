---
paths:
  - "src/hooks/**/*.ts"
  - "tests/register.test.ts"
  - "tests/build-lib.test.ts"
---

# jev-api hooks sources

Each module's header comment says what it holds; module history is in `docs/tasks/` (F02, F16, F17 registration; F21 module split).

## Build and bundle

- Only `register.mjs` is in `hooks.json`. It stays readable (unminified, unmangled): Claude Code's static check reads it.
- `package.json` `pluginBuild.bundleHooksLib` makes `development/scripts/build-plugin.ts` bundle every other `hooks/*.ts` into one `plugin/hooks/lib.mjs` (compressed, whitespace removed, not mangled so `$` stays spelled) and point the entry's imports at it. Therefore:
  - sources import each other as `./x.js`;
  - top-level names stay unique across files;
  - no module keeps state at module level: the test kit reloads only `register.mjs` per test.
- A hooks module may import from outside `hooks/` (`src/shared/http.ts`, pure, also imported by the MCP server), also through `lib.mjs`.

## Hooks

- Three matcher-less hooks: `session.start`, `tool.call`, `tool.check` (the last one: `.claude/rules/http-mcp-server.md`).
- `session.start` registers the four tools (a failed one is logged via `$.ui.log`) and records the name the engine returned for each (only in the `mcp__<plugin>__<type>` form) next to the default `mcp__jev-api__<type>` names.
- `tool.call` answers those names and passes every other tool to `next(e)`.

## Registration (`registry.ts`)

- `register(on)` has no `$`, so the tools cannot register at module load: `ensureTools($, st, ms)` runs in `session.start` and, best effort, at the start of `tool.call` (a call before `session.start` still registers). Tools stay deferred (MCP-style, ToolSearch).
- A tool whose `$.tool.register` failed stays in `missing`; the next hook (`session.start` or an owned call) registers only those again.
- Registration is a state per tool (`RegState`, `ensureTools`): a tool refused again is retried once at once, then after 5 s, 10 s, ... (max 5 min), and logged once.
- The wait for a registration is bounded (1 s in an owned call, 5 s in `session.start`) and paid once per hanging tool: it is then `stuck`, and other tools and later calls do not wait for it. A registration that never answers does not hold a call.

## Call lifecycle

- The Haiku call carries the dispatch's abort signal.
- An invalid call is answered before any env read; an already abandoned call sends nothing; the abort listeners are removed when a call settles.
