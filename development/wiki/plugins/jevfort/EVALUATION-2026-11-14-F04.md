# jevfort evaluation 2026-11-14, F04 (plugin 0.11.0)

Re-measurement of the mentioned-path probes after F04 ([tasks/F04-unbounded-stat-probes.md](tasks/F04-unbounded-stat-probes.md)): `buildCandidates` stats at most `MAX_STATS` (16) paths per call that the turn has not statted yet, and keeps every stat result in the per-turn state (`turns`, dropped at `turn.complete`). Earlier figures: [EVALUATION-2026-11-14.md](EVALUATION-2026-11-14.md) (0.10.1, `bench2` missing-path rows).

**One machine only**: the same WSL2 machine as the analysis (12 vCPUs, ext4 work tree, Node v24). Fake `$`, zero-cost `fs.stat`; the engine's real stat cost is still not measured.

## Method

- Scratch vitest file in `jevfort/tests/` (removed before the commit) with two `claude-engine-vitest` kits: before = the built `plugin/hooks/` of `cbe02de` (extracted with `git archive`), after = this change. `session.messages` returns a turn of N steps, each a Bash call whose result (and tool text) names M paths `pkg/src/s<step>gone<i>.ts` that do not exist; every `fs.stat` denies `ENOENT`; Jev's batch call is denied (no candidate is taken).
- Options: `takeSteps` and `measureSteps` on, `takeOnlyForBypass` and `bypass` off, so each step > 0 builds the candidates twice (take branch, then the measurement branch). With the plugin defaults (`takeOnlyForBypass` on) a step > 0 builds them once, so halve the per-step counts below.
- Per case a fresh instance: first one late step (index N, the analysis's row), then steps 1 to N-1 of the same turn. 5 runs; the time is the late step alone (includes the kit's first-run warm-up, so only the stat counts are exact).

## Results

| Turn                  | Before: stats at step N / median (p90) ms | After: stats at step N / median (p90) ms | Before: stats steps 1..N-1 | After: stats steps 1..N-1 |
| --------------------- | ----------------------------------------- | ---------------------------------------- | -------------------------- | ------------------------- |
| 20 steps x 25 missing | 1000 / 66.8 (104.4)                       | 32 / 39.4 (42.6)                         | 19000                      | 468                       |
| 40 steps x 50 missing | 4000 / 51.5 (79.0)                        | 32 / 12.4 (13.4)                         | 156000                     | 1248                      |

p90 = the slowest of the 5 runs. Stat counts were identical in all 5 runs.

Before matches the analysis (501 and 2001 stats per step with one build per step). After, one build costs at most 16 stats whatever the turn holds, and a path is statted once per turn: over the 20-step turn every one of the 500 distinct paths is statted exactly once (32 + 468). Estimated with the analysis's 0.7-2.5 ms per stat on 9P: at most 11-40 ms per build instead of 0.35-5 s per step.

## Bug hunt

Not run. Kit test `tests/register.test.mts` "A turn's mentioned paths are statted at most 16 per step and each once per turn" (100 missing paths in the request, plugin-default options): at most 16 stats at step 0 and at step 1, no path statted twice; before the fix step 0 made 100.

## Live validation

Not run in Claude Code.

## Not changed

The order of offered reads (still the order of `mentionedPaths`); a read that would qualify behind more than 16 unprobed missing paths is offered at a later step of the turn, once the earlier ones are cached. The take and measurement branches still build the candidates twice in one step when `takeOnlyForBypass` is off (F05).
