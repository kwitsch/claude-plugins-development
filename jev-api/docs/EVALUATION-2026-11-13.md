# jev-api evaluation 2026-11-13 (plugin 0.3.1)

First performance analysis of the built `plugin/hooks/register.mjs` (0.3.1, `pnpm --filter jev-api build` reproduced the committed output byte for byte). Purpose: quantify the cost of the `tool.call` hook for tools it does not own, of registration, of the request path and of the Haiku fallback, and record failure modes found on the way. Findings F01-F15 in [TASKS.md](TASKS.md).

**One machine only**: WSL2 (kernel 6.18.33.2-microsoft-standard-WSL2), 12 vCPUs, 9.7 GB RAM, ext4 work tree, Node v24.22.2, Claude Code 2.1.323 installed but not used for measurements. The real System One endpoint came from `JEV_URL` in the shell (a private host on the tailnet, model `jev-latest`); nothing about it is in the repo. Treat differences below ~20% as noise.

## How it was measured

- Scratch scripts in the session scratchpad (`jevperf/stub.mjs`, `harness.mjs`, `mem2.mjs`, `realscale.mjs`; not committed). Rebuild from this description if needed.
- **Stub**: a `node:http` server on 127.0.0.1 that takes the System One body `{ model, state, questions: { <id>: { type, instructions, criteria } } }` and answers `{ model, answers: { <id>: answer }, usage: {} }` in the shapes of `tests/register.test.mts` (noul probability; choice with every option's probability; score with legend and level probabilities), with a configurable delay; it counts requests and requests still open.
- **Harness**: imports the built module (fresh instance per case via a query string), captures the two hooks from `register(on, options)` and calls them with a fake `$`: `env.get` from a map, `http.fetch` mapped to Node's global `fetch` (or an in-memory reply for CPU figures), `clock.after` mapped to `setTimeout`/`clearTimeout`, `tool.register`, `ui.log`, `model.complete` stubs; every op counted. `next` is an async function with a `signal` property (a fresh `AbortController` per call unless stated). This is not the Claude Code engine: engine dispatch costs (`$.env.get`, hook chain) are **not** in these numbers.
- Timings with `performance.now()`. Foreign-tool overhead: 400 samples x 1000 awaited calls after 50,000 warm-up calls. Request path: bare fetch and hook call interleaved, N = 1000 (stub delay 0) / 60 (50 ms). CPU per owned call: N = 2000 (100 for the 2.8 MB stress case). Memory: `heapUsed` after two `gc()` (`--expose-gc`).
- **Real System One**: bare `fetch` and the hook (through the harness) against `JEV_URL`, N = 10 for `noul` and `batch` of 3; batch scaling 3 runs each. About 80 requests in total.
- **Haiku fallback**: only with a stubbed `$.model.complete` (no model call); prompt and reply sizes from the actual `model.complete` arguments; token counts are estimates (no tokenizer run).
- Test suite: `pnpm test` in `jev-api/`, 3 runs with `JEV_URL` unset, 2 with it set; `--reporter=verbose` for per-test times.

## Results

### Foreign tools (F10)

| Variant                            | Median us/call | p90 us/call | Microtask ticks | Heap B/call (no GC) |
| ---------------------------------- | -------------- | ----------- | --------------- | ------------------- |
| `next(e)` alone                    | 0.106          | 0.159       | 1               | 38.7                |
| empty async pass-through hook      | 0.136          | 0.192       | 3               | 78.1                |
| jev-api `onToolCall`, foreign tool | 0.208          | 0.265       | 3               | 59.4                |

0 engine ops per foreign call; heap flat over 1,000,000 calls (30.71 -> 30.68 MB).

### Registration (F02, F03)

| Case                                                    | Result                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| `session.start`, instant `tool.register`, 300 instances | 84.8 us median, 113.4 us p90                                        |
| `session.start`, 5 ms per `tool.register`               | 5.79 ms (four in parallel)                                          |
| `batch` registration rejects once, 2x `session.start`   | `batch` never registered again, 1 log line                          |
| `tool.register` never settles                           | `session.start` and an owned call pending after 2000 ms, 0 requests |

### Request path (F07, F11)

| Case                            | Bare fetch median (p90) ms | Hook median (p90) ms | Overhead |
| ------------------------------- | -------------------------- | -------------------- | -------- |
| stub, `batch` of 3, delay 0     | 0.300 (0.372)              | 0.350 (0.423)        | +0.05 ms |
| stub, `batch` of 3, delay 50 ms | 50.86 (51.07)              | 51.09 (51.28)        | +0.2 ms  |
| real System One, `noul`         | 49.5 (82.7)                | 49.9 (58.0)          | noise    |
| real System One, `batch` of 3   | 130.0 (165.1)              | 129.4 (156.5)        | noise    |

Per owned call: 4 `env.get`, 1 `http.fetch`, 1 `clock.after`, 1 cancel; an invalid input still makes 4 `env.get`. Plugin CPU with an instant fetch: `noul` 87.9 us, `batch` of 3 86.1 us, 30 compaction scores 213.9 us (30 KB request), one 255-option choice 274.7 us (59 KB), 50 such choices 9.8 ms (2.8 MB).

### Real System One latency by batch size (F01, F13)

| Request                                         | Median ms              | Runs                     |
| ----------------------------------------------- | ---------------------- | ------------------------ |
| batch of 1 short score                          | 145.8                  | 145.8 / 136.4 / 146.2    |
| batch of 5                                      | 433.5                  | 433.5 / 439.6 / 394.2    |
| batch of 10                                     | 734.7                  | 749.2 / 732.6 / 734.7    |
| batch of 30                                     | 2172.4                 | 2206.5 / 2168.3 / 2172.4 |
| batch of 30 compaction-sized (~600-char) scores | 4097.8                 | 4128.6 / 4091.6 / 4097.8 |
| 10 short singles in parallel                    | 1102.0                 | 1 run                    |
| 10 compaction-sized singles in parallel         | 1794.9                 | 1 run                    |
| 3 singles sequential / parallel vs batch of 3   | 201.5 / 172.6 vs 130.0 | 1 run each               |

Latency is linear in the question count (~70 ms per short score, ~135 ms per compaction-sized one); parallel requests are slower than one batch. Parallel calls through the hook: 1 / 8 / 32 at once took 50.7 / 57.9 / 71.3 ms (bare 51.0 / 53.9 / 76.5), all 32 in flight on the stub.

### Timers, abort, memory (F05, F06, F09, F14)

| Case                                     | Result                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| 1000 answered calls                      | 1000 timers created, 1000 cancelled, 0 live, 0 handles left                        |
| 50 timed-out calls (0.05 s, stub 300 ms) | all `timeout after 50ms`, 0 live timers, 50 requests still open on the stub        |
| 50 calls aborted in flight               | all `the call was abandoned`, 0 live timers, requests open until the stub answered |
| pre-aborted `next.signal`                | answers `the call was abandoned`, but 1 request sent                               |
| 10k HTTP calls, fresh / shared signal    | heap -0.10 MB / +12.34 MB (10,200 abort listeners left)                            |
| 10k Haiku calls, fresh / shared signal   | heap +0.07 MB / +8.61 MB (10,200 listeners)                                        |

### Haiku fallback (F04, F08, F12)

| Case                  | Prompt chars (+1275 system) | Est. input tokens | maxTokens | Min. reply chars | Est. reply tokens    | Plugin us/call |
| --------------------- | --------------------------- | ----------------- | --------- | ---------------- | -------------------- | -------------- |
| `noul`                | 163                         | 365               | 512       | 49               | 20                   | 115            |
| `batch` of 3          | 292                         | 402               | 1024      | 289              | 116                  | 147            |
| 30 compaction scores  | 29,877                      | 8,855             | 4096      | 3,183            | 1,273                | 372            |
| `choice`, 16 options  | 6,627                       | 2,212             | 512       | 456              | 182                  | 157            |
| `choice`, 40 options  | 11,883                      | 3,714             | 512       | 967              | 387                  | 194            |
| `choice`, 255 options | 59,123                      | 17,211            | 512       | 9,436            | 3,774 (does not fit) | 445            |

Estimates: system text ~4 chars/token, prompt ~3.5, JSON reply ~2.5. Repeated identical criteria are 26% of the compaction prompt. 5 identical calls made 5 model calls (no cache). Haiku latency was not measured.

### Test suite (F15)

`JEV_URL` unset: 68 passed, 4 skipped, vitest 0.51-1.03 s, wall 1.25-2.06 s, max RSS 187-254 MB. `JEV_URL` set: 72 passed, 0.92-1.21 s; the four live tests take 73-298 ms each. Slowest offline test 11 ms.

## Findings summary

| Id      | Priority | Status    | Finding                                                                                                 | Proof                                      |
| ------- | -------- | --------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| F01     | high     | open      | jevfort's 4 s budget < real latency of a 30-item compaction batch (4.1 s); jev-api timeout 5 s > budget | measured (real System One)                 |
| F02     | medium   | open      | failed tool registration never retried                                                                  | harness                                    |
| F03     | medium   | open      | hanging `tool.register` blocks session.start and every owned call                                       | harness; engine time limit unverified      |
| F04     | medium   | open      | Haiku `maxTokens` 512 per question too small for a choice over ~40-55 options                           | code + estimated token counts              |
| F05     | low      | open      | pre-aborted call still sends its request                                                                | harness                                    |
| F06     | low      | open      | abort listeners not removed (leak only with a long-lived signal)                                        | harness; engine signal lifetime unverified |
| F07     | low      | open      | 4 env dispatches per owned call, also for invalid input                                                 | harness counters; engine cost estimated    |
| F08     | low      | open      | Haiku prompt repeats identical criteria (26% of a compaction prompt)                                    | measured chars, estimated tokens           |
| F09     | low      | docs-only | timed-out or abandoned requests are not cancelled (no `signal` in `HttpInit`)                           | harness + engine typings                   |
| F10-F15 | none     | closed    | foreign-tool overhead, request overhead, cache, batch shape, timers/memory, test runtime                | measurement records                        |

## Bug hunt

Correctness defects met during the analysis (each a task with area `bug`): F02 (registration memo keeps failures), F03 (no bound on the registration wait), F04 (Haiku output budget), F05 (request after abort). Read but found correct: timeout timer cancelled on every path (`finally`), late rejections silenced (`request.catch`, `reply.catch`), the bearer key only over https, URL hiding in fetch errors, `names` only accepting `mcp__<plugin>__<type>` answers, the 30 s timeout cap. No fix was made in this analysis (docs only).

## Live validation

Not run in Claude Code: no `claude -p --plugin-dir` session, so the engine's own hook dispatch cost, its `$.env.get` cost, `next.signal` lifetime, hook time limits and Haiku latency through `$.model.complete` are unmeasured. Run against the real System One endpoint: yes, through bare `fetch` and the in-process harness (about 80 requests, plus the 4 live tests of the suite). No model (Haiku) call was made.
