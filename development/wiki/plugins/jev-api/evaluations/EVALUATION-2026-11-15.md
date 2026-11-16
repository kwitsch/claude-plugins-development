# jev-api evaluation 2026-11-15 (plugin 0.5.0)

Fresh performance analysis of the built output of jev-api 0.5.0 (branch `refactoring/jev-api-261115` at `2b00669`; `pnpm --filter jev-api build` reproduced the committed `plugin/` byte for byte). Purpose: re-measure after the large changes since the 2026-11-13 runs (helper modules bundled into `lib.mjs`, oversized-state handling F21 in 0.4.0, the HTTP transport through the bundled MCP server F22 in 0.5.0) and compare with the earlier figures. New findings F23 and F24 in [TASKS.md](../TASKS.md). [EVALUATION-2026-11-13.md](EVALUATION-2026-11-13.md) keeps its numbers.

**One machine only**: WSL2 (kernel 6.18.33.2-microsoft-standard-WSL2), 12 vCPUs, 9.7 GB RAM, ext4 work tree, Node v24.22.2, Claude Code 2.1.325 installed but used only for `claude plugin validate`. The real System One endpoint came from `JEV_URL` in the shell (a private host, not in the repo); the endpoint server was changed before this run (see F22, re-measured 2026-11-15), so its latencies are not comparable with 2026-11-13 one to one. Treat differences below ~20% as noise.

## Method

- Scratch scripts in the session scratchpad (`jevperf/stub.mjs`, `lib.mjs`, `load.mjs`, `hooks.mjs`, `path.mjs`, `cpu.mjs`, `tmo.mjs`, `memserver.mjs` with the preload `gcprobe.mjs`, `real.mjs`, `realscale.mjs`; not committed). Rebuild from this description if needed.
- **Stub**: a `node:http` System One stand-in on 127.0.0.1, this time in its **own process** (answers in the shapes of the tests, configurable delay, counts requests, open requests, connections the client closed before the answer, and the most requests open at once). Because of the extra process, absolute loopback times are higher than on 2026-11-13 (bare fetch 1.5 ms against 0.3 ms); compare only within one table.
- **Harness**: imports the built `plugin/hooks/register.mjs` (which loads `lib.mjs` and `../shared/http.mjs`), captures the three hooks from `register(on, options)` (a fresh instance per case) and calls them with a fake `$`: `env.get` from a map, `clock.after`/`clock.now` on `setTimeout`/`Date.now`, in-memory `store`, `tool.register`, `ui.log`, `model.complete` stubs, `http.fetch` on Node's global `fetch`; every op counted. **Server path**: `$.mcp.connect` answers `plugin:jev-api:http` and `$.mcp.call` goes to a stdio JSON-RPC client in the harness process that spawns the built `plugin/mcp/server.mjs` (`initialize` 2025-11-25, then `tools/call`). This client stands in for the engine's MCP client: the engine's own dispatch and serialization cost are **not** in these numbers. **Fallback path**: a `$` without `mcp` (the connect call throws a `TypeError`, the call goes through `$.http.fetch` without a log line).
- Timings with `performance.now()`. Foreign-tool overhead: 400 samples x 1000 awaited calls after 50,000 warm-up calls (as on 2026-11-13). Request path: the three variants interleaved, N = 1000 (stub delay 0) / 60 (50 ms). CPU per owned call: N = 2000 (300 for the 120 KB state). Server memory: `process.memoryUsage()` after two `gc()` calls, triggered with `SIGUSR2` in a module preloaded into the server with `--import` and `--expose-gc` (the server code itself unchanged), RSS also from `/proc/<pid>/status`.
- **Real System One**: bare `fetch`, the hook through the server and the hook through the fallback, interleaved, N = 10 for `noul` and `batch` of 3; batch sizes 3 runs each through the server. 75 requests in total.
- Test suite: `pnpm test` in `jev-api/`, 3 runs with `JEV_URL` unset, 1 with it set; per-test times from vitest's JSON reporter.

