# jevfort evaluation 2026-11-14 (plugin 0.10.1, jev-api 0.3.2)

First performance analysis of jevfort itself (the jev-api analysis of 2026-11-13, `../../jev-api/docs/EVALUATION-2026-11-13.md`, covered jev-api and jevfort's compaction budget only). Measured: the built `plugin/hooks/register.mjs` (`pnpm --filter jevfort build` reproduced the committed output byte for byte at `ab043dd`). Purpose: count the engine (`$`) operations and plugin CPU per hook, find what grows with the transcript, the turn, the store and the listed skills, and measure the real System One latency of the batch shapes jevfort sends. Findings F01-F12 in [TASKS.md](TASKS.md). Docs only: no code was changed.

**One machine only**: WSL2 (kernel 6.18.33.2-microsoft-standard-WSL2), 12 vCPUs, 9.7 GB RAM, ext4 work tree, Node v24.22.2, Claude Code 2.1.325 installed but not used for measurements. The real System One endpoint came from `JEV_URL` and `TYPESAFE_API_KEY` in the shell (nothing about it is in the repo). Treat differences below ~20% as noise.

## How it was measured

- Scratch scripts in the session scratchpad (`jevperf/fake.mjs`, `bench1.mjs`, `bench2.mjs`, `bench3.mjs`, `mem.mjs`, `real.mjs`, `real2.mjs`, `real3.mjs`, `real4.mjs`; not committed). Rebuild from this description if needed.
- **Fake `$`** (`fake.mjs`): imports a fresh instance of the built module per case (query string), captures every hook from `register(on, options)` with the manifest defaults, and calls them with a fake engine that counts each `$` member call: `clock`, `env`, `store` (a Map; `set` serializes the value with `JSON.stringify` and counts the bytes, optionally `get`/`messages` return `structuredClone` copies to model engine marshalling), `session.messages` (a generated transcript), `session.cwd/id/usage`, `fs` (a virtual file map: `.git`, `package.json`, `pnpm-lock.yaml`, `src/app.ts`), `command.list` (20/100/300 skills, ~150-char descriptions), `tool.list` (jev-api's batch tool plus 30-1000 MCP tools), `tool.call` (the batch tool answers every question with a valid synthetic answer at once), `model.complete`, `ui.*`, `prompt.submit`, `agent.list`. Optional per-op latency (`setTimeout(1)`, i.e. an assumed 1 ms per engine op) to show how many ops sit sequentially on the critical path. This is not the Claude Code engine: its real per-op dispatch cost is unknown.
- **`turn.step`**: driven as an async generator with a `rawNext` that records when the model request starts (time "pre" = hook entry to request) and when its stream ends (time "post" = stream end to hook end); a stream of 20,000 chunks for the pass-through cost.
- **Session sequence** (`bench1`): `session.start`, then one main-loop turn: `prompt.submit` (composer prompt), steps 0-5 (the transcript grows by one tool step per request), `turn.complete` (`reason: "answer"`), at 30% and at 85% context fill.
- **Scaling** (`bench2`): step k > 0 with turns of 10-200 steps, tool results of 2 KB / 50 KB, tool inputs of 50 KB, results that mention 25-50 paths that do not exist, and a 2000-turn history; 7 fresh instances per case. Pure parts timed alone (9 runs). Store log filled with real entries to its 1000-entry cap.
- **Real System One** (`real*.mjs`): the batch inputs jevfort's built hooks produced in the fake (classifier, step 0, step-k measurement, done check, task end, agent-type choice) sent to jev-api's built `tool.call` hook with a real `$` (`fetch`, `setTimeout`, process env), so the request is exactly what jev-api sends. 3-5 runs per case after a warm-up, 208 requests in all. A case with jevfort's own `timeout: 4` that ran longer was answered as a timeout; the large skill lists were re-run with `timeout: 30` to see the full latency.
- **Memory** (`mem.mjs`, `--expose-gc`): one instance, 300 + 2000 + 2000 turns (4 main-loop steps and one subagent turn each), `heapUsed` after two `gc()`.
- Test suite: `pnpm test` in `jevfort/`, 3 runs with `JEV_URL`/`TYPESAFE_API_KEY` unset, plus one `--reporter=verbose` run for per-test times.

## Results

### Engine ops per hook (one default turn, fake `$`, 50 earlier turns in the transcript)

| Hook                        | Ops | Batch calls | `session.messages` | Pre ms, 0 ms/op (post) | Pre ms, 1 ms/op (post) | Main ops                                                                                              |
| --------------------------- | --- | ----------- | ------------------ | ---------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `session.start`             | 4   | 0           | 0                  | n/a                    | n/a                    | `clock.every`, `command.register`, `tool.list`, `tool.register`                                       |
| `prompt.submit` (classify)  | 16  | 1           | 1                  | 0.75-1.32              | 14.3                   | `store.get` 3, `clock.now` 3, `env.get` 3, `store.set` 2, `command.list` 1                            |
| `turn.step` 0               | 43  | 1           | 2                  | 1.59-4.90 (0.3-1.0)    | 36.9 (7.0)             | `store.get` 7, `store.set` 6, `fs.exists` 6, `clock.now` 6, `fs.read` 3, `env.get` 3, `session.cwd` 2 |
| `turn.step` k > 0 (measure) | 28  | 1           | 1                  | 0.14-0.40 (0.1-0.2)    | 14.4-15.5 (9.2-10.7)   | `fs.exists` 6, `clock.now` 4, `fs.read` 3, `env.get` 3, `session.cwd` 2, `store.*` 4                  |
| `turn.complete`, 30% fill   | 16  | 1           | 1                  | 0.83-3.87              | 13.9                   | done check: `agent.list`, `session.usage`, `store.*` 4                                                |
| `turn.complete`, 85% fill   | 31  | 2           | 2                  | 0.83                   | n/a                    | done check, then task end: two batch calls with the same state, `command.run` 1                       |

A 6-step turn: 215 engine ops, 8 batch calls (classify, step 0, five measurements, done check; 9 at >= 80% fill), 20 `store.set`. With an assumed 1 ms per op, 37 ms sit before the first model request of step 0 and ~15 ms before each later one; the post-step time is the `compare` record (two reads and two writes of the store). See F06, F07.

### Foreign tools and the stream pass-through (F09)

| Case                                                       | Median          | p90             |
| ---------------------------------------------------------- | --------------- | --------------- |
| bare `next(e)`                                             | 0.151 us/call   |                 |
| `tool.call` hook, foreign tool (`Bash`)                    | 0.299 us/call   | 0.400 us        |
| `tool.check` hook, foreign tool                            | 0.308 us/call   | 0.417 us        |
| 20,000-chunk stream, bare / through `turn.step` (inactive) | 4.12 / 15.44 ms | 4.93 / 17.78 ms |

0 engine ops per foreign `tool.call`/`tool.check` (200 x 1000 calls after 50,000 warm-up calls); the first scratchpad `Write` check reads 2 env values and the session id once (3 ops), later ones 0. The stream wrapper (`cacheWatch` inside `onTurnStep`) adds 0.57 us per chunk.

### Step k > 0 until the model request, by turn size (F04, F05)

| Turn                                            | Transcript | Median ms (p90) | Ops  | `fs.stat` |
| ----------------------------------------------- | ---------- | --------------- | ---- | --------- |
| 10 steps, 2 KB results                          | 0.05 MB    | 1.38 (2.80)     | 28   | 1         |
| 50 steps, 2 KB results                          | 0.22 MB    | 1.73 (2.52)     | 28   | 1         |
| 200 steps, 2 KB results                         | 0.83 MB    | 2.95 (3.65)     | 28   | 1         |
| 50 steps, 50 KB results                         | 5.02 MB    | 9.39 (14.11)    | 28   | 1         |
| 100 steps, 50 KB results                        | 10.02 MB   | 16.97 (22.21)   | 28   | 1         |
| 100 steps, 50 KB tool inputs                    | 5.41 MB    | 10.67 (15.39)   | 28   | 1         |
| 20 steps, 25 missing paths per result           | 0.09 MB    | 4.77 (5.45)     | 528  | 501       |
| 40 steps, 50 missing paths per result           | 0.33 MB    | 15.38 (17.37)   | 2028 | 2001      |
| 50 steps after 2000 earlier turns, cloned reads | 1.08 MB    | 6.35 (8.83)     | 28   | 1         |
| same, no clone                                  | 1.08 MB    | 2.17 (2.47)     | 28   | 1         |

Pure parts on the 100-step / 50 KB turn: `splitTurn` 0.008 ms, `toolCalls` 0.008 ms, `summarize` 0.073 ms (7.0 ms with 50 KB inputs), `mentionedPaths` over the 5.0 MB of turn text 15.4 ms, `structuredClone` of the transcript 6.9 ms. Every stat is a sequential `await` before the model request; the missing-path rows are zero-cost stats in the fake.

### Listed skills and MCP tools, plugin CPU (F01)

| Skills / MCP tools | `prompt.submit` ms (p90) | Classify body | Step 0 until request ms (p90) | Step-0 body |
| ------------------ | ------------------------ | ------------- | ----------------------------- | ----------- |
| 20 / 30            | 0.74 (1.37)              | 4.8 KB        | 1.78 (4.83)                   | 3.1 KB      |
| 100 / 200          | 0.87 (1.13)              | 17.6 KB       | 2.92 (3.17)                   | 3.1 KB      |
| 300 / 1000         | 1.18 (3.02)              | 42.4 KB       | 6.01 (7.55)                   | 3.1 KB      |

Step 0 caps related skills and tools at 8 each (`relevant`); the classifier sends every listed plugin or user skill (up to 254) with a 160-character description.

### Real System One latency of jevfort's batch shapes (F01, F02, F03, F10)

| Request (as jevfort builds it)                                    | Body               | Median ms        | p90 ms | Runs                          |
| ----------------------------------------------------------------- | ------------------ | ---------------- | ------ | ----------------------------- |
| tiny `noul` (state `{}`, one short question)                      | <0.1 KB            | 45.7             | 132.7  | 133/46/45/45                  |
| done check, short turn (state 0.6 KB)                             | 0.6 KB             | 148.9            | 150.1  | 150/149/144/141               |
| done check, 4-step turn (state 3.1 KB)                            | 3.1 KB             | 659.4            | 662.1  | 659/662/662/656/659           |
| task end, same state                                              | 3.1 KB             | 664.3            | 669.9  | 665/659/661/664/670           |
| classify without the skill question (2 q)                         | 1.5 KB             | 260.7            | 316.1  | 316/261/256/254               |
| classify, 20 skills (3 q)                                         | 4.8 KB             | 848.2-885.3      | 924.4  | 924/885/883/911/868           |
| classify, 50 skills                                               | 9.6 KB             | 1740.1           | 1740.8 | 1737/1741/1740/1740           |
| classify, 100 skills                                              | 17.5 KB            | 3230.2           | 3250.4 | 3218/3230/3196/3250           |
| classify, 150 skills (`timeout: 30`)                              | 25.6 KB            | 4890.4           | 4908.7 | 4909/4808/4709/4890           |
| classify, 254 skills (`timeout: 30`)                              | 42.4 KB            | 8568.0           | 8682.0 | 8659/8503/8568/8682/8522      |
| classify, 254 skills, jevfort's `timeout: 4`                      | 42.4 KB            | timeout          |        | 5 of 5 `timeout after 4000ms` |
| step 0: `next_action` + effort + mechanical + single_action (4 q) | 3.3 KB             | 615.9            | 627.2  | 627/617/616/612/615           |
| step-k measurement: `next_action` (1 q)                           | 3.8 KB             | 771.0            | 788.2  | 788/771/767/768/772           |
| agent-type choice, 5 / 15 / 30 offered types                      | 1.4 / 3.7 / 7.0 KB | 237 / 572 / 1040 |        | 3 runs each                   |

Worst case, every clip full (request 4000 characters, previous reply 800, eight `recent` entries at their limits, 26 step-0 candidates), 3 runs each: classify (20 skills) 1442 ms, step 0 1570 ms, step-k measurement 1689 ms, done check 1706 ms, task end 1708 ms (states 3.8-9.7 KB).

Turn start and turn end, 5 runs each:

| Variant                                          | Median ms | p90 ms |
| ------------------------------------------------ | --------- | ------ |
| classify (20 skills) then step 0, as today       | 1584.1    | 2088.2 |
| both requests at once                            | 1495.7    | 1560.8 |
| one merged batch of 7 questions                  | 1514.1    | 1537.0 |
| done check then task end, as today (>= 80% fill) | 1341.1    | 1367.6 |
| one merged batch of both questions               | 762.0     | 771.6  |

Latency follows the request size: about 45 ms floor plus ~0.16 ms per byte of request body (~32 ms per classifier skill option or offered agent type at 160-200 characters each). The endpoint answers concurrent requests one after another (parallel is no faster than sequential). A request jevfort abandons keeps running on the server: in the first run, right after five 254-skill classifier timeouts (each still running ~8.5 s server-side), 3 of 5 step-0 requests and 2 of 5 measurements also timed out at 4 s; with the large cases moved to the end, none did.

### Store log (F06)

100 default turns of 6 steps fill the 1000-entry log (classify 100, route 100, take 100, compare 600, done 100): 321 KB of JSON. One more 6-step turn at the cap: 20 `store.set` (2 per record: log and stats), 3210 KB serialized, 22 `store.get`; a JSON round trip of the full log costs 2.90 ms median (p90 3.71). Three records (classify, route, take) are awaited before the first model request of a turn, one (`compare`) after every main-loop step before the step returns.

### Memory and timers (F08, F12)

Heap after 300 turns 15.9 MB, after +2000 turns 80.7 MB, after +2000 more 145.5 MB, but 6.9 MB after a 5 s idle wait: no leak. The growth is the budget sleeps of `askJev` (`$.clock.sleep(budgetMs)` raced against the call and never cancelled) and the 250 ms measurement grace, each keeping its closure until it fires: 2000 sleeps were still pending right after 200 fast turns (10 per turn). At human turn rates this is a handful of 4 s timers per turn; whether a pending `$.clock.sleep` keeps a headless `claude -p` run or the engine's hook bookkeeping alive was not checked. Module state stays bounded (`turns` entries are deleted at `turn.complete`; `firstTurns` gains one small entry per subagent until the session ends; the in-memory `recent` buffer keeps 50 entries). The 15 s cache tick makes no engine call while no countdown is shown.

### Test suite (F11)

196 passed in 8 files; vitest 4.22 s / 1.61 s / 1.64 s (the first run cold), wall 5.11 / 2.47 / 2.47 s, max RSS 298-399 MB. Slowest tests: `relevant ... stays fast on a pasted log` 186 ms (by design), the rest 43 ms or less.

## Comparison with earlier figures

| Measure                                       | Earlier figure                                                                       | Now                                                              | Verdict                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Small System One request                      | batch of 1 short score 146 ms, `noul` 49.5 ms (jev-api evaluation 2026-11-13)        | done check with a 0.6 KB state 149 ms, tiny `noul` 46 ms         | Same endpoint speed; the larger numbers today come from request size, not the endpoint |
| Interactive `estimate_effort` through jevfort | 234-385 ms (jev-api re-run, real endpoint)                                           | not re-run; step 0 (which carries the same two questions) 616 ms | Step 0 adds `next_action` with 12 options and `single_action`                          |
| Compaction ranking, 30 items                  | 4.5-5.1 s (jev-api F19)                                                              | not re-run (`session.compact` is bypassed on 2.1.325)            | Stays with jev-api F19                                                                 |
| Hanging endpoint                              | +8 s before the first token per turn, +4 s per Agent call and done check (CLAUDE.md) | not re-run                                                       | Unchanged code path (`jevPause`)                                                       |
| Large skill list                              | none                                                                                 | classify 1.74 s at 50 skills, 3.23 s at 100, timeout from ~120   | New (F01)                                                                              |

## Findings summary

| Id  | Priority | Status | Finding                                                                                                                                      | Proof                                       |
| --- | -------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| F01 | high     | open   | classifier sends every listed skill: ~32 ms per skill, 1.7 s at 50, timeout and pause of all Jev features from ~120 skills                   | real System One; skill count live unchecked |
| F02 | medium   | open   | request size drives Jev latency (~0.16 ms/byte): full clips cost ~3 s before the first token and 1.7 s per done check                        | real System One                             |
| F03 | medium   | open   | at >= 80% fill the turn end asks Jev twice with the same state (1341 ms vs 762 ms merged) and reads the transcript twice                     | real System One + fake `$`                  |
| F04 | medium   | open   | `buildCandidates` stats every mentioned path of the whole turn one after another until 8 qualify; missing paths cost a stat each, every step | fake `$` op counts; 9P cost estimated       |
| F05 | low      | open   | every step re-scans the whole turn (`mentionedPaths` over all tool output, `summarize` over all inputs): quadratic over a turn               | fake `$`, pure timings                      |
| F06 | low      | open   | `record()` rewrites the whole 321 KB log and the stats per decision (20 `store.set` per 6-step turn), in-frame on the critical path          | fake store; engine store cost unmeasured    |
| F07 | low      | open   | repeated reads of static facts: 10 project probes per step, env per ask, command/skill lists and the transcript twice per turn               | fake `$` op counts                          |
| F08 | low      | open   | `askJev`'s budget sleep and the measurement grace are never cancelled: each ask leaves an engine timer pending 4-15 s                        | harness heap and timer counts               |
| F09 | none     | closed | foreign-tool and stream pass-through overhead (+0.15 us per call, +0.57 us per chunk)                                                        | measurement record                          |
| F10 | none     | closed | running classify and step 0 in parallel or as one batch saves nothing (the endpoint serializes)                                              | measurement record                          |
| F11 | none     | closed | test-suite runtime                                                                                                                           | measurement record                          |
| F12 | none     | closed | memory and the cache tick                                                                                                                    | measurement record                          |

## Bug hunt

Not run in this analysis (the `bughunt-loop` is the next step of this workflow). Noted while reading, not reproduced and not filed as tasks: `turn.step` calls `$.ui.invalidate("ui.render")` three times without the `try`/`catch` every other call site has ("no mounted render site (headless)"); `record()` fires `void $.ui.status(...)` without a `.catch`, so a refused status write would be an unhandled rejection; `skillOptions` does not deduplicate prefixed and bare skill names the way step 0's `dedupeSkills` does (one skill can take two classifier options, which F01 makes slower).

## Live validation

Not run in Claude Code: no `claude -p --plugin-dir` session, so the engine's own dispatch cost per `$` call (the 1 ms per op above is an assumption for illustration), the real cost of `$.store.set` and `$.session.messages` (marshalling, persistence), the number of skills `$.command.list()` reports as source `plugin`/`user` in a real session (the skill listing of this analysis session holds about 90 entries of all sources), whether a pending `$.clock.sleep` delays a headless run's exit, and the Haiku path (15 s budget, no model call made) are unmeasured. `session.compact` is bypassed by `cc-plugin-sec-default` on 2.1.325 (CLAUDE.md), so the compaction ranking was not re-measured. Real System One: yes, 208 requests through jev-api's built hook with the batch inputs jevfort's built hooks produced.
