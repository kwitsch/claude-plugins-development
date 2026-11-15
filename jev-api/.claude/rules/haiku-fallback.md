---
paths:
  - "src/hooks/haiku.ts"
  - "src/hooks/jev.ts"
---

# jev-api Haiku fallback

History and calibration measurements: `docs/HAIKU-CALIBRATION.md`.

## When Haiku answers

- After input validation, if none of `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `JEV_URL` is non-blank: `askHaiku` asks `$.model.complete` (`claude-haiku-5-5`) for `{ answers: { <id>: <answer> } }` JSON.
- A configured Jev that answers an HTTP error status (4xx or 5xx, not the 400 context refusal, which follows the overflow mode) is taken over by Haiku: `answerJev`'s `takeOver` gives it the call's timeout less the time since the call started (`$.clock.now`).
  - No time left: the HTTP error with `no time left for the Haiku fallback`.
  - An abandoned call is not handed over.
  - Haiku fails too: `<tool>: HTTP <status>: <reason>; fallback: <reason>`.
- A timeout, a network error or an invalid endpoint stays an error.
- Not a `claude -p` spawn (decided: effortless and jevfort use the engine call). jevfort raises its budget to 15 s in that case.
- The output budget (`haikuTokens`) grows with the options and levels the answers list (cap 16384).

## Answer checking

- `checkAnswer` rebuilds each answer in the System One shape (noul 0..1; choice must be an option with all option probabilities; score 0..levels-1 with all level probabilities; confidence 0..1), else `<tool>: fallback: ...`. Never a made-up answer.

## Calibration toward Jev (keep all three)

1. `HAIKU_SYSTEM` ends with a calibration paragraph: use the full noul range, spread probabilities, lowest level that fully handles the case, no whole-number scores.
2. `checkAnswer` ignores Haiku's own `score` and derives it as the mean level index of the normalized probabilities (like Jev's expected value; Haiku's `score` was rounded toward whole levels); probabilities normalized to sum 1.
3. `noul` is stretched in logit space by `NOUL_STRETCH` 2.5 (`stretch`).

Scope: only the effort rubric and the mechanical question were measured. The stretch also applies to every other `noul` (jevfort's take/done/single-action questions), unmeasured. Not calibrated: `choice` (probabilities only normalized to sum 1, like a score's) and the 4-level difficulty rubric. Run-to-run spread is about 8 hits in 120: treat measured differences as +-4.
