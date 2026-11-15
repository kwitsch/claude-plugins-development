---
paths:
  - "src/hooks/register.ts"
  - "tests/register.test.ts"
  - "tests/phase3.test.ts"
  - "plugin/hooks/hooks.json"
---

# `register.ts`: hooks, `$` use and engine pitfalls

`plugin/hooks/hooks.json` (hand-written) is exactly `{"modules": ["./register.mjs"]}`. `src/hooks/register.ts` holds
every hook and every `$` use and imports the pure modules `./jev.js`, `./policy.js`, `./candidates.js`,
`./context.js`, `./cache.js`, `./agents.js`, `./compact.js`, `./summarize.js` (bundled into `plugin/hooks/lib.mjs`).
Tested by `tests/register.test.ts`. Evidence for
the shapes below: `inline-headroom/docs/claude-code-verification.md`.

## Engine pitfalls (change how the code must be written)

- The general rules (no `any`/`import()`, `$` only in `register.ts`, no bare `$.<noun>`, one matcher-less hook per
  event): root `.claude/rules/claude-code-hook-facts.md`. Same-file helpers take the whole `$` typed `Engine`
  (`askJev($, …)`, `debugEffort($, …)`, `buildCandidates($, …)`).
- Hooks per event:
  `tool.call` has one unmatched hook (answers the `estimate_effort` tool, outcome of Jev's own calls, skill
  blocklist) plus one with the matcher `{ tool: "Agent" }`; `turn.step`, `tool.check`, `turn.complete`,
  `session.start`, `session.end`, `agent.offer` and `session.compact` have one each; `ui.render` has one matcher hook (`{ component: "AbovePrompt" }` for the effort band).
- `askJev` raises one
  `$.tool.call({ tool: "mcp__jev-api__batch", state, questions, timeout: apiTimeoutS })` (`state` is `JSON.stringify` text, `questions` the
  `Question` objects in id order, `timeout` in seconds equal to the budget, 14 s just under 15 s on the Haiku path), raced against the budget (`TIMEOUT_MS` 4 s, `COMPACT_TIMEOUT_MS` 9 s for the compaction ranking, `HAIKU_TIMEOUT_MS` 15 s without Jev access); a `{ deny }`, `isError`, a rejection, a result that is not
  a JSON array with one answer per question that has the asked type and the fields jevfort reads (`isAnswer`), or the timeout fails the whole `askJev` (`{ ok: false }`,
  never a throw). The engine
  member is typed `tool.call(input): Promise<ToolResult>`.
- Readiness guard: every hook except `session.start`, `session.end`, `session.compact` and
  the `ui.render` hook starts with `if ((await jevMissing($)).length) return next(e);` (`return yield* next(e)` in
  `turn.step`, whose `cacheWatch` and `turnRunning` work comes before it; `turn.complete` clears `turnRunning` before
  it; `session.compact` guards only the Jev ranking inside `withJevRanking`); `tool.call` and `tool.check` handle
  `ESTIMATE_TOOL` before it. `jevMissing`, `jevApply` and their state `jevTools`/`jevState` are
  module level (`$` may only be passed to top-level functions). `jevTools` is one `$.tool.list()` per turn, shared by
  concurrent hooks: a main-loop `turn.complete` (no `agentId`, or a subagent's while no main-loop turn runs) drops it after its own guard listing (no engine event reports a changed tool
  list), `session.start` drops it right after `next(e)` and lists the session's baseline (a jevfort hook raised inside
  `next(e)` may have cached a listing from before jev-api registered). A rejected or malformed listing counts as the
  tool missing. `jevApply` applies a listing whose missing set differs from `jevState` once: becoming ready registers `estimate_effort` (`estimateRegistered`: a failed registration is retried by the next
  listing, a registered one never again; reset at `session.start`), both call
  `$.ui.invalidate("ui.render")`. `jevState` is unset from the start of `session.start` until its baseline, so a
  listing raised beneath `next(e)` applies nothing. A new hook needs the guard too; `session.start` must not start with
  it (beneath it, jev-api has not registered batch yet). The render hooks read `jevState` instead (no `$.tool`, `$.store` or `jevMissing` call while
  drawing).
- Turn reads: `jevTools` shares its life with `toolListing` (the whole listing; step 0 offers its deferred tools from
  it), `skillList` (step 0's offerable skills) and `haikuPath` (whether jev-api has no Jev env var set and answers
  through Haiku, read through `$.env.get`; a settings `env` change counts from the next turn). `dropTurnReads` drops
  them at every main-loop `turn.complete`, after a main-loop `session.compact` between turns, and at the next main-loop
  step when a background subagent read them between turns (`readBetweenTurns`, not set by the `session.start`
  baseline); a subagent completion mid-turn keeps them. So jev-api appearing or going away takes effect from the next
  turn.
