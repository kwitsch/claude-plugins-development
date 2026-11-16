# Evaluation 2026-11-15: live notes moved out of CLAUDE.md

No new run. Measurements, live checks and version history that `jevfort/CLAUDE.md` carried until 0.12.0, moved here by
the memory audit so the developer notes keep only directives. The current behaviour they back is described in
`../CLAUDE.md` and `../.claude/rules/*.md`.

## Method

Collected as written at the time; machine, harness and repetitions were not recorded with them. Re-measure before
relying on a number.

## Results

- Hanging Jev endpoint, before the timeout pause kicks in: +4 s before the first token of every turn (step 0), +4 s
  per Agent call and per subagent, +4 s for the task-end check (live). Earlier, with the done check:
  `EVALUATION-2026-11-14.md`.
- Compaction ranking: System One answers a batch question by question; 30 compaction-sized questions took 4.1 to
  5.1 s, hence `COMPACT_TIMEOUT_MS` 9 s.
- Effort rule: the 120-point measurement of 2026-11-13 (`tests/fixtures/effort-scores.json`, `d1-3b`) set
  `EFFORT_CUTS` and `MECHANICAL_FROM` (0.8 sent 16 of 24 medium prompts to `minEffort`).

## History

- 0.7.0: cache countdown, Haiku compaction and auto-compact ported from HeyCubit/effortless.
- 0.9.0: the effort rule above; the model bias removed by user decision (never validated, shifted the cuts per model).
- 0.12.0: `/jev`, the decision log, the done check, model routing, the prompt classifier, step measurement and every
  status-line message removed (`EVALUATION-2026-11-14-option-removal.md`).

## Bug hunt

None in this note.

## Live validation

Claude Code 2.1.325: the debug-log line per effort estimate (`claude --debug`), a non-boolean `routing` keeping the
module from loading, a hook's own `isError` dropped by core, and the `session.compact` bypass by
`cc-plugin-sec-default` (manual `/compact` in `claude -p` only). Read from the 2.1.322 binary, not run live:
`$.command.run` from a timer callback, the Haiku-path compaction trade-off, the missing `cache_creation` in step usage.
