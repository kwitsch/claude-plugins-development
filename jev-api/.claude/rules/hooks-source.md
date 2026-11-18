---
paths:
  - "src/hooks/**/*.ts"
  - "tests/register.test.ts"
  - "tests/build-lib.test.ts"
---

# jev-api hooks sources

Each module's header comment says what it holds; module history is in `development/wiki/plugins/jev-api/tasks/` (F02, F16, F17 registration; F21 module split).

## Build and bundle

- `register.mjs` entry plus `lib.mjs` bundle (`pluginBuild.bundleHooksLib`): root `.claude/rules/hooks-lib-bundle.md` (constraints) and `src-typescript.md` (`./x.js` imports).
- A hooks module may import from outside `hooks/` (`src/shared/http.ts`, pure, also imported by the MCP server), also through `lib.mjs`.

## Hooks

- Three matcher-less hooks: `session.start`, `tool.call`, `tool.check` (the last one: `.claude/rules/http-mcp-server.md`).
- `session.start` registers the `request` tool (a failed registration is logged via `$.ui.log`) and records the name the engine returned (only in the `mcp__<plugin>__request` form) next to the default `mcp__jev-api__request`.
- `tool.call` answers those names.

## Registration (`registry.ts`)

- The tool is registered whatever the Jev variables say (user decision 2026-11-11; it replaced a registration only with a variable set). Who answers without one: `.claude/rules/haiku-fallback.md`.
- `register(on)` has no `$`, so the tools cannot register at module load: `ensureTools($, st, ms)` runs in `session.start` and, best effort, at the start of `tool.call` (a call before `session.start` still registers). Tools stay deferred (MCP-style, ToolSearch).
- A tool whose `$.tool.register` failed stays unregistered (`registered: false`); the next hook (`session.start` or an owned call) registers it again.
- Registration is one state (`RegState`, `ensureTools`): a tool refused again is retried once at once, then after 5 s, 10 s, ... (max 5 min), and logged once.
- The wait for a registration is bounded (1 s in an owned call, 5 s in `session.start`) and paid once per hanging registration: it is then `stuck`, and later calls do not wait for it. A registration that never answers does not hold a call.

## System One questions and answers (`input.ts`, `tools.ts`, `util.ts`)

- The request's `questions` is an object keyed by ids the caller picks, and the answers come back under the same ids: `q0`, `q1`, ... by index (`questionId`; several questions in one request live-verified 2026-11-12).
- The limits follow the live server (probed 2026-11-11, model `d1-3b`), not the public docs: `choice` 1 to 255 options (256: HTTP 400), `score` 2 to 10 levels (1 or 11: HTTP 400; the docs say `minItems` 1).
- The validators are stricter than that server, which also took blank `instructions` and `state` and null `choice` descriptions (same probe): they want non-blank text and string descriptions. A `noul` `criteria` of `{}` passes both.
- A `score` answer is a fractional expected level, with `legend` and `probabilities` keyed by the level index as a string; `choice` `probabilities` are keyed by option name. `ask` checks a Jev answer with `hasAnswerShape` (not the `legend`) and passes it on unchanged.

## Call lifecycle

- The Haiku call carries the dispatch's abort signal.
- An invalid call is answered before any env read; an already abandoned call sends nothing; the abort listeners are removed when a call settles.
