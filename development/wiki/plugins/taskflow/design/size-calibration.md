# Size calibration: why the size step asks a `choice` and accepts at probability 0.5

Why taskflow's size step (since 3.3.0 the `Size` stage of `build-task-design.workflow.js`, before that build-task SKILL.md step 2.3) sizes with a `choice` question over S/M/L/XL, with these descriptions, and accepts the answer at `probabilities[choice] >= 0.5`. Measured 2026-11-27 against the real System One endpoint (taskflow 2.4.0). `size-task` implements it. Re-run the scripts below before changing the wording.

## Problem

The size step used a `score` question ("How large is the work?", criteria "S: a few lines in one place", "M: one component", ...) and accepted `confidence >= 0.6`. That held on only 11% of the 80 tasks below; the rest fell back to the skill's own reasoning.

## Findings

- A score's `confidence` is a spread measure of the four level probabilities (it is near 0 when the mass sits on two neighbouring levels, and the score is their mean), so qualitative criteria that overlap at the M/L border can never reach 0.6. Sharper descriptions fix this, a different question type fixes it more.
- A `choice` answer carries `probabilities` per option and a `confidence` that is a different, lower number (e.g. probability 0.77, confidence 0.70). The size step reads `probabilities[choice]`.
- System One is deterministic for a fixed request (192 repeated pairs: same answer, mean confidence difference 0.007), so repeats add nothing; differences between variants come from the prompt and from which tasks are in the corpus.
- The probability is informative: per bucket of `probabilities[choice]` the share of exact answers was 0% below 0.4, 50% at 0.4-0.5, 79% at 0.5-0.6, 71% at 0.6-0.7, 93% at 0.7-0.8 and 96% from 0.8 (80 tasks, final prompt). Between 0.6 and 0.45 the accuracy of the accepted set barely falls (89% to 83%), so 0.6 only cost accept rate; 0.5 was chosen.
- Worked-out descriptions beat anchors by counting: a `choice` with one worked example per level (flag/option/label/doc note for S; new logic plus tests inside one plugin for M; new module plus callers, a whole plugin or two to four plugins for L; repository-wide for XL) was the best of about 14 variants.
- "pick the larger when it could be two neighbouring options" in the instructions lowers undersizing (undersizing costs more: S gets sonnet, L/XL get the `max` review).
- Variants that fed the number of subsystems into the state looked best on the tuning set (up to 85% accept) but only because the hand-written subsystem lines of the corpus correlate with the label; the real scout returns 1 to 4 lenses. Every result below is also given with the subsystem lines removed.
- A yes/no decision tree (three `noul` questions combined by a rule) gave 46% accept at 0.6: `noul` probabilities sit at 0.6 to 0.8 for ordinary cases.

## Result

80 tasks (48 tuning, 32 held-out and written afterwards, never used to pick a wording; held-out was only run on the finalists). Label rule and tasks: `taskflow/scripts/size-calibration-corpus.ts` (labels from the merged diff of the commit: S one place, M one plugin and one concern, L one plugin above about 1000 lines or two plugins, XL five or more plugins or repository-wide) and `size-calibration-corpus-test.ts` (synthetic XL tasks are cross-cutting by definition).

| Variant                                        | Accept  | Exact of accepted | Undersized of accepted |
| ---------------------------------------------- | ------- | ----------------- | ---------------------- |
| old `score`, threshold 0.6                     | 11%     | 67%               | 2 of 9                 |
| shipped `choice` (`c8`), 0.6                   | 76%     | 89%               | 3 of 61                |
| shipped `choice`, **0.5 (shipped)**            | **91%** | **85%**           | 6 of 73                |
| shipped `choice`, 0.5, subsystem lines removed | 86%     | 80%               | 10 of 69               |

Held-out set alone (32 tasks), shipped prompt at 0.5: 94% accept, 90% exact. The remaining errors are neighbouring levels (S/M and M/L on tasks whose text hardly shows the scope; one L task called XL); no answer of the shipped prompt was off by two levels.

The residual fallback (about 9%) are the cases the model cannot tell apart from the text either; do not chase them by lowering the threshold below 0.5 (7 of 7 answers under 0.5 were wrong or half right).

## Caveats

- One machine, one endpoint, one day. Labels from diffs are noisy for borderline tasks; the 80 tasks are this repository's, in English and German, a handful of types. Another repository's tasks may sit differently.
- The Haiku fallback was measured separately (see below); its numbers are a `claude -p` stand-in for the engine's `$.model.complete`, one run per row, Haiku not checked for repeat spread.
- The planner's and ci-monitor's hints still use `confidence >= 0.6` on a `score` and a `choice` question; their accept rates were not measured.

## Haiku fallback (no Jev configured)

