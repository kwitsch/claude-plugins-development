# jevfort evaluation 2026-11-14 (2), after the worklist (plugin 0.11.0, jev-api 0.3.2)

Fresh performance analysis after the worklist (F01, F03-F08 done in 0.11.0). Measured: the built `plugin/hooks/*.mjs` at `9d03f63` (`pnpm --filter jevfort build` reproduced the committed output byte for byte). Earlier figures: [EVALUATION-2026-11-14.md](EVALUATION-2026-11-14.md) (0.10.1, the analysis), [EVALUATION-2026-11-14-F01.md](EVALUATION-2026-11-14-F01.md), [EVALUATION-2026-11-14-F04.md](EVALUATION-2026-11-14-F04.md). New findings F13 and F14 in [TASKS.md](TASKS.md). Docs only: no code was changed.

**One machine only**: the same WSL2 machine as the analysis (kernel 6.18.33.2-microsoft-standard-WSL2, 12 vCPUs, 9.7 GB RAM, ext4 work tree, Node v24.22.2, Claude Code 2.1.325 installed but not used for measurements). Real System One endpoint from `JEV_URL` and `TYPESAFE_API_KEY` in the shell (nothing about it is in the repo). Treat differences below ~20% as noise.

## How it was measured

- Same method as the analysis. Scratch scripts in the session scratchpad (`jevperf2/`, not committed): the analysis's `fake.mjs`, `bench1.mjs`, `bench2.mjs`, `bench3.mjs`, `mem.mjs` and `real3.mjs`, with `$.clock.after` added to the fake `$` (0.11.0's cancellable budget timer, F08; counted as an op, with a counter of timers neither fired nor cancelled) and `mem.mjs` reporting that counter instead of pending `$.clock.sleep` calls. New: `bench4.mjs` (one turn walked step by step in one instance, so the per-turn cache of F04/F05/F07 is warm as in a real turn; step 0 with a prompt that says "skill"; the agent-type choice body by offered types), `bench5.mjs` (three sequential 6-step turns in one instance: steady-state ops per turn), `real5.mjs` (the batch inputs 0.11.0's built hooks produce, sent to jev-api's built `tool.call` hook with a real `$`, jevfort's own `timeout: 4` unless noted, 3-5 runs after a warm-up, large cases last).
- **The user's real decision log** (`logstats.py`, `agentstats.py`, `agentstats2.py`): the plugin store of the installed jevfort 0.10.1 (`jevfort_kwitsch-plugins-*.json`, 1000 entries from 2026-11-12 23:14 to 2026-11-14 05:33). Only counts and latencies were read out; no request text is quoted here. The code paths behind F13 and F14 are unchanged since the port (`ca6b468`), so these figures apply to 0.11.0.
- Test suite: `pnpm test` in `jevfort/`, 3 runs with `JEV_URL`/`TYPESAFE_API_KEY` unset, plus one `--reporter=verbose` run for per-test times.

## Results

### Engine ops per hook (one default turn, fake `$`, 50 earlier turns in the transcript)

Fresh instance per turn, as in the analysis (`bench1`). `ui.invalidate` is not counted (it is synchronous); `clock.after` (new) is.

| Hook                        | Ops before | Ops now | Batch calls | Pre ms, 0 ms/op now (before) | Pre ms, 1 ms/op now (before) | Post ms, 1 ms/op now (before) | Main ops now                                                                                     |
| --------------------------- | ---------- | ------- | ----------- | ---------------------------- | ---------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `session.start`             | 4          | 4       | 0           | n/a                          | n/a                          | n/a                           | `clock.every`, `command.register`, `tool.list`, `tool.register`                                  |
| `prompt.submit` (classify)  | 16         | 12      | 1           | 0.91-2.19 (0.75-1.32)        | 10.0 (14.3)                  | n/a                           | `clock.now` 3, `env.get` 3, `command.list`, `store.get`, `session.messages`, `clock.after`       |
| `turn.step` 0               | 43         | 26      | 1           | 2.07-3.90 (1.59-4.90)        | 13.2 (36.9)                  | 2.5 (7.0)                     | `fs.exists` 9, `clock.now` 6, `fs.read` 3, `ui.status` 3, `session.cwd` 1, `fs.stat` 1, no store |
| `turn.step` k > 0 (measure) | 28         | 9       | 1           | 0.07-0.30 (0.14-0.40)        | 1.2-1.3 (14.4-15.5)          | 3.5-4.7 (9.2-10.7)            | `clock.now` 4, `clock.after` 2, `session.messages`, `tool.call`, `ui.status`                     |
| `turn.complete`, 30% fill   | 16         | 17      | 1           | 0.85 (0.83-3.87)             | 15.0 (13.9)                  | n/a                           | `clock.now` 3, `env.get` 3, `session.usage` 2, `store.get` 2, `store.set` 2, `agent.list`        |
| `turn.complete`, 85% fill   | 31         | 20      | 1 (2)       | 0.75 (0.83)                  | n/a                          | n/a                           | as at 30%, one merged done + task-end batch, one transcript read, `command.run` 1                |

A 6-step turn: 100 engine ops (215 before), 8 batch calls (9 before at >= 80% fill, now 8 there too), 2 `store.set` (20 before), no store call before the first model request. With an assumed 1 ms per op, 13 ms sit before the first model request of step 0 (37 before) and ~1.2 ms before each later one (~15 before). Step 0 has 3 more `fs.exists` than before: `packageRunner` now probes the four lock files in parallel once per turn instead of one after another until the first hit. `turn.complete`'s 3 `env.get` are the next turn's `haikuPath` (read after `dropTurnReads`), so a steady-state turn still reads the env once.

Steady state (`bench5`, one instance, three sequential 6-step turns): turn 1 93 ops, turns 2 and 3 90 ops each (`clock.now` 32, `clock.after` 13, `ui.status` 10, `fs.exists` 9, `tool.call` 8, `env.get` 3, `store.get` 3, `fs.read` 3, `session.usage` 2, `store.set` 2, `tool.list` 1, `command.list` 1, `session.cwd` 1, `fs.stat` 1, `agent.list` 1), 8 batch calls, 2 `store.set`.

### Foreign tools and the stream pass-through (F09)

| Case                                                       | Median now (before)            | p90 now (before)               |
| ---------------------------------------------------------- | ------------------------------ | ------------------------------ |
| bare `next(e)`                                             | 0.143 us/call (0.151)          |                                |
| `tool.call` hook, foreign tool (`Bash`)                    | 0.274 us/call (0.299)          | 0.358 us (0.400)               |
| `tool.check` hook, foreign tool                            | 0.295 us/call (0.308)          | 0.416 us (0.417)               |
| 20,000-chunk stream, bare / through `turn.step` (inactive) | 4.05 / 15.34 ms (4.12 / 15.44) | 5.03 / 16.87 ms (4.93 / 17.78) |

Unchanged: 0 engine ops per foreign call, the first scratchpad `Write` check 3 ops and later ones 0, +0.56 us per stream chunk.

### Step k > 0 until the model request, by turn size (F04, F05)

Fresh instance per run (`bench2`), as in the analysis: step N is the instance's first hook, so the turn cache is cold (the tool listing, env, project probes and a scan of the whole turn are included). In a real turn that happens only after a reload in the middle of a turn.

| Turn                                            | Transcript | Before: median ms (p90) / ops / `fs.stat` | Now: median ms (p90) / ops / `fs.stat` |
| ----------------------------------------------- | ---------- | ----------------------------------------- | -------------------------------------- |
| 10 steps, 2 KB results                          | 0.05 MB    | 1.38 (2.80) / 28 / 1                      | 1.57 (2.80) / 26 / 1                   |
| 50 steps, 2 KB results                          | 0.22 MB    | 1.73 (2.52) / 28 / 1                      | 1.78 (2.18) / 26 / 1                   |
| 200 steps, 2 KB results                         | 0.83 MB    | 2.95 (3.65) / 28 / 1                      | 3.13 (3.92) / 26 / 1                   |
| 50 steps, 50 KB results                         | 5.02 MB    | 9.39 (14.11) / 28 / 1                     | 9.12 (10.33) / 26 / 1                  |
| 100 steps, 50 KB results                        | 10.02 MB   | 16.97 (22.21) / 28 / 1                    | 17.16 (21.68) / 26 / 1                 |
| 100 steps, 50 KB tool inputs                    | 5.41 MB    | 10.67 (15.39) / 28 / 1                    | 2.52 (2.67) / 26 / 1                   |
| 20 steps, 25 missing paths per result           | 0.09 MB    | 4.77 (5.45) / 528 / 501                   | 1.80 (2.19) / 41 / 16                  |
| 40 steps, 50 missing paths per result           | 0.33 MB    | 15.38 (17.37) / 2028 / 2001               | 2.80 (9.29) / 41 / 16                  |
| 50 steps after 2000 earlier turns, cloned reads | 1.08 MB    | 6.35 (8.83) / 28 / 1                      | 8.05 (9.34) / 26 / 1                   |
| same, no clone                                  | 1.08 MB    | 2.17 (2.47) / 28 / 1                      | 2.10 (2.99) / 26 / 1                   |

The same turns walked step by step in one instance (`bench4`, 5 runs; the real case):

| Turn                       | Step 1 ms (p90) | Step N/2 ms (p90) | Step N ms (p90) | `fs.stat` over the whole turn |
| -------------------------- | --------------- | ----------------- | --------------- | ----------------------------- |
| 100 steps, 50 KB results   | 0.25 (1.29)     | 0.22 (0.30)       | 0.21 (0.23)     | 1                             |
| 40 steps, 50 missing paths | 0.30 (0.36)     | 0.32 (0.34)       | 0.50 (0.61)     | 641 (2000 distinct paths)     |
| 200 steps, 2 KB results    | 0.10 (0.11)     | 0.04 (0.04)       | 0.05 (0.08)     | 1                             |

Pure parts on the 100-step / 50 KB turn: `splitTurn` 0.008 ms, `toolCalls` 0.008 ms, `summarize` 0.005 ms (0.073 before; 0.539 ms with 50 KB inputs, 7.0 before), `mentionedPaths` over the whole 5.0 MB 16.0 ms (now paid only by a cold scan), `structuredClone` of the transcript 8.0 ms. What still grows with the session (not the turn) is the one transcript read per step and `turnOf`'s filter over it: 2.1 ms at 2000 earlier turns, 8.1 ms with the read cloned; bounded by the context window, not filed.

### Listed skills and MCP tools, plugin CPU (F01)

| Skills / MCP tools | `prompt.submit` ms (p90) now (before) | Classify body now (before) | Step 0 until request ms (p90) now (before) | Step-0 body |
| ------------------ | ------------------------------------- | -------------------------- | ------------------------------------------ | ----------- |
| 20 / 30            | 0.93 (2.45) (0.74 (1.37))             | 2.9 KB (4.8 KB)            | 1.76 (4.85) (1.78 (4.83))                  | 3.1 KB      |
| 100 / 200          | 1.09 (1.84) (0.87 (1.13))             | 2.9 KB (17.6 KB)           | 2.60 (3.28) (2.92 (3.17))                  | 3.1 KB      |
| 300 / 1000         | 1.78 (2.54) (1.18 (3.02))             | 2.9 KB (42.4 KB)           | 6.23 (9.48) (6.01 (7.55))                  | 3.1 KB      |

The classifier body no longer grows with the skill list (F01). Step 0's CPU at 1300 listed items is `relevant` re-computing every item's words once per turn (~4.5 ms over the 20 / 30 case); not filed.

### Step 0 with a prompt that says "skill" (F13, new)

`buildCandidates` offers every offerable skill at step 0 when the request matches `/\bskills?\b/i` (otherwise `relevant`, at most 8). Fake `$`, 7 runs each (`bench4`):

| Listed skills | "Fix the failing widget test in src/app.ts" | "Update the skill that deploys the widget documents" | "Which skills do I have for testing widgets?" |
| ------------- | ------------------------------------------- | ---------------------------------------------------- | --------------------------------------------- |
| 20            | 15 options, 4.3 KB, 1.99 ms                 | 26 options, 5.9 KB, 1.88 ms                          | 26 options, 5.9 KB, 1.84 ms                   |
| 100           | 15 options, 4.3 KB, 2.35 ms                 | 106 options, 16.9 KB, 2.00 ms                        | 106 options, 16.9 KB, 2.06 ms                 |
| 300           | 15 options, 4.3 KB, 3.61 ms                 | 255 options, 37.5 KB, 2.73 ms                        | 255 options, 37.5 KB, 2.40 ms                 |

(options = `next_action` criteria including `claude`; ms = plugin CPU until the model request). The real latency of those requests is in the next table; the real log shows the case in 14% of step-0 asks (below).

### Real System One latency of jevfort 0.11.0's batch shapes

| Request (as jevfort builds it)                         | Questions [options]  | Body    | Median ms (before)         | p90 ms | Runs                          |
| ------------------------------------------------------ | -------------------- | ------- | -------------------------- | ------ | ----------------------------- |
| done check, 4-step turn, 30% fill                      | 1 [noul]             | 3.1 KB  | 644 (659)                  | 813    | 813/653/644/644/639           |
| done check + task end in one batch, 85% fill (F03)     | 2 [noul, noul]       | 3.6 KB  | 737 (1341 as two requests) | 759    | 730/759/729/737/739           |
| classify, 20 listed skills, none related (F01)         | 2 [4, noul]          | 1.5 KB  | 279 (848-885)              | 340    | 340/266/281/279/279           |
| step 0, default prompt                                 | 4 [8, score, n, n]   | 3.3 KB  | 617 (616)                  | 669    | 669/625/617/616/609           |
| step-k measurement                                     | 1 [8]                | 3.8 KB  | 729 (771)                  | 848    | 848/731/729/728/729           |
| step 0, prompt says "skill", 50 skills                 | 4 [57, score, n, n]  | 10.1 KB | 1776                       | 1856   | 1856/1764/1769/1777/1776      |
| step 0, prompt says "skill", 100 skills                | 4 [107, score, n, n] | 17.0 KB | 2917                       | 2935   | 2917/2935/2916                |
| step 0, prompt says "skill", 254 skills                | 4 [255, score, n, n] | 37.5 KB | timeout                    |        | 3 of 3 `timeout after 4000ms` |
| step 0, prompt says "skill", 254 skills, `timeout: 30` | 4 [255, score, n, n] | 37.5 KB | 7116                       | 7250   | 7250/7094/7116                |

Worst case, every clip full (`real3.mjs`, 3 runs each; states 3.8-9.7 KB): classify 1100 ms (1442 before: 9 skill options instead of 21), step 0 1548 ms (1570), step-k measurement 1695 ms (1689), done check with task end in one batch 1771 ms (done check 1706 then task end 1708 before). Before the first token with full clips: 2.65 s (3.0 s before); F02 stays open.

The latency model of the analysis holds: ~45 ms floor plus ~0.16 ms per byte of request body (step 0 with 57 / 107 / 255 options: 1.78 / 2.92 / 7.12 s).

### The user's real decision log (installed 0.10.1; F13, F14)

| Entries                                   | Count | Median ms | p90 ms | Max ms |
| ----------------------------------------- | ----- | --------- | ------ | ------ |
| step-0 `take`, 0-9 candidates             | 64    | 694       | 1510   | 4704   |
| step-0 `take`, 10-19 candidates           | 70    | 1774      | 2317   | 4906   |
| step-0 `take`, 20-29 candidates           | 24    | 1850      | 2606   | 3811   |
| step-0 `take`, 30-59 candidates           | 4     | 2670      | 3121   | 3212   |
| step-0 `take`, 60-255 candidates          | 27    | 3646      | 3963   | 7456   |
| `classify` (0.10.1: every skill offered)  | 157   | 3030      | 3734   | 6756   |
| `agent` (agent-type choice)               | 103   | 1152      | 1677   | 4243   |
| `error`: `unavailable: timeout after ...` | 47    |           |        |        |

- 24 of the 25 step-0 asks with 60-255 candidates whose request is known (a `compare` entry of the same turn) said "skill" or "skills"; none of the 158 asks below 30 candidates did. 27 of 189 step-0 asks (14%) were of that size (F13).
- Agent-type choice: 94 of the 103 calls had a general type from Claude (`""`, `general-purpose`, `claude`), 9 a specific one (median 1247 ms; such a call can never be switched). Jev picked a specialised type in 59 of the 94, with a median p of 0.44 and a maximum of 0.82, below `SWITCH_AT` 0.85: 0 switches, 133 s of waiting before subagent dispatches in all (F14). p >= 0.8: 1 call, >= 0.7: 3, >= 0.6: 10.
- The classifier's 3.0 s median is the 0.10.1 case F01 fixed (real 0.11.0 sessions not yet in the log).

### Agent-type choice body by offered types (F14)

Fake `$` (`bench4`), one `agent.offer` per type with a 180-character description, then one `tool.call` of the Agent tool: 5 types 1.3 KB, 15 types 3.2 KB, 30 types 6.2 KB, 60 types 12.2 KB, 120 types 24.2 KB. The analysis measured 237 / 572 / 1040 ms at 5 / 15 / 30 types; with the latency model 60 types cost ~2 s and ~120 types reach the 4 s budget (estimated). The user's sessions offer a type count consistent with ~30 (1152 ms median); enabled plugins and user settings hold 7 agent definitions besides the built-in and project ones.

### Store log (F06)

100 default turns of 6 steps fill the 1000-entry log (classify 100, route 100, take 100, compare 600, done 100): 317 KB of JSON. One more 6-step turn at the cap: 2 `store.set` (20 before), 317 KB serialized (3210 KB before), 3 `store.get` (22 before), 6.5 ms of hook CPU for the whole turn with a JSON-serializing, cloning fake store. A JSON round trip of the full log: 2.73 ms median (p90 2.85). No store call before the first model request of a turn.

### Memory and timers (F08, F12)

Heap after 300 turns 6.26 MB, after +2000 turns 6.51 MB, after +2000 more 6.85 MB, 6.81 MB after a 5 s idle wait (before: 15.9 / 80.7 / 145.5 MB, 6.9 MB idle). `$.clock.after` timers neither fired nor cancelled right after 200 fast turns: 0 (before: 2000 pending `$.clock.sleep` calls).

### Test suite (F11)

205 passed in 8 files (196 before); vitest 2.07 s / 1.79 s / 1.82 s, wall 2.93 / 2.64 / 2.65 s, max RSS 328-343 MB. Slowest test: `relevant ... stays fast on a pasted log` 175 ms (by design), the rest 44 ms or less.

## Comparison with earlier figures

| Measure                                     | Earlier figure (0.10.1)                      | Now (0.11.0)                                                        | Verdict                                                                                   |
| ------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Classifier request, 20 / 100 / 254 skills   | 848-885 ms / 3230 ms / timeout               | 279 ms (20 skills, none related); full clips with 8 related 1100 ms | F01 holds (EVALUATION-2026-11-14-F01, not re-run: 324 / 500 / 495 ms with related skills) |
| Turn end at >= 80% fill                     | 1341 ms (two requests, two transcript reads) | 737 ms (one batch, one read)                                        | F03 holds                                                                                 |
| Stats per step, 40 steps x 50 missing paths | 2001 at step 40, 4000 with both branches     | 16 per build, each path once per turn                               | F04 holds                                                                                 |
| Step k on a 100-step / 50 KB turn           | 17.0 ms per step (whole-turn rescan)         | 0.21-0.25 ms per step (cold scan still 17 ms)                       | F05 holds                                                                                 |
| `store.set` per 6-step turn / bytes         | 20 / 3210 KB                                 | 2 / 317 KB                                                          | F06 holds                                                                                 |
| Engine ops per 6-step turn                  | 215 (step 0 43, step k 28)                   | 100 fresh, 90 steady (step 0 26, step k 9)                          | F07 holds                                                                                 |
| Pending timers after 200 fast turns / heap  | 2000 sleeps, 145.5 MB after 4300 turns       | 0, 6.85 MB                                                          | F08 holds                                                                                 |
| Full clips before the first token           | 3.0 s                                        | 2.65 s                                                              | F02 open (the drop is F01's smaller classifier)                                           |
| Step 0 with "skill" in the prompt           | not measured                                 | 50 skills 1.78 s, 100 2.92 s, 254 timeout                           | New (F13)                                                                                 |
| Agent-type choice                           | 30 types 1040 ms (synthetic)                 | real median 1152 ms over 103 calls, 0 switches                      | New (F14)                                                                                 |
| Foreign tool / stream overhead, test suite  | 0.30 us, 0.57 us per chunk; 196 tests 1.6 s  | 0.27 us, 0.56 us per chunk; 205 tests 1.8 s                         | Unchanged (F09, F11)                                                                      |

## Findings summary

| Id  | Priority | Status | Finding                                                                                                                                                            | Proof                                                     |
| --- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| F01 | high     | done   | classifier offers only related skills                                                                                                                              | re-measured above                                         |
| F02 | medium   | open   | request size drives Jev latency (~0.16 ms/byte): full clips 2.65 s before the first token, 1.77 s per turn end                                                     | real System One                                           |
| F03 | medium   | done   | one batch and one transcript read at the turn end                                                                                                                  | re-measured above                                         |
| F04 | medium   | done   | bounded, cached stat probes                                                                                                                                        | re-measured above                                         |
| F05 | low      | done   | incremental path scan, `summarize` from the end                                                                                                                    | re-measured above                                         |
| F06 | low      | done   | log and stats written once per turn                                                                                                                                | re-measured above                                         |
| F07 | low      | done   | static reads once per turn, transcript once per step                                                                                                               | re-measured above                                         |
| F08 | low      | done   | budget and grace timers cancelled                                                                                                                                  | re-measured above                                         |
| F09 | none     | closed | foreign-tool and stream pass-through overhead                                                                                                                      | measurement record, unchanged                             |
| F10 | none     | closed | classify and step 0 in parallel or merged save nothing                                                                                                             | measurement record, not re-run                            |
| F11 | none     | closed | test-suite runtime                                                                                                                                                 | measurement record, 205 tests 1.8 s                       |
| F12 | none     | closed | memory and the cache tick                                                                                                                                          | measurement record, heap now flat                         |
| F13 | high     | open   | a prompt that says "skill(s)" makes step 0 offer every offerable skill (up to 254 options): 50 skills 1.78 s, 100 skills 2.92 s, 254 skills timeout and `jevPause` | real System One + harness + real log (14% of step-0 asks) |
| F14 | medium   | open   | the agent-type choice waits ~1.15 s before every Agent dispatch (real median, 103 calls) and switched none; 9% of the calls cannot switch at all                   | real log; harness bodies                                  |

Seen and not filed (below the noise or bounded): `turn.complete` reads `session.usage` twice (done-check fill and `contextCompact`); step 0 re-computes `relevant`'s words for every listed skill and tool each turn (~4.5 ms at 1300 items); one transcript read per step grows with the session up to the context window (2-8 ms at 2000 turns); a turn with more than 16 new missing paths per step leaves later paths unprobed (stated in EVALUATION-2026-11-14-F04 under "Not changed").

## Bug hunt

Not run in this analysis. The three issues noted while reading in the analysis (`turn.step`'s `$.ui.invalidate` calls without `try`/`catch`, `record()`'s `void $.ui.status(...)` without a `.catch`, `skillOptions` without `dedupeSkills`): the third is fixed (F01: `offerableSkills` dedupes); the first two are still in the code (`onTurnStep` calls `$.ui.invalidate("ui.render")` three times unguarded; `record` fires `void $.ui.status(...)` unguarded), not reproduced and not filed.

## Live validation

Not run in Claude Code: no `claude -p --plugin-dir` session, so the engine's own dispatch cost per `$` call (the 1 ms per op is an assumption for illustration), the real cost of `$.store.set` and `$.session.messages`, the number of skills `$.command.list()` reports as `plugin`/`user` and of agent types the engine offers in a real session, and the Haiku path are unmeasured. Real System One: yes, 53 requests through jev-api 0.3.2's built hook (40 in `real5.mjs`, 13 in `real3.mjs`) with the batch inputs jevfort 0.11.0's built hooks produced. Real usage data: the decision log of the installed 0.10.1 (counts only).
