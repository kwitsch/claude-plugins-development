# CLAUDE.md — jevfort

Mods-API plugin: one TypeScript function-hooks module and its pure helper modules, one engine-registered tool
(`estimate_effort`, seen by the model as `mcp__jevfort__estimate_effort`, deferred: Skills and subagents load it via
ToolSearch), no skills, agents, command hooks or MCP servers. A port of nim-f/jev-pilot
(<https://github.com/nim-f/jev-pilot>, version 0.5.0, commit 90cc1f1, directory `hooks/`). Upstream has no LICENSE
file; it is credited in `plugin/README.md`.

Part rules (load with their files): `.claude/rules/register-hooks.md` (hooks, `$` use, engine pitfalls),
`.claude/rules/cache-compact.md` (cache countdown, auto-compact, compaction, their known limits),
`.claude/rules/effort-routing.md` (effort estimate). Measurements and history: `docs/`.

## Differences from upstream

- No modes: jevfort is on while the plugin is enabled; every "apply only when active" guard is unconditional.
- No permission gate (risk and in-scope questions, `gate` option, thresholds): `tool.check` only approves Jev's own
  vetted calls and writes into the session scratchpad.
- Store keys `mode`, `log` and `stats` left in `$.store` by older versions are never read.
- Jev is asked only through jev-api's tool `mcp__jev-api__batch` (upstream sends its own HTTP request): `askJev` raises
  one `$.tool.call` with all questions of the decision (one System One request, needs jev-api >= 0.2.0), all or
  nothing. Each call passes its budget as jev-api's `timeout` (values: `register-hooks.md`), so jev-api stops waiting
  when jevfort does, not after its default 20 s (jev-api's timeout and cancel: `jev-api/CLAUDE.md`).
- jevfort makes no network request and reads no endpoint or key: those are jev-api's environment (`TYPESAFE_API_KEY`,
  `TYPESAFE_BASE_URL`, `JEV_URL`, `TYPESAFE_DEFAULT_MODEL`). With none of the first three set jev-api answers through
  Haiku; `askJev` reads them once per turn (`haikuPath`) and then uses the longer Haiku budget. No `userConfig` entry
  for any of it.
- jev-api is a declared plugin dependency (`claudePlugin.dependencies: ["jev-api"]` in `package.json`, bare name, no
  version range): Claude Code keeps jevfort disabled while jev-api is missing or disabled. At runtime `jevMissing($)`
  looks the batch tool up once per turn (lifecycle: `register-hooks.md`). While it is missing (also with jev-api 0.1,
  which has only `noul`/`choice`/`score`) jevfort is inactive: every hook passes through untouched (also the
  scratchpad-write allow) except the render hooks, the `estimate_effort` handling and the Jev-free cache countdown,
  Haiku compaction and auto-compact.
- Coupling: jevfort relies on jev-api's `batch` name, input and answer shape (defined in `jev-api/CLAUDE.md`); no
  code is imported. The runtime check catches a renamed tool; changed shapes surface as `askJev`
  errors and the fallback to Claude Code's own behaviour.
- Every `$` use and every `on(...)` call lives in `src/hooks/register.ts` (engine rule), including upstream's `askJev`,
  `readTurn`, `previousReply`, `buildCandidates`, `packageRunner`, `summarizeResult` and the `register*` functions of
  `agents`/`compact`. Upstream `mode.ts` and `view.ts` have no counterpart. The other `src/hooks/*.ts` are pure.
- Effort: the turn's effort comes from Jev's effort estimate (`effort-routing.md`), not from upstream's
  difficulty->effort mapping. `routing` is a boolean (`options.routing !== false`; Claude Code type-checks `userConfig`
  before loading, so a non-boolean value keeps the module from loading, live 2.1.325; the fallback only covers an
  absent value): `false` turns off the step-0 effort estimate and the band's effort row, not the cache countdown,
  `estimate_effort` or take-steps.
- Effort band: a `ui.render` hook on `AbovePrompt` shows the session and the chosen effort and a `Jev auto: on/off`
  Button (details: `register-hooks.md`).
- Output: nothing on the status line (no `$.ui.status`). The only output is one debug-log line per effort estimate,
  written by `debugEffort` through `$.ui.log(text, { to: "debug" })` (returns nothing; with `claude --debug`:
  `[jevfort] $.ui.log (to debug): effort <model>: session <e> → <chosen> · <source>`).
- From HeyCubit/effortless (`hooks/register.tsx`): the effort band, cache countdown, Haiku compaction and auto-compact
  (`cache-compact.md`). Not ported: its settings panel, Handoff, cold band, swamp/limit alerts and the other bar
  features.

## Pause after a timeout

`askJev` keeps a module-level pause (`jevPause`): a timeout (only a timeout, a fast failure costs nothing; jevfort's own
clock, or jev-api's `timeout after <n>ms` error when that ends first, as Haiku's 14 s does before the 15 s budget)
stops all Jev requests for `PAUSE_MS` 30 s, doubling per further timeout up to `MAX_PAUSE_MS` 10 min; the first call
after the pause is the probe, any success resets it. The pause ends when the clock reads earlier than the last timeout
(a new session, a test). Cost of a hanging endpoint: `docs/EVALUATION-2026-11-15-live-notes.md`.

## Layout

- Tests share the kit `tests/support/kit.ts` (standard: root `.claude/rules/hook-tests.md`).
