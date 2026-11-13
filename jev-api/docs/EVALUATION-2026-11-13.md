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

## Re-run on 0.3.2 / jevfort 0.9.1

Same day, same machine, Node v24.22.2, against the built `jev-api/plugin/hooks/register.mjs` (0.3.2) and `jevfort/plugin/hooks/*.mjs` (0.9.1) of branch `feat/jev-api-hardening` (worktree clean, no rebuild). Purpose: check F01-F07 against the built output with numbers and look for defects the fixes introduced. New findings F16-F20 in [TASKS.md](TASKS.md). The numbers above stay as measured on 0.3.1.

### Method (re-run)

- Scratch scripts (session scratchpad, not committed): `jevperf/rerun.mjs` (jev-api alone: the fake `$` of the first run plus per-tool `tool.register` counters, `maxTokens` capture and a scriptable `register` that rejects, hangs or waits) and `jevperf/chain.mjs` (jevfort -> jev-api -> System One: jevfort's built `session.compact` hook with `compaction: true, haikuCompact: false` on a transcript with 30 `Read` results of ~600 chars, then its `estimate_effort` tool call; the fake `$.tool.call` dispatches to jev-api's real `tool.call` hook and records the `timeout` input; real timers, real `fetch`).
- Endpoints: the local stub with a fixed delay (3.9 / 4.5 / 12.5 s), the real System One from `JEV_URL` in the shell (5 runs, 10 requests), and the Haiku path (no env, `$.model.complete` stubbed at 300 ms, no model call).
- Engine facts read from the Claude Code 2.1.323 mods typings (`claude-code.d.ts` written by the `plugin-authoring` skill): `HookBudget` (`ms` 10,000, `catchMs` 1,000, `lingerMs` 5,000), `ModelCompleteRequest.maxTokens`, `ModelCompleteOptions.signal`, `HttpInit`, `tool.register`. Haiku 5.5 limits from the `claude-api` skill (model table cached 2026-11-03). Not run in Claude Code.

### Fixes F01-F07