Measured 2026-11-27 with `size-calibration-haiku.ts`: `claude -p --model claude-haiku-5-5`, the fallback's own `HAIKU_SYSTEM` (read from `jev-api/src/hooks/haiku.ts`), the same question and descriptions as above, choice probabilities normalised as `checkAnswer` does. 80 tasks, one run each, 0 invalid answers.

| Variant | Accept at 0.5 | Exact of accepted | Undersized | Accept at 0.6 | Exact at 0.6 |
| --- | --- | --- | --- | --- | --- |
| Haiku, shipped prompt | 96% | 79% | 0 | 85% | 87% |
| Haiku, subsystem lines removed | 98% | 82% | 6 | 88% | 84% |
| Jev (for comparison) | 91% | 85% | 6 | 76% | 89% |

- The shared question and threshold 0.5 work for Haiku unchanged. Haiku is more confident than Jev (it accepts more) and errs upward (M called L, 4 to 10 of 20), not downward; its answers at probability 0.4 to 0.6 were only 27% to 50% exact, 0.6 to 0.8 about 75%, from 0.8 100% (so the 0.5 to 0.6 band is weak, but accepted accuracy at 0.5 still equals its overall accuracy of about 80%, which is what the skill's own reasoning would have to beat).
- Tried and rejected (script option removed afterwards): replacing the last sentence of `HAIKU_SYSTEM` ("pick the lowest level") for a choice by "pick the option whose description fits best". 86% exact at 0.5 with subsystem lines, 81% without: within the noise of 80 tasks, and the sentence is part of the score calibration jevfort relies on ([haiku-calibration](../../jev-api/notes/haiku-calibration.md)). `HAIKU_SYSTEM` stays as is; no jev-api change.
- Sharpening the choice probabilities (a power transform) would raise accept rate but cannot improve the ranking; not tried, Haiku already accepts 96%.
- Not measured: the engine's `$.model.complete` itself (a different call path from `claude -p`), repeat spread of Haiku.

## The `size-task` tool and its fallback model

The whole size step is one mod tool, `mcp__taskflow__size-task` (`taskflow/src/hooks/register.ts`; wording, threshold and answer reading in `size.ts`): jev-api's `request` through `$.tool.call` at `probabilities[choice] >= 0.5`, else a plain `$.model.complete` call with the same descriptions, else jev-api's unsure answer after all, a refusal only when nothing answered. The skill keeps a one-line own-reasoning net for a missing tool.

A plain model call with the shipped descriptions (`size-calibration-model.ts`, `claude -p`, same 80 tasks, measured 2026-11-27, one run each, 0 invalid answers except one Opus call that gave none):

| Model | Exact | Undersized |
| --- | --- | --- |
| claude-haiku-5-5 | 81% | 6 |
| claude-sonnet-5-5 | 84% | 2 |
| claude-opus-5-5 | 85% | 0 |

- A plain model with the descriptions is as accurate as Jev (85% at 0.5); the calibrated descriptions are what carries the result, not the backend. Opus is the fallback: it never undersized, undersizing is the costly error, and the fallback runs for about 9% of sizings.
- The 0.4 to 0.5 probability band of Jev is where the model answers; no measurement of whether the model beats Jev on exactly those items (7 items, too few).
- Live (Claude Code 2.1.332, `claude -p --plugin-dir taskflow/plugin [--plugin-dir jev-api/plugin] --setting-sources project`): with jev-api the tool answered `S (jev-api, probability 0.94)`; without jev-api `XL (model claude-opus-5-5; jev-api gave no answer)`. A taskflow mod reaches `mcp__jev-api__request` through `$.tool.call`, and registration worked in a fresh session.

## Rerun

`node taskflow/scripts/size-calibration-run.ts <out.jsonl> <variants> 1 <dev|test|all>`, then `size-calibration-report.ts <out.jsonl>` (accept threshold: the shipped 0.5, `THRESHOLD=0.6` for the old one). `size-calibration-haiku.ts <out.jsonl> <variants> <dev|test|all>` answers the same variants with the Haiku fallback; `size-calibration-model.ts <out.jsonl> <models> <dev|test|all>` measures the plain model call of the tool with its own prompt. Variants are in `size-calibration-variants.ts`: `v0` the old score question, `c8` the shipped choice question (its source is `src/hooks/size.ts`), each also as `<name>:nosubs`. The other wordings tried (about a dozen: anchored score criteria, choice with counted subsystems, a yes/no tree) and their numbers are described above only; to try a new one, add it there. Needs `JEV_URL` or `TYPESAFE_BASE_URL` and `TYPESAFE_API_KEY` in the environment; nothing of them is printed or stored. A new wording is judged on the held-out set: ship only if accept rises without lowering the exact share and without more undersizing.