## Results

### Shipped size and load

| File                     | Bytes  |
| ------------------------ | ------ |
| `hooks/register.mjs`     | 3,171  |
| `hooks/lib.mjs`          | 23,378 |
| `shared/http.mjs`        | 2,914  |
| `mcp/server.mjs`         | 6,975  |
| total JavaScript shipped | 36,438 |

0.3.2 shipped one unminified `register.mjs` of 19,821 bytes; 0.4.0 `register.mjs` 2,272 plus `lib.mjs` 20,425 (F21). Cold import of `register.mjs` with its two imports in a fresh Node process: 1.60 ms median (p90 1.67 ms), `register()` 0.133 ms (0.158), N = 20 processes.

### Foreign tools (F10)

| Variant                                           | Median us/call | p90 us/call |
| ------------------------------------------------- | -------------- | ----------- |
| `next(e)` alone                                   | 0.062          | 0.138       |
| empty async pass-through hook                     | 0.127          | 0.202       |
| jev-api `tool.call`, foreign tool                 | 0.163          | 0.217       |
| jev-api `tool.check`, foreign tool (new in 0.5.0) | 0.118          | 0.174       |
| jev-api `tool.check`, server tool from the model  | 0.384          | 0.461       |

2026-11-13 (0.3.1): 0.106 / 0.136 / 0.208. The `tool.call` hook costs 0.036 us more than an empty pass-through (0.3.1: 0.072); the new matcher-less `tool.check` costs no more than an empty pass-through. 0 engine ops per foreign call in both hooks.

### session.start

| Case                                                       | Result                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| no env (Haiku only), instant fakes, 300 instances          | 11.7 us median (27.1 us p90); 4 `env.get`, 4 `tool.register`, no connect     |
| `JEV_URL` set, instant connect and `config`, 300 instances | 20.2 us (63.7 us); plus 1 `$.mcp.connect`, 1 `config` call                   |
| `config` call answering after 5 ms, 30 instances           | 5.12 ms (5.16 ms): session.start waits for the connect and the `config` call |
| every registration and the connect never answer            | 8002 ms (5 s registration wait + 3 s connect wait), 1 log line               |
| every registration and the `config` call never answer      | 8006 ms                                                                      |
| built server: spawn to `initialize` answered (7 starts)    | 28.2 to 30.4 ms, median 28.4 ms; idle RSS 49.2 to 49.3 MB                    |

2026-11-13 (0.3.1, instant `tool.register`): 84.8 us median. The worst case stays below the engine's 10 s hook budget (`HookBudget.ms` in the 2.1.323 typings). In a real session `$.mcp.connect` took 41 ms (F22, live), so session.start now holds the chain for about the connect plus one `config` round trip.

### Owned call: engine ops and CPU

Engine ops per owned call (server path, after session.start): 4 `env.get`, 2 `clock.now` (the start time in `answerJev`, the call id), 1 `clock.after` (the guard) and its cancel, 1 `$.mcp.call` `request`. The first call of an instance adds 1 `store.get` and 1 `clock.after` (its 1 s wait). After any failed request (timeout, HTTP error, network error) the next call sends `config` again first (1 more `$.mcp.call`; measured: a timeout, then a call: 2 `request`, 1 `config`). Fallback path: 4 `env.get`, 2 `clock.now`, 1 `clock.after`, 1 `http.fetch`. Invalid input: 0 env reads, 0 clock reads, 0 MCP calls. 0.3.2: 4 `env.get`, 1 `http.fetch`, 1 `clock.after`.

Plugin CPU per owned call with an instant transport (a fake `$.mcp.call` answering at once; Haiku: an instant `$.model.complete`):

