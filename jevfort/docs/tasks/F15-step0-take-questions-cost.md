---
id: F15
title: Step 0's take questions double the main-loop step-0 request and took no step in 189 real asks
status: open
priority: medium
area: jevfort/src/hooks/register.mts (onTurnStep, buildCandidates, projectCommands, offerableSkills), jevfort/src/hooks/policy.mts (nextActionQuestion, singleActionQuestion)
---

## Status

Open. Found in the analysis after the option removal ([../EVALUATION-2026-11-14-3.md](../EVALUATION-2026-11-14-3.md)), plugin 0.12.0, from real System One timings of the batch inputs 0.12.0's built hooks produce and the real decision log of the installed 0.11.0 (the take rule is unchanged since `d1cf4ff`, 0.10.1). Approaches 1 and 2 need no decision; approach 3 does.

## Problem

With the defaults (`takeSteps`, `bypass`, `takeOnlyForBypass` on), every main-loop step 0 (not on a slash-command turn) builds the take candidates (files named in the turn, quoted-term searches, the project's git commands, scripts and test runners, up to 8 related skills and 8 related deferred tools) and adds two questions to the step-0 batch: `next_action` (a choice over the candidates plus `claude`) and `single_action` (a noul). Jev takes the step only when `takeOnlyForBypass`'s rule holds: the pick is a `Read` or `Bash` candidate with p >= `takeThreshold` 0.85 and `single_action` >= `SINGLE_ACTION` 0.8. Then a small model reports the result and Claude is skipped for the turn.

- Cost: the step-0 request grows from 1.6 KB (effort estimate only) to 3.3 KB; real System One answers it in 589-600 ms instead of 305-359 ms (+240-285 ms before the first token of every main-loop turn). With every clip full: 8.8 KB, 1435 ms against 959 ms (+476 ms). The candidates also cost 16 engine ops before the request (9 `fs.exists`, 3 `fs.read`, `fs.stat`, `command.list`, the blocklist `store.get`, `tool.list`): 27 ops at step 0 against 11 with `takeSteps: false`.
- Benefit: the real log holds 189 main-loop step-0 asks (0.10.1 and 0.11.0). Under the current rule none would have taken a step. Jev's most likely listed action was `run` 77 times, `skill` 75, `read` 26, `load` 11; its picks with p >= 0.85 were 9 skills and 1 tool load, which `takeOnlyForBypass` never takes; `single_action` reached 0.8 four times (3 with a skill best, 1 with a `run` at p 0.22). The 2 steps taken in the log were Skill bypasses under the rule before `d1cf4ff`. The 12 asks of 0.11.0: 0 taken, best p <= 0.63.
- Skill and tool-load candidates under `takeOnlyForBypass` can only lose: they cannot be taken, yet they grow the body (up to 16 of 26 options) and draw Jev's probability away from the Read/Bash options.

## Evidence

Proven: real System One, step 0 with defaults / `takeSteps: false` / `routing: false` on the same state (`real6.mjs`, 5 runs; `real7.mjs`, 5 runs with a unique request each), full clips (3 runs); harness op counts and bodies (`bench3.mjs`); the real decision log (`log011.py` and the counts in the evaluation: `take` entries' `best`, `bestP`, `singleAction`, `applied`). Estimated: the saving of approach 1 (~140 bytes per option, ~0.16 ms per byte: 8 skill and tool options ~1.1 KB, ~180 ms) and how often a confident Read/Bash take would occur with other prompts or users (none in this log).

## Code locations

- `onTurnStep` (register.mts): the `takeSteps && !ctx.command && turn.taken < MAX_TAKES_PER_TURN && (!takeOnlyForBypass || (bypass && e.index === 0 && !e.agentId))` branch that calls `buildCandidates` and adds `next_action`; the `single_action` line; the `pick` rule (`takeOnlyForBypass && (singleAction < SINGLE_ACTION || (picked?.tool !== "Read" && picked?.tool !== "Bash"))`).
- `buildCandidates` (register.mts): the `stepIndex === 0` block that offers `relevant` skills (`offerableSkills`) and deferred tools (`toolListing`); `projectCommands`, `packageRunner`.
- `nextActionQuestion`, `singleActionQuestion`, `pickCandidate` (policy.mts).

## Approach

Cheapest first:

1. Under `takeOnlyForBypass`, offer only what can be taken: skip the step-0 skill and tool-load candidates (pass a flag to `buildCandidates`, or filter to `Read`/`Bash` before `nextActionQuestion`). No behaviour change for the takes themselves; the request shrinks by the skill and tool options and Jev's probability mass stays on the options that can win. With `takeOnlyForBypass: false` the skill and tool candidates stay.
2. Ask `next_action` and `single_action` only when a local check says the request can be a single read-only action (a short request without change verbs, or a request that names a candidate's file or command). Saves the whole +240-476 ms on most turns; risk: a bypass the check misses.
3. Revisit the feature: with 0 of 189 real asks taken under the current rule, make the take path opt-in (`takeSteps` or `bypass` default `false`) or drop it. This needs a decision (the user, or a read-only decision agent with its reasoning written here).

Recommendation: 1 now (no decision needed), 3 as a decision; 2 only if the feature stays on by default.

## Verification

- Kit test (`tests/register.test.mts`): with the defaults, step 0's `next_action` criteria hold no `skill ` or `load ` key while related skills and deferred tools are listed; with `takeOnlyForBypass: false` they do. Fails on 0.12.0 (the keys are offered).
- Every decision edge keeps its test (`takeThreshold`, `SINGLE_ACTION`, the Read/Bash rule).
- In a new dated evaluation: the step-0 body and the real System One median with the defaults against `takeSteps: false` on the same state.

## Constraints

Every Jev failure falls back to Claude Code's own behaviour; jev-api's `batch` name, input and answer shape stay. The effort estimate stays in the same step-0 batch (one System One request per step 0, F10). `buildCandidates` keeps its per-turn cache semantics (F04, F05, F07) and the `MAX_STATS` budget.

## Related

F02 (request size drives latency, closed as a measurement record), F10 (one batch per step 0), F13 (step 0's skill options), F14 (the other Jev ask that pays latency without switching anything), F16 (the transcript read at steps that ask nothing).
