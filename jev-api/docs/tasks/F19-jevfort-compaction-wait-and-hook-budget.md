---
id: F19
title: jevfort compaction now waits ~4.6 s for the ranking, and its 12 s / 15 s budgets exceed the engine's 10 s hook budget
status: partial
priority: medium
area: jevfort/src/hooks/register.mts (askJev, withJevRanking, onCompact), jevfort/src/hooks/jev.mts
---

## Status

Partly done, in jevfort 0.9.1 by sizing, not by a live check (the 15 s budget while Haiku answers is unchanged). Found live in the bug hunt: a 30 s in-flight `$.tool.call` inside `prompt.submit` was not cut at 10 s (which supports leaving the 15 s), but a live check of the compaction path itself is impossible for now, because in Claude Code 2.1.325 the built-in `cc-plugin-sec-default` bypasses every user-tier `session.compact` hook, so the ranking and Haiku compaction do not run at all for now (see jevfort/CLAUDE.md): the compaction ranking budget is 9 s (`COMPACT_TIMEOUT_MS`), below the engine's 10 s per hook in case the overlapping `$.clock.sleep` counts against it; a ranking takes about 4.6 s with 30 items. A live check of the hook time limit was not run.

Earlier state: Open: needs a live check and a decision. Found in the re-run on 0.3.2 / jevfort 0.9.1 (EVALUATION-2026-11-13.md).

## Problem

1. Cost of F01's fix: the ranking now succeeds, so every manual or auto compaction (not `precompute`, not subagents) waits for one System One batch of up to 30 scores before the summary starts: 4.5-5.1 s on the real endpoint, 12 s when Jev hangs (connection open, no answer). Before 0.9.1 the same wait was 4 s and then wasted.
2. Engine hook budget: `HookBudget.ms` is 10,000 per dispatch (2.1.323 typings). The clock stops while any `$` call of the hook is in flight, "a `$.clock` wait excepted", and a `$.clock.sleep` counts. `askJev` races `$.tool.call` against `$.clock.sleep(budgetMs)` with `budgetMs` 12,000 (compaction) or 15,000 (Haiku path, every hook). If the overlapping sleep counts while the tool call is in flight, the hook is cut at 10 s: `next(e)` runs on its behalf, the ranking and (for `session.compact`) the Haiku summary are lost, and `turn.step`/`prompt.submit` hooks lose their decision. If the in-flight `$.tool.call` stops the clock (the more likely reading), nothing happens. Not verifiable in the kit (it implements no hook time limits).

## Evidence

Proven (`chain.mjs`, jevfort's built `session.compact` hook -> jev-api's built hook -> real System One, 30 `Read` results of ~600 chars): 5 runs 4531 / 4596 / 4611 / 4771 / 5142 ms, all 30 scored; stub 12.5 s: fallback at 12,002 ms. Proven from typings: `HookBudget` (`ms` 10,000, `lingerMs` 5,000) and the clock rules quoted above. Estimated: the user-visible share of a compaction (the Haiku summary itself was not timed here; it is a model call with `timeoutMs` 240,000).

## Code locations

- jevfort `askJev` (`$.clock.sleep(budgetMs)` raced with `$.tool.call`), `withJevRanking`, the `session.compact` hook
- jevfort `jev.mts`: `COMPACT_TIMEOUT_MS`, `HAIKU_TIMEOUT_MS`, `MAX_ITEMS` in `compact.mts`

## Approach

1. Live check (skill `live-verify`): a jevfort `session.compact` with a jev-api that answers after 11 s (e.g. `JEV_URL` to a local stub) under `claude -p --plugin-dir`; read the debug log for a `timeout` of the hook and check whether the ranking arrives. Same for a `prompt.submit` with the Haiku path.
2. If the sleep counts: replace `$.clock.sleep` by a timer that is not a hook wait (`$.clock.after` resolving a promise, as jev-api's `within` does) or keep every budget at or below ~9 s (compaction 9 s still covers the measured 5.1 s worst run).
3. Decide the wait: keep (a 4.6 s ranking ahead of a summary that takes longer anyway), or lower it (rank only the newest 15 items, ~2.3 s at ~150 ms per score, or skip the ranking for `auto` compaction where the user waits). Decision by the user or a decision agent; reasoning into this document.

## Verification

Live result in a new dated evaluation; a kit test only for the chosen budget constants.

## Constraints

jevfort must not block a compaction for longer than its budget; jev-api's `timeout` input stays equal to the budget (F01).

## Related

F01, F09, F20.
