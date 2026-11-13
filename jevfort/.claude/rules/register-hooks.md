---
paths:
  - "src/hooks/register.mts"
  - "tests/register.test.mts"
  - "tests/phase3.test.mts"
  - "plugin/hooks/hooks.json"
---

# `register.mts`: hooks, `$` use and engine pitfalls

`plugin/hooks/hooks.json` (hand-written) is exactly `{"modules": ["./register.mjs"]}`. `src/hooks/register.mts` holds
every hook and every `$` use and imports the pure modules `./jev.mjs`, `./policy.mjs`, `./candidates.mjs`,
`./context.mjs`, `./cache.mjs`, `./log.mjs`, `./report.mjs`, `./prompt.mjs`, `./agents.mjs`, `./compact.mjs`, `./summarize.mjs`.
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
  `session.start`, `session.end`, `prompt.submit`, `agent.offer` and `session.compact` have one each; `command.run` carries a
  matcher; `ui.render` has two matcher hooks (`{ component: "CommandOutput", props: { command: "jev" } }` for the
  `/jev` output, `{ component: "AbovePrompt" }` for the effort band).
- Jev is asked only through the jev-api plugin's tool `mcp__jev-api__batch`: `askJev` raises one
  `$.tool.call({ tool: "mcp__jev-api__batch", state, questions, timeout: apiTimeoutS })` (`state` is `JSON.stringify` text, `questions` the
  `Question` objects in id order, `timeout` in seconds equal to the budget, 14 s just under 15 s on the Haiku path), raced against the budget (`TIMEOUT_MS` 4 s, `COMPACT_TIMEOUT_MS` 9 s for the compaction ranking, `HAIKU_TIMEOUT_MS` 15 s without Jev access); a `{ deny }`, `isError`, a rejection, a result that is not
  a JSON array with one answer per question that has the asked type and the fields jevfort reads (`isAnswer`), or the timeout fails the whole `askJev` (`{ ok: false }`,
  never a throw). The engine
  member is typed `tool.call(input): Promise<ToolResult>`; there is no `$.http` use.
- Readiness guard: every hook except `session.start`, `session.end`, `session.compact`, the `/jev` `command.run` and
  both `ui.render` hooks starts with `if ((await jevMissing($)).length) return next(e);` (`return yield* next(e)` in
  `turn.step`, whose `cacheWatch` and `turnRunning` work comes before it; `turn.complete` clears `turnRunning` before
  it; `session.compact` guards only the Jev ranking inside `withJevRanking`); `tool.call` and `tool.check` handle
  `ESTIMATE_TOOL` before it. `jevMissing`, `jevApply` and their state `jevTools`/`jevState` are
  module level (`$` may only be passed to top-level functions). `jevTools` is one `$.tool.list()` per turn, shared by
  concurrent hooks: a main-loop `turn.complete` (no `agentId`) drops it after its own guard listing (no engine event reports a changed tool
  list), `session.start` drops it right after `next(e)` and lists the session's baseline (a jevfort hook raised inside
  `next(e)` may have cached a listing from before jev-api registered). A rejected or malformed listing counts as the
  tool missing. `jevApply` applies a listing whose missing set differs from `jevState` once: going inactive logs
  `inactive: jev-api tools missing (...)`, becoming ready registers `estimate_effort` (`estimateRegistered`: a failed registration is retried by the next
  listing, a registered one never again; reset at `session.start`), both call
  `$.ui.invalidate("ui.render")`. `jevState` is unset from the start of `session.start` until its baseline, so a
  listing raised beneath `next(e)` applies nothing. A new hook needs the guard too; `session.start` must not start with
  it (beneath it, jev-api has not registered batch yet). The render hooks read `jevState` instead (no `$.tool`, `$.store`, `record` or `jevMissing` call while
  drawing).
- `jevApply` registers the `estimate_effort` tool with `$.tool.register(ESTIMATE_SPEC)` whatever `routing` says (a
  throw is logged as `kind: "error"`) when the jev-api tools become listed: at `session.start`'s baseline after
  `next(e)` (jev-api registers its tools in its own `session.start`) or at a later turn's listing. There is no
  unregister and a registered tool that no hook answers fails, so the unmatched `tool.call` hook answers
  `mcp__jevfort__estimate_effort` before the readiness guard and never calls `next(e)`: `{ result }` (the JSON
  estimate; while inactive `askJev` fails and it is `defaultEffort` with source `fallback`) or, on invalid input,
  `{ isError: true, result }` without a Jev request; `tool.check` approves it before the guard (a settings deny still
  wins). Calls are logged as kind `estimate`.
- Effort band: the `ui.render` hook with matcher `{ component: "AbovePrompt" }` draws `Box`/`Text`/`Button` from
  `$.ui.resolve(e)` (detached factories) out of the closure state `band` (written at main-loop step 0 in `turn.step`:
  `configured` = step-0 `e.effort`, `chosen` = the estimate or held effort) and `autoOff` (flipped by the Button
  `key: "auto"`, reset at `session.start` and `session.end`). The effort row is hidden with `routing: "off"` and while
  `jevState !== ""`; then the hook draws only the cache countdown (above `await next(e)`, in a column Box, so another
  plugin's band beneath survives) or, without a countdown, passes; it always passes while `e.props.hasSurvey`.
  `onPress` only flips the flag and calls `$.ui.invalidate` (no storage call; it runs after the frame, so a throw sets `bandStale` and the next applied listing redraws). While `autoOff`,
  the step-0 effort block (first-turn record, estimate, hold) is skipped.
- Cache countdown / auto-compact / Haiku compaction (see `CLAUDE.md`): `turn.step` wraps `next` in `cacheWatch`
  (passes chunks, reads the result's `usage` in a try/catch), `turn.complete` clears `turnRunning` before its readiness
  guard, the `session.compact` hook is registered whatever `compaction` says (only the Jev ranking honours it: a
  closure const) and has no guard of its own (only `withJevRanking` checks readiness). The cache work in `turn.step`
  and `turn.complete` comes before their readiness guard, which stays: do not remove it. The `AbovePrompt` hook shows the countdown even without the
  effort row. `$.clock.every` is started in `session.start` (the engine does not wait for the callback: ticks
  overlap); `session.end` (raised for /clear and /resume, where `session.start` is not) resets the conversation state.
  `cacheTick` calls `$.ui.invalidate` through `showMinutes` in try/catch, `$.command.run` for `/compact` (rejects are
  said with `$.ui.status`) and reads `$.session.usage()`; none of these runs in a hook frame.
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
kit resolves a mod's `$.tool.call` to the stub's `value` and rejects with a bare `{ deny }`, while the real engine
resolves `{ deny }` (typings), so the fake answers a batch call with `{ value: { result: "<JSON array of answers>" } }`
or `{ value: { deny: "batch: <reason>" } }` and passes every other tool on with `next(e)`. It records each batch question on its own (with its `type`), so assertions read per
question. Batch questions carry no id: the fake finds it by the `instructions` text.
