# jevfort performance tasks

Source: performance analysis of jevfort 0.10.1 (with jev-api 0.3.2) on 2026-11-14, numbers in [EVALUATION-2026-11-14.md](EVALUATION-2026-11-14.md). One document per finding in `tasks/`; read it before working on the task. Proven = measured in the harness or against the real endpoint, or shown by the code; estimated = a derived figure (engine costs, 9P), marked as such in each task.

Legend: `[x]` finished (done, or closed without code: status `closed` in the task document). `[ ]` not finished; tag = `open` (not started), `partial`, `docs-only` (no code change intended; the remaining action is a documentation sentence).

## Done

None yet.

## Remaining

- [ ] [F01](tasks/F01-classifier-skill-list-latency.md) `open` high: the prompt classifier sends every listed skill (~32 ms each at the endpoint): 1.7 s per prompt at 50 skills, a timeout and a pause of every Jev feature from ~120
- [ ] [F02](tasks/F02-request-size-drives-latency.md) `open` medium: Jev latency follows the request size (~0.16 ms per byte); full clips cost ~3 s before the first token and 1.7 s per done check
- [ ] [F03](tasks/F03-turn-end-two-jev-requests.md) `open` medium: at >= 80% context fill the turn end asks Jev twice with the same state (1341 ms vs 762 ms as one batch) and reads the transcript twice
- [ ] [F04](tasks/F04-unbounded-stat-probes.md) `open` medium: `buildCandidates` stats every mentioned path of the whole turn one after another until 8 files qualify; missing paths are probed again at every step (2001 stats per step measured)
- [ ] [F05](tasks/F05-per-step-whole-turn-rescan.md) `open` low: every step re-scans the whole turn (`mentionedPaths`, `summarize`): 17 ms per step at a 10 MB turn, quadratic over a turn
- [ ] [F06](tasks/F06-record-rewrites-whole-log.md) `open` low: `record()` rewrites the whole log (321 KB at the cap) and the stats per decision: 20 `store.set` per 6-step turn, three of them before the first model request
- [ ] [F07](tasks/F07-repeated-static-engine-reads.md) `open` low: repeated engine reads of static facts (10 project probes per step, 3 env reads per ask, lists and the transcript read twice per turn): 28-43 ops per step
- [ ] [F08](tasks/F08-uncancelled-budget-sleeps.md) `open` low: `askJev`'s budget sleep and the 250 ms measurement grace are never cancelled; each ask leaves an engine timer pending for 4-15 s

## Closed without code (measurement records, decided 2026-11-14)

- [x] [F09](tasks/F09-foreign-tool-and-stream-overhead.md) Foreign `tool.call`/`tool.check` overhead (+0.15 us per call, 0 ops) and the stream pass-through (+0.57 us per chunk)
- [x] [F10](tasks/F10-parallel-turn-start.md) Classify and step 0 in parallel or as one batch: no gain, the endpoint answers one request after another
- [x] [F11](tasks/F11-test-suite-runtime.md) Test-suite runtime (196 tests, 1.6 s)
- [x] [F12](tasks/F12-memory-and-cache-tick.md) Memory (no leak) and the 15 s cache tick

## Notes

- F01 and F02 share the cause (System One latency grows with the request body); F01 is the case that crosses the 4 s budget and trips `jevPause`. Do F01 first.
- F03 and F07 both touch `turn.complete` (`checkDone`, `contextCompact`, `readTurn`): one transcript read and one batch can be done together.
- F04 and F05 touch `buildCandidates` and the per-step state; a per-turn cache keyed by `turnId` (cleared at `turn.complete`) serves both and F07's project probes.
- F06 must keep every store call in a hook frame (`.claude/rules/register-hooks.md`, "Storage calls must run in-frame") and the known limit "several sessions share one log" (CLAUDE.md).
- Not covered here: the compaction ranking budget and the hook bypass of `session.compact` (jev-api F19, `../../jev-api/docs/tasks/F19-jevfort-compaction-wait-and-hook-budget.md`).
