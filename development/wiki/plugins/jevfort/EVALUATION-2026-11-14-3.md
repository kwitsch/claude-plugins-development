# jevfort evaluation 2026-11-14 (3), after the option removal (plugin 0.12.0, jev-api 0.3.2)

Fresh performance analysis of what 0.12.0 keeps after removing model routing, the done check, the prompt classifier, the step measurement, the `/jev` command with the decision log behind it and every status-line message: step 0 (effort estimate and take questions in one batch), the take path (whole-turn bypass), the agent-type choice, compaction (turn-end task end, forced compaction, `session.compact` ranking and Haiku summary), the cache tick, and memory. Measured: the built `plugin/hooks/*.mjs` at `b385135` (`pnpm --filter jevfort build` reproduced the committed output byte for byte). Earlier figures: [EVALUATION-2026-11-14-2.md](EVALUATION-2026-11-14-2.md) (0.11.0, after the worklist), [EVALUATION-2026-11-14.md](EVALUATION-2026-11-14.md) (0.10.1, the analysis). New findings F15 and F16 in [TASKS.md](TASKS.md). Docs only: no code was changed.

**One machine only**: the same WSL2 machine as before (kernel 6.18.33.2-microsoft-standard-WSL2, 12 vCPUs, 9.7 GB RAM, ext4 work tree, Node v24.22.2, Claude Code 2.1.325 installed but not used for measurements). Real System One endpoint from `JEV_URL` and `TYPESAFE_API_KEY` in the shell (nothing about it is in the repo). Treat differences below ~20% as noise.

## How it was measured

- Same method as the earlier runs. Scratch scripts in the session scratchpad (`jevperf3/`, not committed): the earlier `fake.mjs` pointed at this worktree, registered with 0.12.0's manifest defaults (`routing: true`, no `doneCheck`/`classify`/`measureSteps`), with `$.ui.log` counted and the `$.clock.every` callback and `$.model.complete` requests captured. `bench1.mjs` (ops per hook in a fresh instance with 50 earlier turns, 0 and 1 ms per op, 7 runs; foreign tools; stream pass-through inactive and at an active step k > 0), `bench2.mjs` (step k > 0 by turn and session size, fresh and walked step by step, also with `takeOnlyForBypass: false`), `bench3.mjs` (step 0 by listed skills/tools and prompt wording, step-0 body by option set, the bypass turn end to end, agent-type choice bodies), `bench4.mjs` (turn end by context fill, `session.compact`, the cache tick, three sequential turns with a subagent turn each), `mem.mjs` (`--expose-gc`, 4300 turns with an Agent call and a subagent turn each), `real6.mjs` (the batch inputs 0.12.0's built hooks produce, sent to jev-api 0.3.2's built `tool.call` hook with a real `$`, jevfort's own `timeout`, 5 runs after a warm-up, 3 for the large cases), `real7.mjs` (step 0 and the compaction ranking again with a unique nonce per run, see below), `relevant-cmp.mjs` (`relevant` of the 0.11.0 and 0.12.0 builds on the same input), `log011.py` (the real decision log).
- **The user's real decision log**: the installed jevfort is 0.11.0 (installed 2026-11-14 12:35 UTC), whose store still holds the log 0.12.0 removed (1000 entries from 2026-11-13 14:51 to 2026-11-14 15:28 UTC; 62 of them written by 0.11.0). Only counts and latencies were read; no request text is quoted. The step-0 take rule (`takeOnlyForBypass`: only a Read or Bash pick with p >= `takeThreshold` 0.85 and `single_action` >= 0.8) is unchanged since `d1cf4ff` (0.10.1); 0.12.0 changed only which skills step 0 offers (F13).
- Test suite: `pnpm test` in `jevfort/`, 3 runs with `JEV_URL`/`TYPESAFE_API_KEY` unset, plus one `--reporter=verbose` run.

## Results

### Engine ops per hook (one default turn, fake `$`, 50 earlier turns)

Fresh instance per turn (`bench1`), as before. `prompt.submit` has no hook any more (the classifier is gone); `ui.invalidate` is not counted.

