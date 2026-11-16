# jevfort performance tasks

Source: performance analysis of jevfort 0.10.1 (with jev-api 0.3.2) on 2026-11-14, numbers in [EVALUATION-2026-11-14.md](evaluations/EVALUATION-2026-11-14.md). One document per finding in `tasks/`; read it before working on the task. Re-analysis after the worklist (0.11.0, F13 and F14): [EVALUATION-2026-11-14-worklist.md](evaluations/EVALUATION-2026-11-14-worklist.md). Re-analysis after the option removal (0.12.0, F15 and F16): [EVALUATION-2026-11-14-option-removal.md](evaluations/EVALUATION-2026-11-14-option-removal.md). Proven = measured in the harness or against the real endpoint, or shown by the code; estimated = a derived figure (engine costs, 9P), marked as such in each task.

Entry format and sections: `.claude/rules/plugin-docs-tasks.md`; `wiki-check.ts` checks them against the `tasks/` frontmatter.

## Remaining

- [ ] [F14](tasks/F14-agent-type-choice-latency.md) `partial` medium: The agent-type choice waits ~1.15 s before every Agent dispatch and switched no type in 103 real calls
- [ ] [F15](tasks/F15-step0-take-questions-cost.md) `open` medium: Step 0's take questions double the main-loop step-0 request and took no step in 189 real asks
- [ ] [F16](tasks/F16-step-k-unused-transcript-read.md) `open` low: Every step k > 0 reads and splits the whole transcript, which with the defaults only the bypass follow-up step uses

## Done

- [x] [F01](tasks/F01-classifier-skill-list-latency.md) `done` high: The prompt classifier sends every listed skill; from ~120 skills every classification times out and pauses Jev
- [x] [F03](tasks/F03-turn-end-two-jev-requests.md) `done` medium: At >= 80% context fill the turn end asks Jev twice with the same state and reads the transcript twice
- [x] [F04](tasks/F04-unbounded-stat-probes.md) `done` medium: buildCandidates stats every mentioned path of the whole turn one after another, again at every step
- [x] [F05](tasks/F05-per-step-whole-turn-rescan.md) `done` low: Every step re-scans the whole turn (mentionedPaths, summarize), quadratic over a turn
- [x] [F06](tasks/F06-record-rewrites-whole-log.md) `done` low: record() rewrites the whole log and the stats per decision, in-frame on the critical path
- [x] [F07](tasks/F07-repeated-static-engine-reads.md) `done` low: Repeated engine reads of static facts per step and per turn
- [x] [F08](tasks/F08-uncancelled-budget-sleeps.md) `done` low: askJev's budget sleep and the measurement grace are never cancelled
- [x] [F13](tasks/F13-step0-skill-word-offers-every-skill.md) `done` high: A prompt that says "skill" makes step 0 offer every listed skill; from ~130 skills step 0 times out and pauses Jev

## Closed without code

- [x] [F02](tasks/F02-request-size-drives-latency.md) `closed` medium: Jev latency follows the request size; full clips cost ~3 s before the first token and 1.7 s per done check
- [x] [F09](tasks/F09-foreign-tool-and-stream-overhead.md) `closed` none: Foreign tool.call/tool.check overhead and the turn.step stream pass-through
- [x] [F10](tasks/F10-parallel-turn-start.md) `closed` none: Classify and step 0 in parallel or as one batch
- [x] [F11](tasks/F11-test-suite-runtime.md) `closed` none: Test-suite runtime
- [x] [F12](tasks/F12-memory-and-cache-tick.md) `closed` none: Memory and the 15 s cache tick

## Notes

- F01 and F02 share the cause (System One latency grows with the request body); F01 is the case that crosses the 4 s budget and trips `jevPause`. Do F01 first.
- F03 and F07 both touch `turn.complete` (`checkDone`, `contextCompact`, `readTurn`): one transcript read and one batch can be done together.
- F04 and F05 touch `buildCandidates` and the per-step state; a per-turn cache keyed by `turnId` (cleared at `turn.complete`) serves both and F07's project probes.
- F06 must keep every store call in a hook frame (`.claude/rules/register-hooks.md`, "Storage calls must run in-frame") and the known limit "several sessions share one log" (CLAUDE.md).
- F13 is F01's failure at step 0 (an option per installed skill); approach 1 is F01's fix. Do F13 first. F14 and F13 both grow with the installation (skills, agent types).
- 0.12.0 removed the classifier (F01), the done check (F03's merged batch now carries only the task end) and the decision log (F06): those fixes have no code left; their task documents stay as the record.
- F15 and F14 are the two Jev asks that cost latency on every turn or dispatch without a measured benefit; F16 is a leftover of the removed step measurement. F15 approach 1 and F16 both touch `onTurnStep` before the step-0 batch: they can ship together.
- Not covered here: the compaction ranking budget and the hook bypass of `session.compact` (jev-api F19, `../jev-api/tasks/F19-jevfort-compaction-wait-and-hook-budget.md`).
