# jevfort evaluation 2026-11-14, F01 (plugin 0.11.0, jev-api 0.3.2)

Re-measurement of the prompt classifier after F01 ([tasks/F01-classifier-skill-list-latency.md](tasks/F01-classifier-skill-list-latency.md)): `skillOptions` now offers only `relevant(request, dedupeSkills(...))` (at most 8) plus `none` and leaves the skill question out when no listed skill is related. Earlier figures: [EVALUATION-2026-11-14.md](EVALUATION-2026-11-14.md) (0.10.1).

**One machine only**: the same WSL2 machine as the analysis (12 vCPUs, ext4 work tree, Node v24.22.2). Real System One endpoint from `JEV_URL` and `TYPESAFE_API_KEY` in the shell.

## Method

- Scratch script `f01/sweep.mjs` in the session scratchpad (not committed): imports jevfort's built `plugin/hooks/register.mjs` (before = `850bffa`, after = this change; the other hook modules are unchanged), raises its `prompt.submit` hook with a fake `$` (`command.list` returns N generated skills with ~170-character descriptions from a 90-word vocabulary, half `plugin`, half `user`), and passes the batch call it makes to jev-api 0.3.2's built `tool.call` hook with a real `$` (`fetch`, `setTimeout`, process env) and jevfort's own `timeout: 4`. Prompt: "migrate the postgres database schema to the new version and add tests for it". One warm-up, then 5 runs per case; the time is the batch call alone.

## Results

| Listed skills | Before: options / body / median ms | After: options / body / median ms |
| ------------- | ---------------------------------- | --------------------------------- |
| 20            | 21 / 5.0 KB / 840                  | 3 / 1.6 KB / 324                  |
| 100           | 101 / 20.1 KB / 3241               | 9 / 2.8 KB / 500                  |
| 254           | timed out at 4 s (askJev budget)   | 9 / 2.8 KB / 495                  |
| 300           | (capped at 255 options, n/a)       | 9 / 2.8 KB / 501                  |

The spread within each case was below 5% (p90 = the slowest of the 5 runs, within 5% of the median). Before matches the analysis (20 skills 848-885 ms, 100 skills 3230 ms, 254 skills 5 of 5 timeouts). After, the request no longer grows with the skill list: at most 9 options, ~0.5 s per prompt with a related skill, the 2-question request (261 ms in the analysis) without one. No timeout at any size, so `jevPause` is no longer tripped by the skill list.

## Hint coverage (decision input)

The user's real `jevfort` store (156 `classify` entries) held 6 skill hints (p >= 0.6, 4% of prompts): `main-return` for "git pull", `dprint:dprint` twice for "Run the skill /dprint:dprint ...", `cc-knowledge:cc-review` for "coderabbit review anfordern ...", `jev-solver:finish` for a German prompt about commit/push/draft PR. Each of those prompts shares a name or description word with the skill (`pull`, `dprint`, `review`, `commit`/`push`), so `relevant` would most likely still offer it; not checked against the exact skill listing of those sessions.

## Bug hunt

Not run. Kit test `tests/phase3.test.mts` "The classifier offers only the related skills ..." covers 313 listed skills (cap 8, dedupe of `tools:db-migrate`, best first) and the unrelated prompt (no skill question).

## Live validation

Not run in Claude Code. The endpoint numbers above are real; `$.command.list()` was faked.

## Not changed

The agent-type choice (`onAgentCall`, 30 types 1.04 s) still offers every type up to 255; a description shares too few words with a subagent prompt for `relevant`, and 30 types stay under the budget.
