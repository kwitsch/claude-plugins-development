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
  `tool.call` has one unmatched hook (answers the `estimate_effort` tool, outcome of Jev's own calls, skill
  blocklist) plus one with the matcher `{ tool: "Agent" }`; `turn.step`, `tool.check`, `turn.complete`,
  `session.start`, `prompt.submit`, `agent.offer` and `session.compact` have one each; `command.run` and `ui.render`
  carry matchers.
- Jev is asked only through the jev-api plugin's tool `mcp__jev-api__batch`: `askJev` raises one
  `$.tool.call({ tool: "mcp__jev-api__batch", state, questions })` (`state` is `JSON.stringify` text, `questions` the
  `Question` objects in id order), raced against `TIMEOUT_MS`; a `{ deny }`, `isError`, a rejection, a result that is not
  a JSON array with one answer of the asked type per question, or the timeout fails the whole `askJev` (`{ ok: false }`,
  never a throw). The engine
  member is typed `tool.call(input): Promise<ToolResult>`; there is no `$.http` use.
- Readiness guard: every hook except the `/jev` `command.run` and `ui.render` hooks starts with
  `if ((await jevMissing($)).length) return next(e);` (`return yield* next(e)` in `turn.step`). `jevMissing` and its
  cache `jevTools` are module level (`$` may only be passed to top-level functions): one `$.tool.list()` per session,
  reset at `session.start`, a rejected or malformed listing counts as the tool missing. A new hook needs the guard too.
- `session.start` registers the `estimate_effort` tool with `$.tool.register(ESTIMATE_SPEC)` whatever `routing`
  says (a throw is logged as `kind: "error"`), but only when the jev-api tools are listed: it checks `jevMissing($)`
  after `next(e)` (jev-api registers its tools in its own `session.start`) and otherwise logs `inactive: jev-api tools missing (...)` and registers nothing. A registered tool that no hook answers fails, so the unmatched
  `tool.call` hook answers `mcp__jevfort__estimate_effort` itself and never calls `next(e)`: `{ result }` (the JSON
  estimate) or, on invalid input, `{ isError: true, result }` without a Jev request. Calls are logged as kind `estimate`.
- `tool.call` failure is `isError: true` or `deny: string`; there is no `exitCode`.
- `turn.step` `usage` may be `null`; `command.run` returning `{}` prints no row and records no model context.
- `cc-plugin-sec-default` skips every user-tier `prompt.compose`/`prompt.section`/`prompt.context` hook, so the mod
  registers none of them; the prompt classifier uses `prompt.submit` and adds `context` entries. It also passes
  `classic.Stop` on past every user-tier hook (notice `its classic.Stop hook was skipped`), so the done check runs in
  `turn.complete` and continues with an unawaited `$.prompt.submit({ text: DONE_PROMPT })`, exempting the next
  main-loop turn via `donePending`.

## Storage calls must run in-frame

Every mod-side storage (`$.mcp.call`) call must be awaited by a running hook of this module (live on 2.1.296):
core routes `$.mcp.call` through `$.tool.call` and its permission check, although the typings promise no prompt. A
plugin's own hooks see a call it raises only while one of its hooks runs; a call raised after the hook returned (an
unawaited chain, a `$.clock.every` callback) skips them, so in `default` mode the user gets a permission dialog per
call and a headless session denies it. jevfort uses `$.store`, `$.tool.call` (jev-api's batch tool) and `$.fs`, and every
`askJev` is awaited in-frame (also the `measure` promise of `turn.step`, awaited before the hook returns). Every
`record(...)` is awaited inside its hook for the same reason.

## Tests: the jev-api fake

`tests/register.test.mts` and `tests/phase3.test.mts` stub `tool.list` (jev-api's batch tool) and `tool.call`. The
kit resolves a mod's `$.tool.call` to the stub's `value` and rejects with its `deny`, so the fake answers a batch
call with `{ value: { result: "<JSON array of answers>" } }` or `{ deny: "batch: <reason>" }` and passes every other
tool on with `next(e)`. It records each batch question on its own (with its `type`), so assertions read per
question. Batch questions carry no id: the fake finds it by the `instructions` text.