| Call                                | Median us (p90) | `request` arguments (chars) |
| ----------------------------------- | --------------- | --------------------------- |
| Jev `noul`                          | 11.5 (23.2)     | 160                         |
| Jev `batch` of 3                    | 26.5 (32.6)     | 384                         |
| Jev `batch` of 30 compaction scores | 211.7 (268.0)   | 21,756                      |
| Jev `choice`, 255 options           | 222.2 (283.2)   | 19,070                      |
| Jev `noul`, 120 KB state            | 137.6 (171.1)   | 120,138                     |
| Haiku `noul`                        | 7.8 (10.2)      |                             |
| Haiku `batch` of 3                  | 23.7 (27.6)     |                             |
| Haiku 30 compaction scores          | 247.4 (356.2)   |                             |

2026-11-13 (0.3.1, instant `$.http.fetch`): `noul` 87.9, `batch` of 3 86.1, 30 compaction scores 213.9, 255-option `choice` 274.7 us; 0.3.2 Haiku `noul` 6.8 us. The preflight (questions JSON, estimate) adds nothing measurable. Haiku `maxTokens`: 255-option `choice` 4492, 30 four-level scores 9856 (unchanged since 0.3.2).

### Request path (F11, F22)

| Case                            | Bare fetch median (p90) ms | Hook via server | Hook via `$.http.fetch` |
| ------------------------------- | -------------------------- | --------------- | ----------------------- |
| stub, `batch` of 3, delay 0     | 1.500 (1.687)              | 1.850 (2.156)   | 1.574 (1.789)           |
| stub, `batch` of 3, delay 50 ms | 50.870 (51.072)            | 51.376 (51.549) | 51.010 (51.187)         |
| real System One, `noul`         | 39.5 (40.6)                | 41.1 (42.6)     | 39.4 (40.9)             |
| real System One, `batch` of 3   | 127.8 (153.9)              | 130.4 (162.4)   | 127.3 (139.9)           |

The server path costs +0.35 to +0.5 ms on the stub and +1.6 / +2.6 ms against the real endpoint (noise there); the fallback path +0.07 to +0.14 ms. 2026-11-13 (0.3.1, real): `noul` 49.5 bare / 49.9 hook, `batch` of 3 130.0 / 129.4.

By state size (`noul`, stub delay 0, `timeout` 30, `overflow: "error"`, N = 50):

| State  | Bare fetch ms | Hook via server | Hook via `$.http.fetch` |
| ------ | ------------- | --------------- | ----------------------- |
| 1 KB   | 1.801 (2.054) | 2.234 (2.952)   | 1.894 (2.118)           |
| 10 KB  | 1.726 (2.017) | 2.176 (2.576)   | 1.837 (2.145)           |
| 60 KB  | 1.825 (2.058) | 2.452 (2.781)   | 1.898 (2.170)           |
| 120 KB | 2.069 (2.456) | 2.973 (3.450)   | 2.168 (2.576)           |

The state crosses one more JSON encode, pipe and decode on the server path: +0.4 ms at 1 KB, +0.9 ms at 120 KB, against seconds of System One time for a state of that size (F21 latency model).

Parallel calls through the server (stub 50 ms, 5 repetitions): 1 / 8 / 32 at once took 52.9 / 54.5 / 63.4 ms (bare 52.1 / 54.2 / 59.4), all 32 in flight on the stub at once. 2026-11-13 (fetch path): 50.7 / 57.9 / 71.3 ms.

### Real System One latency by batch size (F01, F13)

Through the hook and the server, `timeout` 30, 3 runs each:

| Request                                         | Median ms | Runs                     |
| ----------------------------------------------- | --------- | ------------------------ |
| batch of 1 short score                          | 60.2      | 293.4 / 58.9 / 60.2      |
| batch of 10 short scores                        | 283.0     | 300.9 / 280.1 / 283.0    |
| batch of 30 compaction-sized (~600-char) scores | 3364.9    | 3357.6 / 3364.9 / 3452.9 |

