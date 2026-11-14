# jevfort performance tasks

Source: performance analysis of jevfort 0.10.1 (with jev-api 0.3.2) on 2026-11-14, numbers in [EVALUATION-2026-11-14.md](EVALUATION-2026-11-14.md). One document per finding in `tasks/`; read it before working on the task. Proven = measured in the harness or against the real endpoint, or shown by the code; estimated = a derived figure (engine costs, 9P), marked as such in each task.

Legend: `[x]` finished (done, or closed without code: status `closed` in the task document). `[ ]` not finished; tag = `open` (not started), `partial`, `docs-only` (no code change intended; the remaining action is a documentation sentence).

## Done

- [x] [F01](tasks/F01-classifier-skill-list-latency.md) high (0.11.0): the prompt classifier offers only the related skills (at most 8, deduped) and no skill question without one: 254 skills 495 ms instead of a timeout ([EVALUATION-2026-11-14-F01.md](EVALUATION-2026-11-14-F01.md))
- [x] [F03](tasks/F03-turn-end-two-jev-requests.md) medium (0.11.0): at >= 80% fill the done check and the task end go out as one Jev request after one transcript read
- [x] [F04](tasks/F04-unbounded-stat-probes.md) medium (0.11.0): `buildCandidates` stats at most 16 not yet statted paths per call and caches stat results per turn: 32 instead of 4000 stats at step 40 of a 40 x 50-missing-path turn, each path once per turn ([EVALUATION-2026-11-14-F04.md](EVALUATION-2026-11-14-F04.md))
- [x] [F05](tasks/F05-per-step-whole-turn-rescan.md) low (0.11.0): `summarize` walks from the end and `buildCandidates` scans only new rows per turn (`mentionedPaths(texts, seen)`), no longer quadratic over a turn
- [x] [F06](tasks/F06-record-rewrites-whole-log.md) low (0.11.0): `record()` buffers decisions and `flushLog` writes the log and the counters once per turn (`turn.complete`, `session.end`, `/jev`): a 6-step turn 2 `store.set` instead of 20, none before the first model request
- [x] [F07](tasks/F07-repeated-static-engine-reads.md) low (0.11.0): project probes, cwd, env values, the tool and skill lists are read once per turn and the transcript once per step: a later step 20 -> 3 counted ops, step 0 28 -> 20
- [x] [F08](tasks/F08-uncancelled-budget-sleeps.md) low (0.11.0): the budget race and the measurement grace use `$.clock.after` and cancel it once the race settled: no timer stays pending for 4-15 s

## Remaining

- [ ] [F02](tasks/F02-request-size-drives-latency.md) `open` medium: Jev latency follows the request size (~0.16 ms per byte); full clips cost ~3 s before the first token and 1.7 s per done check

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