| Id  | Verified | Numbers (0.3.2 / 0.9.1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01 | yes      | Real System One, 30-item compaction through jevfort's hook: all 30 scored in 5 of 5 runs, 4531 / 4596 / 4611 / 4771 / 5142 ms (median 4.61 s; 0.9.0 gave up at 4 s). Stub 4.5 s: scored 3 of 3 (4504-4523 ms); stub 12.5 s: jevfort falls back at 12,002 ms, jev-api answers `batch: timeout after 12000ms` at 12,006 ms. jev-api `timeout` input: 12 (compaction), 4 (`estimate_effort`, interactive), 14 (Haiku path, both). Interactive `estimate_effort`, real endpoint: 234-385 ms.                                                                                          |
| F02 | yes      | `batch` rejects once at `session.start`: registered again by the next owned call (`batch` register count 1 -> 2), not a third time; all four registered over 3 hooks, 1 log line.                                                                                                                                                                                                                                                                                                                                                                                                 |
| F03 | partly   | Never-settling `tool.register`: `session.start` returns after 5003 ms, owned calls are answered after 1000.5-1002.1 ms (0.3.1: pending forever). But the hung round stays memoized: every later owned call pays 1 s and every `session.start` 5 s again, and no tool is registered again (4 register calls in total). See F16.                                                                                                                                                                                                                                                    |
| F04 | yes      | `maxTokens`: `noul` 512, choice with 1 / 10 / 255 options 527 / 662 / 4492 (255 names of ~35 chars: 6632), score with 10 levels 672, batch of 10 `noul` 2816, batch of 30 4-level scores 9856, batch of 3 choices x 255 options 12,964; cap 16,384. Legal: `$.model.complete` takes up to the model's output limit or 64,000, whichever is lower; Haiku 5.5 has 128K. The 255-option budget is 19% above the estimated minimum reply (3774 tokens), and Haiku 5.5 thinks by default (adaptive, effort `medium` when none is sent), so thinking may eat into it (F18, unmeasured). |
| F05 | yes      | Pre-aborted `next.signal`: `noul: the call was abandoned`, 0 requests on the stub, 0 fetches (0.3.1: 1 request). The 4 env reads still happen before the abort check.                                                                                                                                                                                                                                                                                                                                                                                                             |
| F06 | yes      | 10k calls on one shared signal: HTTP heap -0.06 MB, Haiku +0.10 MB, 0 listeners left (0.3.1: +12.34 / +8.61 MB, 10,200 listeners); fresh signals +0.26 / +0.05 MB; 0 live timers.                                                                                                                                                                                                                                                                                                                                                                                                 |
| F07 | yes      | Invalid input (`noul` without instructions, `batch` with a bad type): 0 env reads, 0 fetches (0.3.1: 4 env reads); a valid call still makes 4.                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### New measurements

| Case                                                                                | Result                                                                                                                                                           |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| healthy owned `noul` call (Haiku stub instant), 1000 calls                          | 6.8 us median (p90 12.7 us), 4 register calls in total, no `within` timer per call                                                                               |
| `batch` registration always rejects at once (setTimeout 0), 1000 owned `noul` calls | 1000 register attempts, 1000 `ui.log` lines, 1000 `within` timers (0 live), 1117 us median per call (the rejection's own latency)                                |
| `batch` registration always rejects after 50 ms, 20 owned `noul` calls              | 20 attempts, 20 log lines, 50.27 ms median per call (p90 50.39 ms)                                                                                               |
| 3 owned calls before `session.start` (`register` rejects until the session binds)   | 12 register attempts, 12 log lines; `session.start` then registers all four                                                                                      |
| only `score`'s registration hangs                                                   | `noul` calls still pay 1000.7-1002.2 ms each and `session.start` 5003 ms each: `Promise.allSettled` waits for the hung one, so `noul` is never marked registered |
| hanging registration + owned call with `timeout: 4` (stub 10 s)                     | answered `noul: timeout after 4000ms` after 5003 ms: jev-api's timer starts after the 1 s registration wait, past jevfort's 4 s budget                           |
| memo race: first round rejects after 30 ms, 8 owned calls in parallel               | one shared round (4 attempts), the next call retries (4 more), the third none; all 8 answered: no race in the `registering` reset                                |
| jevfort interactive budget vs jev-api `timeout` 4 (stub 4.5 s / 3.9 s)              | jevfort falls back at 4000-4001 ms (jev-api answers later, ignored) / both succeed at 3904 ms                                                                    |

### Test suite (re-run)

`JEV_URL` unset: 74 passed, 4 skipped, vitest 0.55-0.59 s, wall 1.29-1.40 s, max RSS 189-195 MB (3 runs). `JEV_URL` set: 78 passed, vitest 1.35 s, wall 2.10 s (1 run).

### Findings summary (re-run)

| Id  | Priority | Status | Finding                                                                                                                                             | Proof                                 |
| --- | -------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| F16 | medium   | open   | a hung registration stays memoized: every owned call waits 1 s, every session.start 5 s, never retried; one hung tool holds the other three         | harness                               |
| F17 | low      | open   | a permanently failing registration is retried on every owned call (1 attempt + 1 log line per call) and its latency is added to calls of every tool | harness                               |
| F18 | low      | open   | Haiku fallback call not cancelled when the call is abandoned (no `signal`), runs at the model's default effort with thinking inside `maxTokens`     | engine typings; model side unmeasured |
| F19 | medium   | open   | jevfort: every compaction now waits ~4.6 s for the ranking (12 s when Jev hangs); 12 s / 15 s budgets vs the engine's 10 s hook budget unverified   | real System One + typings             |
| F20 | none     | closed | jevfort's 4 s budget and jev-api `timeout` 4: jevfort always wins the race, harmless                                                                | harness                               |

### Bug hunt (re-run)

Defects introduced or left by the fixes: F16 (the `registering` memo keeps a hung round, and `Promise.allSettled` lets one hung tool block the bookkeeping of the other three), F17 (retry without back-off; F03's own task already noted that the wait is useless for the call being answered). Read and found correct: the `.finally` reset of `registering` (only one round in flight, measured), `within` cancelling its timer on both outcomes (0 live timers), `missing` shrinking only on success, the abort check before any request, listener removal in both `ask` and `askHaiku`, jevfort's per-path `timeout` inputs. `$.tool.register` replaces a tool registered again (2.1.323 typings), so a retry cannot duplicate a tool.

### Live validation (re-run)

Not run in Claude Code (no `claude -p --plugin-dir` session): the engine's hook budget for `session.compact` while `$.tool.call` and `$.clock.sleep` overlap (F19), whether an abandoned `$.tool.call` aborts jev-api's `next.signal`, the engine's real `$.tool.register` failure modes, and Haiku latency/thinking through `$.model.complete` are not measured. Real System One: yes, 10 requests through jevfort's built hooks and jev-api's built hook. No model call.

## Update after the re-run (same day)

F16 and F17 are done and F18 and F19 partly (see their task documents) in jev-api 0.3.2 / jevfort 0.9.1 (see the task documents): per-tool registration state with a once-paid wait and back-off, the Haiku abort signal as an option of `$.model.complete`, and a compaction ranking budget of **9 s** (the re-run measured the 12 s budget above; it was lowered to 9 s to stay under the engine's 10 s per hook). The tables above keep the numbers as measured.

## Bug hunt (fixes)

Round 1 (three reviewers: registration, request path, jevfort and docs) found: the bearer key and the endpoint could reach the model through an error text (a runtime quoting a rejected header value; an error body echoing the request URL) - both redacted now; the Haiku abort signal sat in the wrong argument; stale numbers and symbols in these documents; a damaged TSDoc. All fixed with tests.

Round 2: a Haiku call refused for a fractional `timeoutMs` (`2.01 s * 1000`): rounded to whole milliseconds. Round 3 (with live sessions on Claude Code 2.1.325): the endpoint host reached the model in a DNS error (`getaddrinfo ENOTFOUND <host>`): redacted; Haiku `choice` probabilities now sum to 1 like System One's. Round 4: a key containing the host text was broken up by the host step (order: URL, key, host), the host step damaged ordinary words (`jev-latest`; now whole host names only, ignoring case), a quadratic regex on whitespace in a Haiku reply. Round 5: IPv6 hosts (bare address in error texts), a Haiku timeout reading as `aborted` (now `fallback: timeout after Nms`), weak or missing tests (host order, listeners on the Haiku path), stale task documents.

Engine facts found live (2.1.325), recorded in `.claude/rules/claude-code-hook-facts.md`: plugin-registered tools run without a permission check (a deny rule withholds them), and the built-in `cc-plugin-sec-default` bypasses user-tier `session.compact` hooks.

Rounds 6-11 (reviewer runs in scratch directories, not kept in the repo; the numbers are theirs): two mutation rounds found surviving mutants in jev-api and in jevfort (a test was added for each); an oversized error reason from a server is now cut to 1000 characters after the redaction (a live session with a 400 KB reason sent it whole to the model); the registration wait is guarded in session.start and in owned calls, a stuck tool is waited for again at its retry, the registration log is not awaited, a non-string registration answer is not a failure; a Haiku `aborted` reads as abandoned when the call was; blank and astral error reasons; strings inside an object error reason are redacted before the JSON text is made (JSON escapes a quote or backslash in a secret). A redaction fuzz (about 140k generated cases) and a differential test of the Haiku path (20k cases) found one more leak (a secret as an object key of an error reason, fixed in round 11) and no mismatch.
