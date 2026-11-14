---
id: F13
title: A prompt that says "skill" makes step 0 offer every listed skill; from ~130 skills step 0 times out and pauses Jev
status: done
priority: high
area: jevfort/src/hooks/register.mts (buildCandidates, offerableSkills, onTurnStep), jevfort/src/hooks/candidates.mts (relevant, MAX_RELATED, STOPWORDS)
---

## Status

Done in 0.12.0 (approach 1). `buildCandidates` at step 0 always offers `relevant(request, offerableSkills($))`, at most 8 related skills, whether or not the prompt says "skill". Approach 2 (no skill candidates under `takeOnlyForBypass`) was not done: it needs a decision and loses the `take` calibration rows.

Earlier state: Open. Found in the performance analysis after the worklist ([../EVALUATION-2026-11-14-2.md](../EVALUATION-2026-11-14-2.md)), plugin 0.11.0. The code path is unchanged since the port (`ca6b468`), so the real decision log of the installed 0.10.1 applies.

## Problem

`buildCandidates` at step 0 picks the skills it offers with `/\bskills?\b/i.test(request) ? allSkills : relevant(request, allSkills)`: a request that contains the word "skill" or "skills" puts **every** offerable skill (plugin and user source, not built in, not blocklisted, deduped) into step 0's `next_action` choice, cut only by the final `out.slice(0, MAX_CHOICE_OPTIONS - 1)` at 254 candidates. Each skill option is `skill <name>` with `Use the skill or command "<name>": <description clipped to 80>` (~150 bytes). System One costs ~0.16 ms per byte of request body, and step 0 runs before the first model request of every main-loop turn with the plugin defaults (`takeSteps`, `bypass`, `takeOnlyForBypass`), so its latency grows with the installed skills:

- 50 skills: 57 options, 10.1 KB, 1776 ms (a default prompt: 8 options, 3.3 KB, 617 ms).
- 100 skills: 107 options, 17.0 KB, 2917 ms.
- 254 skills: 255 options, 37.5 KB, 7116 ms with `timeout: 30`; with jevfort's 4 s budget 3 of 3 timed out. A timeout makes `pauseAfterTimeout` stop every Jev request for 30 s (doubling up to 10 min): the turn loses its effort estimate, take and bypass, and the done check, the agent-type choice and `estimate_effort` fall back until the pause ends. The abandoned request keeps the serial endpoint busy for ~7 s, so requests right after it queue behind it (seen in the analysis).
- The budget is crossed at roughly 130-150 skills (estimated between the 100- and 254-skill points; fewer with a long request or previous reply in the state).

Under the defaults a skill candidate can never be taken: with `takeOnlyForBypass` only a `Read` or `Bash` pick with `single_action` >= 0.8 is taken. The skill options at step 0 then only feed the `take` record's best action and the `compare` record. The prompt classifier already offers at most 8 related skills (F01), and a prompt about a skill ("update the skill ...", "which skills do I have") is rarely a request to run one now.

## Evidence

Proven:

- Harness (fake `$`, built hooks 0.11.0, `bench4.mjs`): with 20 / 100 / 300 listed skills, a prompt with "skill" or "skills" gets 26 / 106 / 255 `next_action` options (4.3 KB without the word, 5.9 / 16.9 / 37.5 KB with it); plugin CPU stays at 2-3 ms.
- Real System One through jev-api 0.3.2's built hook (`real5.mjs`): the latencies above (3-5 runs each, spread below 5%).
- The user's real decision log (installed 0.10.1, 1000 entries over 30 hours): 27 of 189 step-0 asks (14%) had 60-255 candidates; 24 of the 25 whose request is known said "skill(s)", none of the 158 asks below 30 candidates did. Their Jev latency: median 3646 ms, p90 3963, max 7456 (asks with 0-9 candidates: median 694 ms). A step-0 ask that timed out leaves no `take` entry, so the log cannot show how many of these turns timed out.

Estimated: the exact crossing point of the 4 s budget.

## Code locations

- `buildCandidates` (register.mts), the `stepIndex === 0` block: `const skills = /\bskills?\b/i.test(request) ? allSkills : relevant(request, allSkills);`.
- `offerableSkills` (register.mts): the per-turn skill list both the classifier and step 0 use.
- `relevant`, `MAX_RELATED` (8) and `STOPWORDS` (holds "skill" and "skills") in candidates.mts.
- `nextActionQuestion` (policy.mts): every candidate's description goes into the criteria.
- `onTurnStep`: the `pick` rule under `takeOnlyForBypass` (only `Read`/`Bash`).
- `/jev candidates` (`onJevCommand`) shows the same step-0 list.

## Approach

Cheapest first:

1. Drop the branch: always `relevant(request, allSkills)` (at most 8, best first), as the classifier does since F01. "skill" is a stopword, so a prompt about a skill still matches that skill by its other name or description words. The request stays bounded at about step 0's default size whatever is installed.
2. Under `takeOnlyForBypass` offer no `Skill` (and `ToolSearch`) candidates at step 0 at all, since none can be taken; saves the related skills too (~1.2 KB, ~190 ms estimated per turn with 8 of them) but loses the skill rows of the `take`/`compare` calibration data. Needs a decision (user, or a decision agent with its reasoning written here).
3. Keep a "skills" branch but cap it (e.g. `relevant` first, then fill up to 16 by name): still bounded, more options than 1.

Recommendation: 1 now; 2 only after a decision.

## Verification

- `tests/register.test.mts`, 'A prompt that says "skill" offers at most 8 related skills at step 0': 300 listed skills sharing the words "release notes", prompt "update the release notes skill"; step 0's `next_action` criteria hold 1 to 8 skill options. Fails without the fix (254 skill options), passes with it. `pnpm lint` clean, `pnpm --filter jevfort test` 249 of 249.
- Not re-measured against the real endpoint (no new dated evaluation): with at most 8 skill options the step-0 request is bounded at the default prompt's size (3.3 KB, ~0.6 s in the earlier measurement, estimated), whatever is installed.

Planned before the fix:

- Kit test (`tests/phase3.test.mts` or `tests/register.test.mts`): 300 listed skills and a request containing "skill": step 0's `next_action` criteria hold at most 8 skill options; fails on 0.11.0 (255 options).
- Re-measure in a new dated evaluation (`real5.mjs`-style): step 0 with a "skill" prompt at 50 / 100 / 254 skills, expected ~0.6-0.8 s and no timeout.

## Constraints

Every Jev failure falls back to Claude Code's own behaviour; jev-api's `batch` name, input and answer shape stay. `takeOnlyForBypass: false` users can take a skill at step 0: approach 1 keeps that (related skills stay offered).

## Related

F01 (the same failure in the classifier, fixed the same way), F02 (request size drives latency), F14 (the other option list that grows with the installation).
