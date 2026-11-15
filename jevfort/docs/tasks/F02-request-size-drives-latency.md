---
id: F02
title: Jev latency follows the request size; full clips cost ~3 s before the first token and 1.7 s per done check
status: closed
priority: medium
area: jevfort/src/hooks/register.mts (turn.step state, contextCompact, previousReply), jevfort/src/hooks/context.mts (summarize, clip)
---

## Status

Closed 2026-11-14 as a measurement record, no code change (user decision, shipped state 0.12.0). Reason: shortening the states would change the effort calibration (`EFFORT_CUTS`, `MECHANICAL_FROM` were measured on today's states) and the calibration prompts are not in the repository, so the accuracy cost cannot be measured; the ~0.16 ms per byte figure stays as the record.

Earlier state: open. Found in the performance analysis of 2026-11-14 ([../EVALUATION-2026-11-14.md](../EVALUATION-2026-11-14.md)), plugin 0.10.1.

Note (0.12.0): the done check, the prompt classifier and the step-k measurement (`measureSteps`) are gone; the task-end question is its own request. The figures below for them are history. Re-measured on 0.11.0 ([../EVALUATION-2026-11-14-2.md](../EVALUATION-2026-11-14-2.md)), still open: with every clip full the classifier takes 1100 ms (F01 cut its skill options) and step 0 1548 ms, 2.65 s before the first token; the turn end with done check and task end in one batch (F03) 1771 ms, the step-k measurement 1695 ms. A 4-step turn's done check 644 ms, step 0 617 ms, measurement 729 ms. The ~0.16 ms per byte model still holds.

Checked against 0.12.0 (2026-11-14), still open, waiting for a user decision; no code changed. What is left of the task:

- One request before the first token: the `turn.step` hook's step-0 batch (effort + mechanical, plus `next_action` with take-steps) with the state `request` (`clip(ctx.request, 4000)`), `previous_reply` (800), `recent` (`summarize(ctx.steps)`, empty at step 0 of a fresh turn) and `cwd`. With take-steps (default on, `takeOnlyForBypass` decides where) later steps send the same state with a full `recent`.
- The task-end question in `contextCompact`, only at >= `taskCompactPercent` fill and `reason: "answer"`: `clip(ctx.request, 3000)`, `final_message` 2000, `recent`.
- No change is free: the step-0 state is what the effort rule was calibrated on (`EFFORT_CUTS`, `MECHANICAL_FROM`), and `next_action` and the task-end question read `recent`. `tests/fixtures/effort-scores.json` holds only the recorded scores, not the 60 prompts, so approach 3 (re-run A1-A5 with shorter states) cannot run from this repository; the prompts would have to be recovered or a new prompt set measured. Trimming `recent` for the task end (approach 1) saves at most ~0.5 s on a rare path (high context fill) without an accuracy measurement either.
- Decision needed (user, or a decision agent with the prompt set): whether to accept an unmeasured accuracy risk for ~0.16 ms per byte, or to close F02 as a measurement record. Without the calibration prompts the recommendation is to leave the states as they are.

## Problem

System One's latency is about a 45 ms floor plus ~0.16 ms per byte of the request body, and the endpoint answers concurrent requests one after another. jevfort's states were sized for content, not latency: `request` clipped to 3000-4000 characters, `previous_reply` the last 800, `recent` eight summaries of up to 400 (assistant text) or 300 (input) + 400 (result) characters, `final_message` 2000, plus option descriptions. Every turn pays two requests before its first token (classifier in `prompt.submit`, step 0 in `turn.step`) and one done check at its end; with a long prompt and a busy turn the states reach 4-10 KB:

- Short turn (state ~0.6 KB): done check 149 ms.
- 4-step turn with 2 KB tool results (state 3.1 KB): done check 659 ms, task end 664 ms, step-k measurement 771 ms; classifier (20 skills) 848-885 ms plus step 0 616 ms = ~1.5 s before the first token.
- Every clip full: classifier 1442 ms + step 0 1570 ms = ~3.0 s before the first token; done check 1706 ms, task end 1708 ms, measurement 1689 ms.

The step-k measurement (removed in 0.12.0) added one such request per main-loop step; it was off the critical path, but on a serial endpoint a measurement still running delayed the next request behind it.

## Evidence

Proven, real System One through jev-api 0.3.2's built hook with the batch inputs jevfort 0.10.1's built hooks produced (3-5 runs each; tables in the evaluation). Tiny `noul` 45.7 ms; done check 0.6 / 3.1 / 9.7 KB state: 149 / 659 / 1706 ms; a second question in the same batch adds ~100 ms (done + task end 762 ms vs 659 ms). Same endpoint speed as the jev-api evaluation of 2026-11-13 (batch of one short score 146 ms then). Estimated: the accuracy cost of shorter clips (not measured; the effort calibration of 0.9.0, `tests/fixtures/effort-scores.json`, was measured with the states as they are).

## Code locations

- `onPromptSubmit`: `clip(e.text, 3000)`, `previousReply` (800).
- `onTurnStep`: step-0 state `clip(ctx.request, 4000)`, `previous_reply`, `summarize(ctx.steps)`, `cwd`; measurement state `clip(ctx.request, 4000)` + `recent`.
- `checkDone`, `contextCompact`: `clip(ctx.request, 3000)`, `clip(e.answer, 2000)`, `summarize(ctx.steps)`.
- `summarize` (context.mts): `limit = 8`, `clip(text, 400)`, `clip(JSON.stringify(input), 300)`, `clip(result, 400)`.
- `nextActionQuestion` (policy.mts): every candidate's description in the criteria.

## Approach

Measure accuracy before trimming; candidates, cheapest first:

1. Trim `recent` for questions that only need the request (classifier and step-0 effort/mechanical do not read `recent` at step 0 anyway; the done check needs the end of the turn): e.g. 4 entries of 200 characters for the done check and the measurement.
2. Shorter `request` clips (e.g. 1500) where the question is about the request's kind or effort; keep the long clip only where details matter.
3. Re-run `tests/effort-fixture.test.mts`-style acceptance (A1-A5) and a done-check sample with the shorter states against the real endpoint; keep a change only if the answers hold.

A decision on accuracy vs latency needs the user (or a decision agent, reasoning into this document).

## Verification

- Kit tests pin the new clip sizes (state length of each batch call).
- Re-measure the turn start, the done check and the measurement with full clips (`real3.mjs`-style) in a new dated evaluation; compare the answers on the same inputs.

## Constraints

The effort rule's calibration (`EFFORT_CUTS`, `MECHANICAL_FROM`) was measured on today's states: a state change that moves scores needs a recalibration. jev-api's `batch` shape stays.

## Related

F01 (the case that crosses the budget), F03 (one batch instead of two), F05 (the same per-step state built from the whole turn), F10.