- `jevApply` registers the `estimate_effort` tool with `$.tool.register(ESTIMATE_SPEC)` whatever `routing` says (a
  throw is retried by the next listing) when the jev-api tools become listed: at `session.start`'s baseline after
  `next(e)` (jev-api registers its tools in its own `session.start`) or at a later turn's listing. There is no
  unregister and a registered tool that no hook answers fails, so the unmatched `tool.call` hook answers
  `mcp__jevfort__estimate_effort` before the readiness guard and never calls `next(e)`: `{ result }` (the JSON
  estimate; while the batch tool is really missing `askJev` fails and it is `defaultEffort` with source `fallback` (an inactive state caused by a failed listing still asks Jev)) or, on invalid input,
  `{ deny: "estimate_effort: <reason>" }` without a Jev request; `tool.check` approves it before the guard (a settings deny or ask
  rule still wins).
- Effort band: the `ui.render` hook with matcher `{ component: "AbovePrompt" }` draws `Box`/`Text`/`Button` from
  `$.ui.resolve(e)` (detached factories) out of the closure state `band` (written at main-loop step 0 in `turn.step`:
  `configured` = step-0 `e.effort`, `chosen` = the estimate of any source or the held Haiku/Fable effort) and `autoOff`
  (flipped by the Button `key: "auto"`, reset at `session.start`, `session.end` and by a reload, never stored). Drawn
  in terminal and desktop only: one row of the efforts from `minEffort` to `maxEffort` (plus the session or chosen
  effort when outside that range), session effort bold, chosen blue, the rest dim, then the `Jev auto: on/off` Button.
  Subagent turns do not update it; `autoOff` leaves take-steps, bypass and the `estimate_effort` tool alone. The effort row is hidden with `routing: false` and while
  `jevState !== ""`; then the hook draws only the cache countdown (above `await next(e)`, in a column Box, so another
  plugin's band beneath survives) or, without a countdown, passes; it always passes while `e.props.hasSurvey`.
  `onPress` only flips the flag and calls `$.ui.invalidate` (no storage call; it runs after the frame, so a throw sets `bandStale` and the next applied listing redraws). While `autoOff`,
  the step-0 effort block (first-turn record, estimate, hold) is skipped; the flag is read again after Jev's answer, so a press during the wait keeps the session effort and the band's choice.
- Cache countdown / auto-compact / Haiku compaction (see `cache-compact.md`): `cacheWatch` passes chunks; only the Jev
  ranking honours the `compaction` option (a closure const). The readiness guard of `turn.step` and `turn.complete`
  stays after their cache work: do not remove it. The engine does not wait for a `$.clock.every` callback.
  `cacheTick` calls `$.ui.invalidate` through `showMinutes` in try/catch, `$.command.run` for `/compact` (rejects are
  swallowed) and reads `$.session.usage()`; none of these runs in a hook frame.
- A `tool.call` result has no `exitCode` (failures: root `claude-code-hook-facts.md`).
- `turn.step` `usage` may be `null`; `command.run` returning `{}` prints no row and records no model context.
- `cc-plugin-sec-default` skips every user-tier `prompt.compose`/`prompt.section`/`prompt.context` hook, so the mod
  registers none of them (and no `prompt.submit` hook: jevfort does not classify prompts). It also passes
  `classic.Stop` on past every user-tier hook (notice `its classic.Stop hook was skipped`); jevfort has no Stop-time work.

## Storage calls must run in-frame

Why and what breaks otherwise: root `claude-code-hook-facts.md`. jevfort uses `$.store`, `$.tool.call` (jev-api's
batch tool) and `$.fs`; every `askJev` is awaited in-frame.

## Tests: the jev-api fake

`tests/register.test.ts` and `tests/phase3.test.ts` stub `tool.list` (jev-api's batch tool) and `tool.call`. The
kit resolves a mod's `$.tool.call` to the stub's `value` and rejects with a bare `{ deny }`, while the real engine
resolves `{ deny }` (typings), so the fake answers a batch call with `{ value: { result: "<JSON array of answers>" } }`
or `{ value: { deny: "batch: <reason>" } }` and passes every other tool on with `next(e)`. It records each batch question on its own (with its `type`), so assertions read per
question. Batch questions carry no id: the fake finds it by the `instructions` text.
