# CLAUDE.md — jevfort

Mods-API plugin: one TypeScript function-hooks module and its pure helper modules, the `/jev` command, one
engine-registered tool (`estimate_effort`, seen by the model as `mcp__jevfort__estimate_effort`, deferred: Skills and
subagents load it via ToolSearch), no skills, agents, command hooks or MCP servers. A port of nim-f/jev-pilot
(<https://github.com/nim-f/jev-pilot>, version 0.5.0, commit 90cc1f1, directory `hooks/`) into this repository's layout. Upstream has no LICENSE file; it is credited in
`plugin/README.md`.

## Differences from upstream

- No modes: upstream's `mode` option and `/jev <mode>` are gone; jevfort is on while the plugin is enabled. Every
  "apply only when active" guard is unconditional, the report has no shadow rows. `Entry.applied` stays and means
  "acted" vs "pass" (status suffix ` (pass)`). A `mode` key left in `$.store` by an older version is never read.
- No permission gate: upstream's Bash and edit gate (risk and in-scope questions, `gate` option, thresholds, report
  rows) is gone. `tool.check` only approves Jev's own vetted calls and writes into the session scratchpad.
- Jev is asked only through the jev-api plugin's tool `mcp__jev-api__batch` (upstream sends its own HTTP request):
  `askJev` raises one `$.tool.call` with all questions of the decision (one System One request, needs jev-api >= 0.2.0),
  with a 4 s budget per `askJev` (`TIMEOUT_MS`; a compaction ranking, off the interactive path, gets 9 s, below the engine's 10 s per hook, `COMPACT_TIMEOUT_MS`: System One answers a batch question by question, 30 compaction-sized questions took 4.1 to 5.1 s), all or nothing. Every call gives jev-api a `timeout` equal to its budget (on the Haiku path 14 s, just under its 15 s; seconds, `JEV_API_TIMEOUT_S` 4, `COMPACT_API_TIMEOUT_S` 9), so jev-api stops waiting when jevfort does, not after its default 20 s
  (the HTTP request itself cannot be aborted and runs on until it settles or the engine's 30 s cap). jevfort makes no network request and reads no
  endpoint or key: those are jev-api's environment (with none of the three set jev-api answers through Haiku, so `askJev` reads them through `$.env.get` and uses a 15 s budget, `HAIKU_TIMEOUT_MS`, and `timeout: 14`, instead of 4 s and 4) (`TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `JEV_URL`,
  `TYPESAFE_DEFAULT_MODEL`). No `userConfig` entry for any of it.
- jev-api is a declared plugin dependency (`claudePlugin.dependencies: ["jev-api"]` in `package.json`, copied into
  `plugin.json`; bare name, no version range): Claude Code keeps jevfort disabled while jev-api is missing or disabled.
  At runtime `jevMissing($)` looks the batch tool up in `$.tool.list()` once per turn: the listing (`jevTools`) is
  shared by the turn's hooks and dropped at every main-loop `turn.complete` (subagent completions keep it; Claude Code 2.1.322 has no tool-list-changed
  event), so jev-api appearing or going away takes effect from the next turn; `session.start` lists again after
  `next(e)` as the session's baseline; a failed or malformed listing counts as all missing. `jevApply` applies a
  changed listing once (`jevState` holds the last applied one and stays unset until the baseline, so a listing beneath
  `session.start`'s `next(e)` applies nothing): going inactive logs `inactive: jev-api tools missing (...)`, becoming
  ready registers `estimate_effort`, both redraw the effort band. While the tool is missing (also with jev-api 0.1,
  which has only `noul`/`choice`/`score`) jevfort is inactive: every hook except the `/jev` command, the render hooks,
  the `estimate_effort` handling and the Jev-free cache countdown, Haiku compaction and auto-compact (next bullet)
  passes through untouched (also the scratchpad-write allow) and `/jev` says why.
  `estimate_effort` is never registered in a session that was never ready; a failed registration is retried by the next
  listing, a registered one is not registered again until the next `session.start` (there is no unregister), so `tool.call` answers and `tool.check` approves it before the readiness guard (while the batch tool is really missing it
  answers its `defaultEffort`, source `fallback`; an inactive state from a failed listing still asks Jev).
- Effort band: a `ui.render` hook on `AbovePrompt` (terminal and desktop only) draws the efforts from `minEffort` to `maxEffort` (plus the session effort or the chosen one when outside that range) in one
  row: the main loop's session effort (step-0 `e.effort`) bold, the effort jevfort chose for the current main-loop
  turn (estimate of any source, or the held Haiku/Fable estimate) blue, the rest dim, then a `Jev auto: on/off`
  Button. Hidden with `routing: "off"`, while inactive or before the session baseline, and while a survey holds the
  band. The button flips the closure flag `autoOff` (reset at `session.start`, at `session.end` and by a reload, never stored): while
  off, step 0 skips the effort estimate and the Haiku/Fable hold, so the turn runs at the session effort; take-steps,
  bypass, `routing: "model"` difficulty and the `estimate_effort` tool are unaffected. `/jev` status shows
  `(effort auto off)`. Not ported from effortless: settings, handoff and the other bar features; subagent turns do not
  update the band.
- Cache countdown, Haiku compaction and auto-compact (0.7.0, ported from HeyCubit/effortless `hooks/register.tsx`,
  none needs jev-api, so their work runs before the readiness guard of `turn.step`/`turn.complete`, and `session.compact`
  has none except around the Jev ranking): `cache.mts` (pure: TTL detection, minutes, label,
  colour) and the Haiku transcript/prompt in `compact.mts`. `register.mts` wraps `next` in
  `turn.step` with `cacheWatch`: a main-loop response with `usage` on the session's own model (`request.model ===
  e.model`) sets `cacheExpires = now + TTL` (in a try/catch: a cosmetic feature never fails the step). The lifetime is
  the assumed 1 hour: Claude Code 2.1.322 reports a step's usage as the four token counts plus `model`, without
  `cache_creation`, so `cacheTtlOf` stays dormant and a 5-minute cache (API key, Bedrock/Vertex/Foundry, a subscription
  past its limit) is not detected: its countdown and auto-compact wait run 55 minutes long (not fixed: inferring 5m
  from a cold re-write could misread a prefix change on a 1-hour account and compact a warm chat). A 15 s
  `$.clock.every` started in `session.start` (cancelled and restarted there; a reload re-raises `session.start`)
  runs `cacheTick`: redraws the band when the minute changed and, with `autoCompactPercent > 0`,
  cache cold, no main-loop turn running (`turnRunning`: set at the first `turn.step`, cleared in `turn.complete`; the
  prompt-submit phase before it is not covered, so a cold tick there queues `/compact` behind the user's prompt),
  context `$.session.usage().context.percent` at or above it and `coldCompacted` unset (read again after the await,
  ticks overlap), runs `$.command.run({ command: "compact" })` once (the engine queues it until the session is idle and
  keeps the promise pending until it ran; a refusal goes to `$.ui.status`, not retried); the next response resets
  `coldCompacted`. The countdown state is reset by `resetCache` from `session.start` and `session.end` (the engine
  raises `session.end`, not `session.start`, for /clear and an in-process /resume; `session.end` also resets the
  first-turn estimates, the band and `autoOff`). `session.compact` (always registered, subagents pass): Jev ranking
  (`withJevRanking`, only with jev-api and the `compaction` option), then with `haikuCompact` Haiku's summary as the
  returned `messages` (`precompute` is skipped with `{ skip }`; a failure or a summary of 200 characters or fewer goes
  `next(...)`); `cacheExpires = 0` only once a compaction stands (the Haiku return or a `next(...)` result without
  `skip`, never for `precompute`). The Haiku outcome is logged as kind `summary` (the ranking is kind `compact`).
  Trade-off of the Haiku path (read from the 2.1.322 binary): answering `{ messages }` without `next` skips core's
  compaction step, so classic PreCompact hooks do not run (a blocking one is ignored), PostCompact gets an empty
  summary, recently read files, the plan file and invoked skills are not re-attached, and a lower plugin's
  `session.compact` hook (inline-headroom's dedup reset) sees nothing when jevfort is the outer plugin. The band draws
  the countdown also when the effort row is hidden, above (column Box) whatever another plugin's `AbovePrompt` hook
  beneath draws. Not verified live: `$.command.run` from a timer callback (read from the 2.1.322 binary: queued as a
  plugin-origin prompt entry); the kit tests cover it.
  Not ported: effortless's cold band, Handoff, settings panel and the swamp/limit alerts.
- Coupling: jevfort relies on jev-api's `batch` name, input (`state` string, `questions` array of
  `{ type, instructions, criteria? }`) and answer (a JSON array of answers, `type` plus the System One fields, in
  question order); no code is imported. Renaming the tool or changing its input or answer shape breaks jevfort: the
  runtime check catches a renamed tool, changed shapes surface as
  `askJev` errors and the fallback to Claude Code's own behaviour.
- Every `$` use and every `on(...)` call lives in `src/hooks/register.mts` (engine rule, see
  `.claude/rules/register-hooks.md`); upstream's `askJev`, `record`, `readLog`, `clearLog`, `stats`, `readTurn`,
  `previousReply`, `buildCandidates`, `packageRunner`, `summarizeResult`, `skillOptions` and the
  `register*` functions of `prompt`/`agents`/`compact`/`view` moved there. Upstream `mode.ts` and `view.ts` have no
  file. The other `src/hooks/*.mts` are pure.
- No `claude-code` type import: `$`, events and `on` are typed structurally at the top of `register.mts`.
- Upstream blocks `Stop`. Here the done check runs on `turn.complete` (main-loop turns ending with `reason: "answer"`)
  and sends one framed follow-up message (`DONE_PROMPT`) through `$.prompt.submit`, because `cc-plugin-sec-default`
  skips user-tier `classic.Stop` hooks. The unfinished answer stays visible. Background Bash work is not detected,
  only subagents (`$.agent.list()`, waiting = any status but `completed`, `failed`, `killed`, `idle`). The follow-up is
  recognised by `origin: { kind: "plugin", name: "jevfort" }` in `prompt.submit`, not by its text; a user's own prompt (`origin.kind` `composer`, not meta) clears the
  exemption of the next turn, meta prompts keep it. A rejected follow-up is logged by the next `turn.complete`.
- Effort routing: the turn's effort comes from the effort estimate (`estimateEffort` in `policy.mts`, shared with the
  `estimate_effort` tool; its two questions go out with the other step-0 questions in the same batch call), not from upstream's difficulty->effort
  mapping, which is gone; the difficulty question is asked only with `routing: "model"` and only lowers the model.
  The rule (0.9.0, from the 120-point measurement of 2026-11-13, `tests/fixtures/effort-scores.json`): mechanical from
  p >= `MECHANICAL_FROM` 0.95 gives `minEffort`; a missing or non-finite score gives the unclamped `defaultEffort`; the
  score's confidence is NOT checked (the discarded scores were as accurate as the kept ones, and the threshold dropped
  every `high`/`xhigh` prompt; `MIN_CONFIDENCE` stays for the difficulty `route()`); otherwise `effortLevel(score)` (piecewise
  linear, `EFFORT_CUTS` 1.05/1.9/2.5/3.1 land on 0.5/1.5/2.5/3.5, the last cut is provisional), rounded, clamped. There is no model bias (removed in 0.9.0 by user decision: it was
  never validated and shifted the calibrated cuts per model); the tool's `model` input stays for callers and is ignored by
  the rule. The cuts are for `d1-3b`; the Haiku fallback of jev-api is not calibrated either. `route` and `estimate` log entries carry `effortScore` and `effortConfidence` to recalibrate from real turns.
  `tests/effort-fixture.test.mts` pins the acceptance numbers (A1 to A5). `words()` in `candidates.mts` splits at
  `[^\p{L}\p{N}]` so umlauts survive; German prompts still share few words with English skill descriptions.
  Opus/Sonnet sessions are estimated every turn; Haiku/Fable sessions only on each loop's first turn, whose estimate is
  then held while the session effort is unchanged. A model switch starts a new first turn. Bounds: options
  `minEffort`/`maxEffort`; invalid or inverted values fall back to `low`/`xhigh` with a logged error at session start.

## Known limit: session.compact is bypassed (Claude Code 2.1.325)

The built-in `cc-plugin-sec-default` passes `session.compact` on past every user-tier hook (debug log: `jevfort: session.compact bypassed by cc-plugin-sec-default (tier user); beneath runs`, and `its session.compact hook was skipped`), as it does for `prompt.compose`, `prompt.section`, `prompt.context` and `classic.Stop` (for `tool.check` only a re-dispatch notice appears, the verdict stays allow: inline-headroom/docs/claude-code-verification.md). So the Jev ranking, the Haiku compaction and the `cacheExpires = 0` reset after a compaction do not run until that changes; core compacts on its own. Seen live with a manual `/compact` in `claude -p`; an interactive session and an auto-compaction were not tried. Nothing in this plugin can get past a prepend-tier hook; the code and its tests stay as they are (the kit runs the hook).

## Known limit: several sessions share one log

`record()` reads and writes the whole `log` and `stats` values and is serialized only inside one process: two Claude processes on the same plugin store can overwrite each other's entries, so `/jev` counts and `/jev report` undercount while several sessions run at once. Behaviour is unaffected. A per-session key merged at read time would fix it; not done.

## Known limit: a hook above refusing a core read

`turn.step` calls `$.session.messages`, `$.session.cwd` and the summary `$.model.complete` before `next`. A hook above jevfort that refuses one of them skips jevfort's whole `turn.step` hook for that step, including the cache countdown wrap: the countdown then keeps the previous response's expiry and auto-compact may run up to the cache lifetime early. Not guarded (it needs another plugin refusing core reads); the step itself is unaffected.

## Layout

`package.json` is the only manifest source (`claudePlugin.userConfig`, 16 options). `pnpm build` compiles
`src/**/*.mts` to `plugin/**/*.mjs` (`plugin/hooks/` unmangled and uncompressed) and generates
`plugin/.claude-plugin/plugin.json`. Tests (`tests/*.test.mts`, vitest + `claude-engine-vitest`) run against `plugin/`.

## Commands

```bash
pnpm --filter jevfort build
pnpm --filter jevfort test
pnpm lint
claude plugin validate jevfort/plugin
```
