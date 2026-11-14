---
id: F07
title: Repeated engine reads of static facts per step and per turn
status: open
priority: low
area: jevfort/src/hooks/register.mts (buildCandidates, packageRunner, askJev, skillOptions, previousReply, readTurn, onTurnStep)
---

## Status

Open. Found in the performance analysis of 2026-11-14 ([../EVALUATION-2026-11-14.md](../EVALUATION-2026-11-14.md)), plugin 0.10.1.

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

- Kit tests: op counts per hook (e.g. step k makes no project `fs` call after the turn's first step; step 0 reads the transcript once).
- Re-measure the evaluation's op table in a new dated evaluation.

## Constraints

Caches end with the turn (or session) so a file created mid-session is seen at the next turn; the jev-api env decision must match jev-api's own (Haiku path when none of the three is set).

## Related

F03 (turn-end transcript reads), F04 (stat probes), F05, F06.
