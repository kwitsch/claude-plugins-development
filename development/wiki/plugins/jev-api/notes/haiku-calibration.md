# Haiku fallback: history and calibration

The rules that came out of this are in `../.claude/rules/haiku-fallback.md`.

## History

- 0.3.0: Haiku fallback (`askHaiku` over `$.model.complete`) when no Jev variable is set.
- 0.3.1: calibration toward Jev (below).
- 0.3.2: `choice` probabilities normalized to sum 1, like a score's.
- 0.5.0: a configured Jev that answers an HTTP error status is taken over by Haiku (`takeOver` in `answerJev`).

## Calibration measurement (2026-11-13, 0.3.1)

Method: `claude -p --model claude-haiku-5-5` on the 60 labelled DE/EN effort prompts of the jevfort evaluation, with the exact plugin questions and state. Harness and results were scratch files, not in the repo.

Raw Haiku overestimated:

- A2 hit rate 91 of 119 against Jev's 103.
- Mean score for high/xhigh/max prompts 2.71/3.13/3.71 against Jev's 2.4/2.86/3.22.
- It said 0.8 to 0.93 where Jev says >= 0.95 for mechanical prompts (4 of 24 low prompts >= 0.95, Jev 22).

Fixes: the calibration paragraph at the end of `HAIKU_SYSTEM`, the derived `score` (mean level index of the normalized probabilities) and the logit stretch of `noul` by `NOUL_STRETCH` 2.5.

Result over two independent 120-request runs with the shipped prompt and transforms:

- A2: 100 to 108 of 120 (Jev 103).
- A5: 44 to 50 of 60 (Jev 53, criterion 50; raw Haiku 47, so no reliable gain there).
- Mechanical: low 17 to 18 of 24 and medium 0 (Jev 22 and 0).
- Run-to-run spread is about 8 hits, so treat the numbers as +-4.

Only the effort rubric and the mechanical question were measured. The stretch also applies to every other `noul` (jevfort's take/done/single-action questions), which Jev answers confidently too, but that is unmeasured.
