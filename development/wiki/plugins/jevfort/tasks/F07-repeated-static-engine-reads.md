---
id: F07
title: Repeated engine reads of static facts per step and per turn
status: done
priority: low
area: jevfort/src/hooks/register.mts (buildCandidates, packageRunner, askJev, skillOptions, previousReply, readTurn, onTurnStep)
---

## Status

Done in 0.11.0. Facts that do not change within a turn are read once per turn: the project probes and `cwd` live in the turn's `TurnCache` (`projectCommands`, its probes in parallel, `packageRunner`'s four lock probes too); the three env values (`haikuPath`), the whole tool listing behind `jevMissing` (`toolListing`, used by step 0) and the offerable skills (`offerableSkills`/`skillList`, shared by the classifier and step 0, dropped also by `blockSkill`) are module values dropped with `jevTools` at every main-loop `turn.complete` and at `session.start` (`dropTurnReads`); `turn.step` reads the transcript once (`turnOf(messages)`, `previousReply(messages)`).

Earlier state: Open. Found in the performance analysis of 2026-11-14 ([../EVALUATION-2026-11-14.md](../EVALUATION-2026-11-14.md)), plugin 0.10.1.

## Problem

Facts that do not change within a turn (or a session) are read from the engine again and again, mostly one `await` after another before the model request:

- `buildCandidates` probes the project at every main-loop step (measurement path, default on) and at step 0: `fs.exists` for `.git`, the lock files (`packageRunner`), `Cargo.toml`, `go.mod`, `pytest.ini`, `conftest.py`, `fs.read` of `package.json`, `Makefile`, `pyproject.toml`: 10 sequential ops per step.
- `askJev` reads `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL` and `JEV_URL` on every call (3 ops; up to 9 asks per turn).
- `session.cwd` twice per step (`buildCandidates` and the state).
- Per turn, `$.command.list()` and the skill blocklist (`store.get`) twice (classifier and step 0), `$.tool.list()` twice at step 0 (`jevMissing`'s cached listing and `buildCandidates`' own), and `$.session.messages` twice at step 0 (`readTurn` and `previousReply`) and again in `prompt.submit` (`previousReply`).

## Evidence

Proven (fake `$`, one default turn): step 0 43 ops (2 transcript reads), step k 28 ops, `prompt.submit` 16, `turn.complete` 16; 215 ops per 6-step turn. With an assumed 1 ms per op: 36.9 ms before step 0's request, 14.4-15.5 ms before each later one. Transcript reads with `structuredClone` (a stand-in for engine marshalling): 6.35 ms vs 2.17 ms per step at a 1 MB transcript. Estimated: the real per-op engine cost is unknown.

## Code locations

- `buildCandidates`, `packageRunner` (project probes, `session.cwd`, `command.list`, `store.get(SKILL_BLOCKLIST_KEY)`, `tool.list`).
- `askJev`: `Promise.all([$.env.get("TYPESAFE_API_KEY"), $.env.get("TYPESAFE_BASE_URL"), $.env.get("JEV_URL")])`.
- `skillOptions`, `previousReply`, `readTurn`, `onTurnStep` (state `cwd: await $.session.cwd()`).

## Approach

1. Per-turn cache (in the `turns` entry, dropped at `turn.complete`): project probes, `cwd`, the command list and blocklist (shared with the classifier of the same turn through a short-lived module value), the step-0 tool listing.
2. One transcript read per hook: `previousReply` takes the messages `readTurn` already read.
3. The three env values once per session (`session.start`), or keep per-call reads if the engine can change them at run time (check: settings `env` reload).
4. Run the independent project probes in parallel (`Promise.all`) where they stay.

## Verification

- Kit test `tests/register.test.mts` "A turn reads the project, env, lists and cwd once and the transcript once per hook" (fails on 0.11.0 before the change: step 0 read the transcript twice): one composer prompt (classifier) and steps 0, 1, 2 with `package.json` present and a mentioned file. It asserts step 0 reads `session.messages` once, steps 1 and 2 make no `fs.exists`/`fs.read`/`session.cwd` call, and the turn reads `env.get` 3 times, `command.list`, the skill blocklist, `tool.list` and `session.cwd` once each.
- Counted ops of those kinds (`env.get`, `fs.exists`, `fs.read`, `session.cwd`, `session.messages`, `command.list`, `tool.list`, `store.get`), measured with the same test's counters, fake `$`:

  | Hook                           | Before                                                            | After                                             |
  | ------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------- |
  | `prompt.submit` (classifier)   | 9                                                                 | 9                                                 |
  | `turn.step` 0                  | 28 (messages 2, env 3, cwd 2, exists 9, read 3, lists 3, store 6) | 20 (messages 1, cwd 1, exists 9, read 3, store 6) |
  | `turn.step` 1, 2 (measurement) | 20 each (env 3, cwd 2, exists 9, read 3, messages 1, store 2)     | 3 each (messages 1, store 2)                      |
  | Prompt + 3 steps               | 77                                                                | 35                                                |

  The project probes of step 0 now run in parallel (two parallel rounds, the eight probes and then the four lock files, instead of 12 sequential ops). The evaluation's full op table was not re-measured in a new dated evaluation (its `fake.mjs` harness is not in the repository); the per-hook counts above come from the kit test.
- `pnpm --filter jevfort build`, `pnpm lint`, `pnpm --filter jevfort test` (203 tests) green.

## Constraints

Decided: the env values are read once per turn, not per session (the engine may reload settings `env` at run time; a change counts from the next turn, like the jev-api listing). Caches end with the turn (or session) so a file created mid-session is seen at the next turn; the jev-api env decision must match jev-api's own (Haiku path when none of the three is set).

## Related

F03 (turn-end transcript reads), F04 (stat probes), F05, F06.
