---
id: F01
title: The prompt classifier sends every listed skill; from ~120 skills every classification times out and pauses Jev
status: done
priority: high
area: jevfort/src/hooks/register.mts (skillOptions, onPromptSubmit, onAgentCall), jevfort/src/hooks/prompt.mts (promptQuestions)
---

## Status

Done in jevfort 0.11.0 (approach 1). `skillOptions($, request)` filters like step 0: `relevant(request, dedupeSkills(...))` (at most 8, `MAX_RELATED`, best first) plus `none`; with no related skill it returns `undefined` and `promptQuestions` asks only `kind` and `needs_plan`. The classifier request stays at <= 9 skill options (2.8 KB) whatever is installed: 254 skills 495 ms instead of a timeout ([../EVALUATION-2026-11-14-F01.md](../EVALUATION-2026-11-14-F01.md)).

Decision (approach 1 over 2/3): the hint fired on 6 of 156 classified prompts in the user's real store, each sharing a word with the skill's name or description, so the word filter keeps them; a German prompt with no shared word loses the classifier hint (stated in the README upgrade note and CLAUDE.md). Approach 2 still grows with the list, approach 3 does not help under the default `takeOnlyForBypass`. Approach 4 (agent types) not done: 30 types cost 1.04 s, below the budget, and `relevant` matches subagent prompts against type descriptions poorly; left as is.

Earlier state: Open. Found in the performance analysis of 2026-11-14 ([../EVALUATION-2026-11-14.md](../EVALUATION-2026-11-14.md)), plugin 0.10.1.

## Problem

`skillOptions` puts every listed plugin or user skill that is not built in or blocklisted (up to 254, `MAX_CHOICE_OPTIONS`) into the classifier's `skill` choice, each with a 160-character description. System One's latency grows with the request body, about 32 ms per such option. The classifier runs in `prompt.submit` before every composer prompt, so the whole cost sits before the first token of every turn:

- 50 skills: 1.74 s per prompt (20 skills: 0.85 s; without the skill question: 0.26 s).
- From about 120 skills (fewer with a long prompt or previous reply in the state) the request takes longer than the 4 s budget (`TIMEOUT_MS`, jev-api `timeout: 4`): the classification fails, and because it is a timeout `pauseAfterTimeout` stops **every** Jev request for 30 s, doubling up to 10 min. Step 0 (effort routing, takes, bypass), the done check, the agent-type choice and `estimate_effort` then all fall back. Each probe after a pause is again a classification that times out: +4 s before the first token, and the pause doubles. With such a skill list jevfort's Jev features never come back in that session.
- The abandoned request keeps running on the server (~8.5 s at 254 skills), and the endpoint answers requests one after another: requests sent right after it queue behind it (measured: 3 of 5 step-0 requests and 2 of 5 measurements timed out at 4 s right after five such timeouts).

The agent-type choice (`onAgentCall`) has the same shape with the offered agent types (200-character descriptions): 30 types cost 1.04 s per Agent call before the subagent starts.

## Evidence

Proven, real System One through jev-api 0.3.2's built hook with the batch inputs jevfort 0.10.1's built hooks produced (3-5 runs each, see the evaluation):

| Classifier request                 | Body    | Median ms        |
| ---------------------------------- | ------- | ---------------- |
| without the skill question (2 q)   | 1.5 KB  | 261              |
| 20 skills                          | 4.8 KB  | 848-885          |
| 50 skills                          | 9.6 KB  | 1740             |
| 100 skills                         | 17.5 KB | 3230             |
| 150 skills (`timeout: 30`)         | 25.6 KB | 4890             |
| 254 skills (`timeout: 30`)         | 42.4 KB | 8568             |
| 254 skills, jevfort's `timeout: 4` | 42.4 KB | 5 of 5 timed out |

Agent-type choice: 5 / 15 / 30 offered types 237 / 572 / 1040 ms. Proven from the code: a timeout calls `pauseAfterTimeout` (`askJev`), which blocks all callers. Estimated: how many skills a real `$.command.list()` reports as source `plugin` or `user` (the skill listing of the analysis session holds about 90 entries of all sources; not checked live). `skillOptions` also does not merge a prefixed and a bare name of one skill (`dedupeSkills` does that only at step 0), so duplicates cost twice.

## Code locations

- `skillOptions` (register.mts): builds the criteria from `$.command.list()`, `clip(c.description, 160)`, no ranking, no dedupe.
- `promptQuestions` (prompt.mts): adds the `skill` choice whenever `skillOptions` returns criteria.
- `onPromptSubmit`: `askJev($, { request, previous_reply }, questions)` with the interactive budget.
- `onAgentCall`: criteria from every offered type, `clip(description, 200)`.
- For comparison, step 0 already filters: `relevant(request, allSkills)` (at most 8, `MAX_RELATED`) after `dedupeSkills`.

## Approach

Prototype and measure first; candidates:

1. Pre-filter the classifier's skills like step 0: `dedupeSkills`, then `relevant(request, skills)` (8 or 16 at most), keeping `none`. Cuts the request to ~1-1.3 KB of skill options whatever the user has installed. Trap: `relevant` matches words only; a skill whose description shares no word with the prompt (German prompts, see CLAUDE.md) is no longer offered, so its hint is lost. Check how often the hint fires today (`classify` log entries with `skill`) before deciding.
2. Shorter descriptions (e.g. 60 characters) for every option: linear saving, keeps every skill, still grows with the list.
3. Skip the skill question when its answer cannot change anything: under `takeOnlyForBypass` (default) a confident skill only becomes a hint from p >= 0.6 (`SKILL_HINT`); with no skill listed or the question disabled, only `kind` and `needs_plan` remain (261 ms).
4. Agent types: the same pre-filter or description clip; at least cap the option count.

Do not raise the budget instead: the classifier sits before the first token of every turn.

## Verification

Done (0.11.0):

- `tests/phase3.test.mts` "The classifier offers only the related skills (at most 8, deduped), none first; no related skill, no skill question": 313 listed skills, prompt "migrate the database schema to v2" gives 9 options (`none`, `db-migrate` first, `tools:db-migrate` deduped); "rewrite the storage layer" sends only the 2 questions. Failed without the fix (255 options).
- Real endpoint sweep (5 runs, median): 20 skills 840 -> 324 ms, 100 skills 3241 -> 500 ms, 254 skills timeout -> 495 ms, 300 skills 501 ms ([../EVALUATION-2026-11-14-F01.md](../EVALUATION-2026-11-14-F01.md)).
- `pnpm --filter jevfort build`, `pnpm lint` (0 findings), `pnpm --filter jevfort test` (196 passed).

Planned:

- A kit test: with 300 listed skills the classifier's batch call carries at most the chosen number of skill options (and the expected one for a matching prompt).
- Re-measure with the evaluation's `real2.mjs`-style sweep (classifier at 20/100/254 skills) and record it in a new dated evaluation; no timeout at 254 skills.
- `pnpm lint && pnpm --filter jevfort build && pnpm --filter jevfort test`.

## Constraints

jev-api's `batch` shape stays; the hint wording and thresholds (`SKILL_HINT`, `PLAN_HINT`) only change with the user. Every `$` use stays in `register.mts`, pure filtering in `candidates.mts`/`prompt.mts`.

## Related

F02 (same cause: latency per request byte), F10 (parallel requests do not help), jev-api F01/F19 (budgets), CLAUDE.md "Pause after a timeout".