| Hook                      | Ops 0.11.0 | Ops 0.12.0 | Batch calls | Pre ms, 0 ms/op (p90) | Pre ms, 1 ms/op (0.11.0) | Main ops 0.12.0                                                                                                                                                                      |
| ------------------------- | ---------- | ---------- | ----------- | --------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session.start`           | 4          | 3          | 0           | n/a                   | n/a                      | `clock.every`, `tool.list`, `tool.register` (no `command.register`: `/jev` is gone)                                                                                                  |
| `prompt.submit`           | 12         | no hook    | 0 (1)       | n/a                   | n/a (10.0)               |                                                                                                                                                                                      |
| `turn.step` 0             | 26         | 27         | 1           | 1.54-2.10 (2.0-5.7)   | 15.6 (13.2)              | `fs.exists` 9, `fs.read` 3, `clock.now` 3, `env.get` 3, `session.messages`, `session.cwd`, `fs.stat`, `command.list`, `store.get`, `tool.list`, `tool.call`, `clock.after`, `ui.log` |
| `turn.step` k > 0         | 9          | 2          | 0 (1)       | 0.01-0.02 (0.04)      | 1.1 (1.2)                | `session.messages`, `clock.now` (`cacheWatch`, after the stream)                                                                                                                     |
| `turn.complete`, 30% fill | 17         | 1          | 0 (1)       | 0.14 (0.17)           | 1.3 (15.0)               | `session.usage`                                                                                                                                                                      |
| `turn.complete`, 85% fill | 20         | 10         | 1           | 0.35 (1.33)           | n/a                      | `env.get` 3, `clock.now` 2, `session.usage`, `session.messages`, `tool.call`, `clock.after`, `command.run` (task-end question alone)                                                 |
| `turn.complete`, 96% fill | n/a        | 2          | 0           | 0.14 (0.20)           | n/a                      | `session.usage`, `command.run` (forced, no Jev request)                                                                                                                              |

A 6-step turn: 38 engine ops (100 in 0.11.0), 1 batch call (8), 0 `store.set` (2). Step 0 now also carries the skill listing (`command.list`, `store.get` of the blocklist) that the classifier used to read, and lists the tools once per turn for the deferred-tool candidates. Steady state (`bench4`, one instance, three sequential 6-step turns): 37 ops per main-loop turn (90 in 0.11.0), 1 batch call; a 4-step subagent turn with its completion adds 11 ops and 1 batch call (its step-0 effort estimate); 0 `store.set`. Of the 10 transcript reads per turn (6 main-loop and 4 subagent steps), 8 are at a step k > 0 that asks nothing (F16).

### Foreign tools and the stream pass-through (F09)

| Case                                                                           | Median 0.12.0 (0.11.0)        | p90 0.12.0      |
| ------------------------------------------------------------------------------ | ----------------------------- | --------------- |
| bare `next(e)`                                                                 | 0.155 us/call (0.143)         |                 |
| `tool.call` hook, foreign tool (`Bash`)                                        | 0.301 us/call (0.274)         | 0.376 us        |
| `tool.check` hook, foreign tool                                                | 0.307 us/call (0.295)         | 0.389 us        |
| 20,000-chunk stream, bare / through `turn.step` (inactive)                     | 3.51 / 9.61 ms (4.05 / 15.34) | 4.57 / 32.38 ms |
| 20,000-chunk stream through an active step k > 0 (`cacheWatch`, nothing asked) | 9.92 ms (not measured)        | 21.85 ms        |

0 engine ops per foreign call; the first scratchpad `Write` check 3 ops, later ones 0 (unchanged). The stream wrapper adds 0.31-0.32 us per chunk (0.56 before; the p90s are noisy).

### Step k > 0 until the model request (F04, F05, F16)

Fresh instance per run (`bench2`, 7 runs). With the defaults a step k > 0 builds no candidates (`takeOnlyForBypass` limits them to main-loop step 0) and estimates no effort (step 0 only): it reads and splits the transcript and passes on.

| Turn                                            | Transcript | 0.11.0: median ms (p90) / ops / `fs.stat` | 0.12.0: median ms (p90) / ops / `fs.stat` |
| ----------------------------------------------- | ---------- | ----------------------------------------- | ----------------------------------------- |
| 10 steps, 2 KB results                          | 0.05 MB    | 1.57 (2.80) / 26 / 1                      | 0.37 (1.00) / 2 / 0                       |
| 50 steps, 2 KB results                          | 0.23 MB    | 1.78 (2.18) / 26 / 1                      | 0.36 (0.44) / 2 / 0                       |
| 200 steps, 2 KB results                         | 0.88 MB    | 3.13 (3.92) / 26 / 1                      | 0.38 (1.23) / 2 / 0                       |
| 50 steps, 50 KB results                         | 5.03 MB    | 9.12 (10.33) / 26 / 1                     | 0.36 (0.40) / 2 / 0                       |
| 100 steps, 50 KB results                        | 10.04 MB   | 17.16 (21.68) / 26 / 1                    | 0.34 (0.39) / 2 / 0                       |
| 100 steps, 50 KB tool inputs                    | 5.43 MB    | 2.52 (2.67) / 26 / 1                      | 0.34 (0.39) / 2 / 0                       |
| 40 steps, 50 missing paths per result           | 0.35 MB    | 2.80 (9.29) / 41 / 16                     | 0.39 (0.53) / 2 / 0                       |
| 50 steps after 2000 earlier turns, cloned reads | 1.26 MB    | 8.05 (9.34) / 26 / 1                      | 4.82 (5.24) / 2 / 0                       |
| same, no clone                                  | 1.26 MB    | 2.10 (2.99) / 26 / 1                      | 0.35 (0.37) / 2 / 0                       |
| 100 steps, 50 KB results, cloned reads (new)    | 10.04 MB   | not measured                              | 9.46 (12.90) / 2 / 0                      |

Walked step by step in one instance (5 runs): 0.01 ms per step at steps 1, N/2 and N on a 100-step / 50 KB turn and a 200-step / 2 KB turn (0.21-0.25 and 0.04-0.10 ms in 0.11.0); 3.1-3.3 ms per step (p90 up to 5.9) with a cloned transcript of 2000 earlier turns, all of it the read. Pure parts: `splitTurn` 0.001 ms, `toolCalls` 0.002-0.004 ms, `structuredClone` of the transcript 3.3-3.5 ms. What is left at a step k > 0 is the transcript read, which only the bypass follow-up step uses (F16).

With `takeOnlyForBypass: false` (not the default) every step asks Jev: 23 ops, a 4.9 KB batch, 1.37 ms cold on a 10-step turn and 17.5 ms cold on a 100-step / 50 KB turn (the cold path scan), 0.21-0.29 ms walked; a 100-step turn makes 101 batch calls (626 ops), a 200-step turn 201. With the latency model below each such request costs ~0.8 s before the step's model request; the option's description already says it was measured to add turns without saving cost. Not filed.

### Step 0 by listed skills and MCP tools, and the prompt wording (F13)

Fake `$`, 7 runs each (`bench3`); options = `next_action` criteria including `claude`; ms = plugin CPU until the model request.

| Skills / MCP tools | "Fix the failing widget test in src/app.ts" | "Update the skill that deploys the widget documents" | "Which skills do I have for testing widgets?" |
| ------------------ | ------------------------------------------- | ---------------------------------------------------- | --------------------------------------------- |
| 20 / 30            | 16 options, 4.4 KB, 2.22 ms                 | 15 options, 4.4 KB, 1.87 ms                          | 15 options, 4.4 KB, 1.79 ms                   |
| 100 / 200          | 16 options, 4.4 KB, 3.13 ms                 | 15 options, 4.4 KB, 2.47 ms                          | 15 options, 4.4 KB, 3.27 ms                   |
| 300 / 1000         | 16 options, 4.4 KB, 6.65 ms                 | 15 options, 4.4 KB, 8.82 ms                          | 15 options, 4.4 KB, 5.65 ms                   |

0.11.0 offered 26 / 106 / 255 options (5.9 / 16.9 / 37.5 KB) for the two "skill" prompts; F13 holds. The fake's skill descriptions share "widget" and "test" with these prompts, so 8 related skills and 8 tools are offered (more than the default prompt below).

### Step-0 request by option set (the cost of the take questions, F15)

Default prompt, 20 skills, 30 MCP tools, 50 earlier turns (`bench3`), and the same batch inputs sent to real System One (`real6`, 5 runs; `real7`, 5 runs with a unique request each):

| Step 0                                | Questions [options] | Body   | Ops | Plugin CPU ms | Real median ms (p90) | Real, unique requests ms (p90) |
| ------------------------------------- | ------------------- | ------ | --- | ------------- | -------------------- | ------------------------------ |
| defaults: effort + take questions     | 4 [8, score, n, n]  | 3.3 KB | 27  | 1.54          | 589 (708)            | 600 (613)                      |
| `takeSteps: false`: effort only       | 2 [score, n]        | 1.6 KB | 11  | 0.75          | 305 (534)            | 359 (525)                      |
| `routing: false`: take questions only | 2 [8, n]            | 2.3 KB | 26  | 1.54          | 395 (574)            | not run                        |
| subagent step 0 (effort only)         | 2 [score, n]        | 1.3 KB | 10  | 0.79          | 245 (249)            | not run                        |
| full clips: effort + take questions   | 4 [17, score, n, n] | 8.8 KB | n/a | n/a           | 1435 (1437), 3 runs  | not run                        |
| full clips: effort only               | 2 [score, n]        | 5.9 KB | n/a | n/a           | 959 (960), 3 runs    | not run                        |

The take questions (`next_action` over the candidates plus `single_action`) roughly double the main-loop step-0 request: +1.7 KB and +240-285 ms before the first token with a short state, +2.9 KB and +476 ms with full clips, plus 16 engine ops (the project probes, the skill and tool listings). The real log shows what they bought (next section).

### The take path end to end (whole-turn bypass)

Fake `$` (`bench3`): Jev picks `run pnpm test` at p 0.95 with `single_action` 0.93 for "run the tests". Step 0 takes the step in 1.60 ms of plugin CPU (25 ops, no Claude request); step 1 reads the transcript and asks the summary model once (2 ops, 0.07 ms with an instant fake model; the summary prompt is 6.1 K characters for a 6000-character output); the turn makes 0 Claude model requests. The summary model's real latency (`$.model.complete` with `claude-haiku-5-5`, 20 s timeout) was not measured.

### Real System One latency of 0.12.0's batch shapes

Through jev-api 0.3.2's built `tool.call` hook, jevfort's own `timeout` (4 s, 9 s for the ranking), 5 runs after a warm-up (3 for the full-clip and ranking cases), 67 requests in all.

| Request (as jevfort builds it)                       | Questions [options] | Body    | Median ms (earlier)                                           | p90 ms | Runs                |
| ---------------------------------------------------- | ------------------- | ------- | ------------------------------------------------------------- | ------ | ------------------- |
| step 0, default prompt                               | 4 [8, score, n, n]  | 3.3 KB  | 589 (617 in 0.11.0)                                           | 708    | 708/589/577/587/617 |
| step 0, prompt says "skill", 300 listed skills (F13) | 4 [15, score, n, n] | 4.4 KB  | 750 (254 skills: timeout in 0.11.0)                           | 955    | 955/769/750/747/745 |
| `estimate_effort` tool                               | 2 [score, n]        | 1.2 KB  | 238 (234-385, jev-api re-run)                                 | 388    | 388/238/233/230/242 |
| task end, 85% fill, 4-step turn                      | 1 [n]               | 3.1 KB  | 623 (664 in 0.10.1; 737 merged with the done check in 0.11.0) | 760    | 760/623/615/608/624 |
| task end, full clips                                 | 1 [n]               | 10.3 KB | 1578 (1771 merged in 0.11.0)                                  | 1612   | 1612/1578/1573      |
| agent-type choice, 30 offered types (F14)            | 1 [30]              | 6.2 KB  | 625 (1040 in 0.10.1)                                          | 704    | 704/618/626/625/621 |
| compaction ranking, 30 items, identical request      | 30 [score x 30]     | 30.2 KB | 321                                                           | 1697   | 1697/292/321        |
| compaction ranking, 30 items, unique items per run   | 30 [score x 30]     | 27.9 KB | 4888 (4.1-5.1 s, jev-api F19)                                 | 4942   | 4888/4790/4942      |

The identical ranking request answered in ~0.3 s from its second run on: the endpoint reuses answers to repeated identical questions, which a real compaction never sends, so the unique-items row is the real figure. The other cases show no such drop (step 0 with a unique request: 600 ms against 589). The latency model of the analysis holds: ~45 ms floor plus ~0.16 ms per byte of request body.

Before the first token of a main-loop turn: 0.6 s with a short state (0.28 s classifier + 0.62 s step 0 = 0.9 s in 0.11.0), 1.44 s with every clip full (2.65 s in 0.11.0); 0.3 s and 0.96 s of it are the effort estimate.

### The user's real decision log (installed 0.11.0; F14, F15)

Entries written by the installed 0.11.0 (62, 12:35-15:28 UTC; 0 errors, no timeout):

| Entries                                   | Count | Median ms | p90 ms | Max ms | Note                                                                                    |
| ----------------------------------------- | ----- | --------- | ------ | ------ | --------------------------------------------------------------------------------------- |
| main-loop step-0 asks (`take`)            | 12    | 1001      | 1841   | 5777   | 6-24 candidates; 0 taken; Jev's best listed action p <= 0.63; `single_action` >= 0.8: 0 |
| effort estimates without a take (`route`) | 12    | 1859      | 2235   | 2260   | subagent and slash-command turns (effort only)                                          |
| agent-type choice (`agent`)               | 4     | 1204      | 1245   | 2016   | all four `general-purpose`; Jev's specialised pick p 0.39-0.54; 0 switches              |

The whole log (1000 entries, 0.10.1 and 0.11.0): 189 main-loop step-0 asks carried the take questions. 2 took a step, both a Skill bypass (`dprint:dprint`) under the rule before `d1cf4ff`, which the current rule no longer allows. Jev's most likely listed action: `run` 77, `skill` 75, `read` 26, `load` 11; with p >= 0.85: 10 (9 skills, 1 tool load, none of which `takeOnlyForBypass` takes); `single_action` >= 0.8: 4 (3 with a skill best, 1 with a `run` at p 0.22). Under the current rule 0 of the 189 asks would have taken a step (F15). The effort estimate changed the turn's effort in 128 of the 188 main-loop step-0 estimates and in 38 of the 128 estimates without a take (median 1402 ms over the whole log).

### Agent-type choice body by offered types (F14)

Unchanged from 0.11.0 (`bench3`): 5 types 1.3 KB, 15 types 3.2 KB, 30 types 6.2 KB, 60 types 12.2 KB, 120 types 24.2 KB. An Agent call with a specific type (`Explore`) makes 0 engine ops and no batch call (F14 approach 1 holds).

### Compaction and the cache tick

`bench4`, fake `$`, 7 runs:

| Case                                                        | Plugin CPU ms (p90)   | Ops   | Jev request   | Other                                |
| ----------------------------------------------------------- | --------------------- | ----- | ------------- | ------------------------------------ |
| turn end, 30% / 79% fill                                    | 0.13 / 0.11           | 1     | none          | `session.usage`                      |
| turn end, 85% fill (task end)                               | 0.27 (0.30)           | 10    | 1 q, 3.1 KB   | `command.run` when Jev says task end |
| turn end, 96% fill (forced)                                 | 0.15 (0.20)           | 2     | none          | `command.run`                        |
| `session.compact`, 50 + 40 steps (0.20 MB), ranking + Haiku | 1.42 (3.46)           | 8     | 30 q, 30.2 KB | Haiku prompt 110 K chars             |
| same, 200 turns + 100 steps x 50 KB (10.1 MB)               | 3.44 (9.08)           | 8     | 30 q, 30.2 KB | Haiku prompt 364 K chars             |
| same, 2000 turns + 50 steps (1.26 MB)                       | 5.88 (7.41)           | 8     | 30 q, 30.2 KB | Haiku prompt 1.02 M chars            |
| same, `compaction: false` / `haikuCompact: false`           | 0.74-2.14 / 0.83-0.99 | 1 / 7 | none / 30 q   |                                      |

`haikuTranscript` 0.36 / 1.02 / 5.23 ms for the three transcripts; the prompt stays below its 2.4 M-character cap. The real ranking takes ~4.9 s (above), inside the 9 s budget. `session.compact` is bypassed by `cc-plugin-sec-default` on 2.1.325 (CLAUDE.md), so neither the ranking nor the Haiku summary runs live.

Cache tick (the 15 s `$.clock.every`): before the first response 0 ops and 4.0 us per tick; with a countdown 1 op (`clock.now`) and 2.8 us per tick; the first cold tick at 70% fill (`autoCompactPercent` 60) 3 ops (`clock.now`, `session.usage`, `command.run`), later cold ticks 1 op. Unchanged in kind from 0.11.0 (F12).

### Memory and timers (F08, F12)

One instance, 4 main-loop steps, one Agent call (30 offered types) and one subagent turn per turn: heap 5.47 MB after 300 turns, 5.80 MB after +2000, 6.27 MB after +2000 more, 6.15 MB after a 5 s idle wait, 5.86 MB after `session.end` (0.11.0: 6.26 / 6.51 / 6.85 MB). The slow growth is `firstTurns`, one small entry per subagent id until the conversation ends (released at `session.end`). `$.clock.after` timers neither fired nor cancelled right after 200 fast turns: 0.

### Test suite (F11)

250 passed in 8 files (205 in 0.11.0); vitest 1.68 / 1.61 / 1.57 s, wall 2.56 / 2.38 / 2.33 s, max RSS 286 MB. Slowest test: `relevant ... stays fast on a pasted log` 520-633 ms (175 ms in 0.11.0): since the bug hunt it times `relevant` best of 3 on each side of a relative bound. `relevant` itself is not slower: 52.8-62.8 ms for the 0.12.0 build against 56.2-73.2 ms for the 0.11.0 build on the test's 2 MB prompt and 300 items (`relevant-cmp.mjs`). The rest 41 ms or less.

## Comparison with earlier figures

| Measure                                    | Earlier figure (0.11.0)                        | Now (0.12.0)                                                           | Verdict                                                            |
| ------------------------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Engine ops per 6-step turn / batch calls   | 100 fresh, 90 steady / 8                       | 38 fresh, 37 steady / 1                                                | Removal: no classifier, no step measurement, no done check, no log |
| `store.set` per turn                       | 2 (log and stats once per turn, F06)           | 0 (the skill blocklist only, after a refused Skill take)               | Log removed                                                        |
| Before the first token, short / full clips | 0.9 s / 2.65 s (classify + step 0)             | 0.6 s / 1.44 s (step 0 only)                                           | Classifier removed; F15 is about half of what is left              |
| Step k > 0, 100 steps x 50 KB, cold        | 17.2 ms, 26 ops                                | 0.34 ms, 2 ops (9.5 ms with a cloned read)                             | Only the transcript read is left (F16)                             |
| Step 0 with "skill" in the prompt          | 50 skills 1.78 s, 100 2.92 s, 254 timeout      | 300 skills 15 options, 750 ms                                          | F13 holds                                                          |
| Turn end at >= 80% fill                    | 737 ms (done check + task end, one batch)      | 623 ms (task end alone)                                                | Done check removed                                                 |
| Agent-type choice                          | real median 1152 ms over 103 calls, 0 switches | 30 types 625 ms (synthetic); real 0.11.0: 4 calls, 1204 ms, 0 switches | F14 stays partial                                                  |
| Compaction ranking, 30 items               | 4.1-5.1 s (jev-api F19)                        | 4.9 s                                                                  | Unchanged (bypassed on 2.1.325)                                    |
| Heap after 4300 turns / pending timers     | 6.85 MB / 0                                    | 6.27 MB / 0                                                            | Unchanged (F08, F12)                                               |
| Foreign tool / stream overhead             | 0.27 us, 0.56 us per chunk                     | 0.30 us, 0.31 us per chunk                                             | Unchanged within noise (F09)                                       |
| Test suite                                 | 205 tests 1.8 s                                | 250 tests 1.6 s                                                        | Unchanged (F11)                                                    |

## Findings summary

| Id  | Priority | Status  | Finding                                                                                                                                                                                                                                                                                    | Proof                                |
| --- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| F14 | medium   | partial | the agent-type choice waits before every general Agent dispatch (30 types 625 ms synthetic; real 0.11.0 median 1204 ms) and switched none (0 of the 103 `agent` entries in the log, 4 of them from 0.11.0)                                                                                 | real System One + real log           |
| F15 | medium   | open    | step 0's take questions double the main-loop step-0 request (+1.7 KB, +240-285 ms before the first token; +476 ms with full clips; +16 engine ops) and took 0 of 189 real step-0 asks under the current rule (skills and tool loads, Jev's most confident picks, can never be taken there) | real System One + harness + real log |
| F16 | low      | open    | every step k > 0 reads and splits the whole transcript although, with the defaults, only the bypass follow-up step uses it: 8 of 10 reads per turn unused; 0.35 ms per step uncloned, 3.1-9.5 ms with a cloned 1.3-10 MB transcript (engine cost unmeasured)                               | harness op counts and timings        |

Earlier findings: F01, F03-F08 and F13 done (F01's classifier, F03's done check and F06's log no longer exist in 0.12.0); F02, F09-F12 closed as measurement records, their figures re-measured above where cheap.

Seen and not filed (below the noise or bounded): the task-end ask at >= 80% fill reads the three env values again (3 ops: `haikuPath` is dropped before `contextCompact` and once more after it); `relevant` takes ~55 ms per call on a 2 MB pasted prompt and step 0 calls it twice (skills, tools), ~110 ms of synchronous CPU before the first request for such a prompt; `firstTurns` keeps one entry per subagent until the conversation ends (~0.3 MB for 4300 subagents); `takeOnlyForBypass: false` asks Jev at every step (above); the subagent effort estimate (245 ms with a short prompt, real median 1402-1859 ms) follows the request size (F02, closed). Docs drift: F14's Code locations still names the guard `offered.size < 2 || claudeType === "fork"`; the code now reads `offered.size < 2 || !GENERAL.has(claudeType)` (not changed here).

## Bug hunt

Not run in this analysis. Of the notes carried since the first analysis: `record()`'s unguarded `void $.ui.status(...)` is gone with the log (0.12.0); `onTurnStep` still calls `$.ui.invalidate("ui.render")` without `try`/`catch` at main-loop step 0 (the band reset, the held effort, the chosen effort), while every other call site catches "no mounted render site (headless)". Not reproduced, not filed.

## Live validation

Not run in Claude Code: no `claude -p --plugin-dir` session, so the engine's own dispatch cost per `$` call (the 1 ms per op is an assumption for illustration), the real cost of `$.session.messages` (F16's saving), the summary model's latency on the bypass path, the Haiku compaction, `$.command.run` from the cache timer, and the number of skills and agent types a real session lists are unmeasured; `session.compact` is bypassed on 2.1.325, so the ranking and the Haiku summary do not run live. Real System One: yes, 67 requests through jev-api 0.3.2's built hook (53 in `real6.mjs`, 14 in `real7.mjs`) with the batch inputs jevfort 0.12.0's built hooks produced. Real usage data: the decision log of the installed 0.11.0 (counts and latencies only); 0.12.0 has no log, so the next analysis needs another source (the `[jevfort]` debug-log lines of `claude --debug`, or a dedicated measurement).