2026-11-13 (bare fetch, earlier endpoint): 145.8 / 734.7 / 4097.8 ms. The 30-item compaction ranking now takes about 3.4 s, well inside jevfort's 9 s compaction budget (F19); the first request of a fresh server paid about 0.23 s more.

### Timeout, abandonment and cancel (F09, F22)

| Case                                                     | Result                                                                                                                                 |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 50 calls at once, `timeout` 0.05 s, stub 300 ms, server  | answered after 91.7 ms (101.3 p90), `timeout after 50ms`; 0 requests open on the stub, 50 connections closed by the client, 0 answered |
| the same through `$.http.fetch`                          | answered after 58.2 ms (60.9); all 50 requests still open and later answered by the stub                                               |
| 50 calls abandoned at 20 ms, stub 300 ms, server         | answered after 21.6 ms (21.9), `the call was abandoned`, 50 `cancel` calls; within 500 ms all 50 connections closed, 0 answered        |
| the same through `$.http.fetch`                          | answered after 21.0 ms (21.5); all 50 requests ran to the stub's answer                                                                |
| server-side timeout, sequential (N = 10), 50 ms / 500 ms | late by 1.1 / 1.1 ms directly at the server, 1.7 / 1.4 ms through the mod                                                              |
| 10 / 50 direct requests at once, `timeoutMs` 50          | late by 3.1 / 11.4 ms                                                                                                                  |

2026-11-13 (0.3.1): 50 timed-out requests stayed open on the stub; F22 closes them (its live checks are in the task). No call id was refused as `already in use` among 50 calls side by side.

### One-off waits before a request (F24)

| Case (`timeout` 1 s)                                                   | Result                                                                                                           |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `$.mcp.connect` never answers, first call                              | 3003 ms, answered through `$.http.fetch`; the next call 0 ms                                                     |
| registration, `store.get` and `$.mcp.connect` never answer, first call | 5003 ms; the next call 0 ms                                                                                      |
| a network error, then the `config` call never answers                  | the next call 3001 ms, then 0 ms                                                                                 |
| built server stopped with `SIGSTOP` after a success, 3 calls           | 2502 ms (`timeout after 1000ms`: guard 1000 + 1500), 3008 ms (answered through `$.http.fetch`), 4 ms; 1 log line |

After `SIGCONT` the server answered the three JSON-RPC calls left pending (`request`, `cancel`, `config`) and the link stayed on the fallback.

### Timers, listeners, memory (F14)

