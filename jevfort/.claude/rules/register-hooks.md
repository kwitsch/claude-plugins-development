---
paths:
  - "src/hooks/register.mts"
  - "tests/register.test.mts"
  - "plugin/hooks/hooks.json"
---

# `register.mts`: hooks, `$` use and engine pitfalls

`plugin/hooks/hooks.json` (hand-written) is exactly `{"modules": ["./register.mjs"]}`. `src/hooks/register.mts` holds
every hook and every `$` use and imports the pure modules `./jev.mjs`, `./policy.mjs`, `./candidates.mjs`,
`./context.mjs`, `./log.mjs`, `./report.mjs`, `./prompt.mjs`, `./agents.mjs`, `./compact.mjs`, `./summarize.mjs`.
Tested by `tests/register.test.mts` (kit-style tests on the workspace package `claude-engine-vitest`). Evidence for
the shapes below: `inline-headroom/docs/claude-code-verification.md`.

## Engine pitfalls (change how the code must be written)

- No `claude-code` type import: the used `$` members and events are typed structurally at the top of the file. No
  `any`, no `import()` (a module holding `import()` does not load).
- The pure modules must never reference `$`: the engine rejects passing the mods API into functions imported from
  another file. It also rejects `$.<noun>` as a bare value (bound, passed or read), so same-file helpers take the
  whole `$` typed `Engine` (`askJev($, …)`, `record($, …)`, `buildCandidates($, …)`).
- One hook per event without a matcher (`registered twice without a matcher` fails validate and test). Hence:
  `tool.call` has one unmatched hook (outcome of Jev's own calls, skill blocklist) plus one with the matcher
  `{ tool: "Agent" }`; `turn.step`, `tool.check`, `classic.Stop`, `turn.complete`, `session.start`, `prompt.submit`,
  `agent.offer` and `session.compact` have one each; `command.run` and `ui.render` carry matchers.
- `tool.call` failure is `isError: true` or `deny: string`; there is no `exitCode`.
- `turn.step` `usage` may be `null`; `command.run` returning `{}` prints no row and records no model context.
- `cc-plugin-sec-default` skips every user-tier `prompt.compose`/`prompt.section`/`prompt.context` hook, so the mod
  registers none of them; the prompt classifier uses `prompt.submit` and adds `context` entries.

## Storage calls must run in-frame

Every mod-side storage (`$.mcp.call`) call must be awaited by a running hook of this module (live on 2.1.296):
core routes `$.mcp.call` through `$.tool.call` and its permission check, although the typings promise no prompt. A
plugin's own hooks see a call it raises only while one of its hooks runs; a call raised after the hook returned (an
unawaited chain, a `$.clock.every` callback) skips them, so in `default` mode the user gets a permission dialog per
call and a headless session denies it. jevfort makes no storage calls today (it uses `$.store`, `$.http.fetch` and
`$.fs`); the rule applies the day it does. Every `record(...)` is awaited inside its hook for the same reason.