| Case                                       | Result                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 1000 answered calls through the server     | 1001 timers created, 1001 cancelled, 0 live, 0 fired (the extra one: the first call's store wait) |
| 10k calls through the server on one signal | 10,000 abort listeners added, 10,000 removed; heap +0.13 MB; 0 live timers                        |

Server process memory (direct JSON-RPC `request` calls, no mod, stub delay 0, forced GC before each reading; MB):

| Requests (state)       | RSS default | heapUsed | heapTotal | RSS with `--max-semi-space-size=1` | heapTotal |
| ---------------------- | ----------- | -------- | --------- | ---------------------------------- | --------- |
| 0                      | 50.9        | 4.6      | 7.3       | 50.8                               | 7.3       |
| 2,000 (tiny), 4k run   | 131.9       | 11.1     | 77.1      | 95.3                               | 14.3      |
| 4,000 (tiny), 4k run   | 133.0       | 12.0     | 79.1      | 96.1                               | 15.8      |
| 2,000 (tiny), 20k run  | 155.7       | 11.7     |           | 105.6                              |           |
| 6,000 (tiny), 20k run  | 221.8       | 11.8     |           | 107.4                              |           |
| 20,000 (tiny), 20k run | 223.7       | 11.7     |           | 108.8                              | 16.1      |
| 1,000 (120 KB)         | 163.0       | 8.4      | 74.6      | 120.0                              | 13.3      |

Time per request in the same runs: 1.665 against 1.678 ms (20k, tiny), 2.731 against 2.897 ms (1000, 120 KB). `MALLOC_ARENA_MAX=2` changed nothing (129.8 MB after 4,000). Without forced GC the server of the timers run stood at 277.7 MB after about 11,000 mod calls. The JS heap does not leak (heapUsed flat at 8 to 12 MB); V8 grows its young generation (heapTotal 7 to 79 MB) and RSS follows: F23.

### Test suite (F15)

`JEV_URL` unset: 341 passed, 4 skipped (345), vitest 3.73 to 3.92 s, wall 4.45 to 4.79 s, max RSS 176 to 264 MB (3 runs). `JEV_URL` set: 345 passed, vitest 3.85 s, wall 4.57 s (1 run). Files run in parallel; the longest are `server.test.mts` 3.58 s (spawned server processes, real timers; slowest test 472 ms) and `build-lib.test.mts` 3.03 s (12 tests that each run a build, 188 to 405 ms); 18 tests over 100 ms take 4.7 s of 7.6 s summed test time. 2026-11-13 (0.3.2): 74 tests, 0.55 to 0.59 s. The growth is the new server and build tests, not a slow plugin path; no task.

## Findings summary

| Id                      | Priority | Status | Finding                                                                                                                                                                                     | Proof                                    |
| ----------------------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| F23                     | low      | open   | the transport server's RSS grows from 49 MB to 133 MB (4k requests) and 224 MB (20k) while its JS heap stays at 12 MB; `--max-semi-space-size=1` keeps it at 96 to 109 MB at the same speed | harness, server process with forced GC   |
| F24                     | low      | open   | a call's `timeout` does not bound it: one-off waits (registration 1 s, store 1 s, connect 3 s, `config` 3 s) come before the request; 5003 ms and 3008 ms for a 1 s timeout                 | harness                                  |
| F10, F11, F13, F14, F15 | none     | closed | re-measured: foreign-tool cost, request path (+0.35 to +0.9 ms on the server path), batch shape, timers and listeners, test runtime; no regression that needs work                          | measurement records (tasks not reopened) |

## Bug hunt

Not a full bug hunt (no reviewer agents, no fixes; docs only). Read during the analysis: `register.mts`, `transport.mts`, `jev.mts`, `size.mts`, `registry.mts`, `haiku.mts`, `input.mts`, `util.mts`, `types.mts`, `src/shared/http.mts`, `src/mcp/server.mts`. Defects met: F24 (a latency bound, not a wrong answer). Docs drift: F22's constraint "the next call waits for the guard again until the server answers" does not match the built code: a guard timeout marks the link `dirty`, so the next call sends `config` first, which waits 3 s on a stopped server, marks it down and answers through `$.http.fetch`; later calls use the fallback for 60 s (measured above, 2502 / 3008 / 4 ms). Read and measured correct: one `cancel` per given-up call (50 of 50), the cancel and the server timeout close the connection (0 of 50 answered by the stub), the server timeout answers within 1 to 2 ms sequentially, abort listeners and timers removed on every path, unique call ids under 50 calls side by side, `tool.check` refuses the model on the server's tools (0.384 us), an invalid call makes no env read and no MCP call.

## Live validation

Not run in Claude Code (no `claude -p --plugin-dir` session): the engine's `$.mcp.call` dispatch and JSON-RPC cost, its MCP client's behaviour with a stopped server, how long session.start really waits for `$.mcp.connect`, the dispatch cost of `$.env.get` and `$.clock.now`, `next.signal` lifetime and Haiku latency are unmeasured; the server was driven by the harness's own stdio client. Run: `claude plugin validate jev-api/plugin` passed (one README warning: no marketplace install line). Real System One: yes, 75 requests through bare `fetch`, the built server and the fallback path. No model (Haiku) call. Not re-run from 2026-11-13: the registration failure modes (F16, F17), the Haiku token estimates (F04, F08) and the jevfort chain (F01, F19, F20).
