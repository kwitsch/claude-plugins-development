---
id: F18
title: The Haiku fallback call is not cancelled when abandoned and runs at the model's default effort
status: done
priority: low
area: jev-api/src/hooks/register.mts (askHaiku)
---

## Status

Done in jev-api 0.3.2 for the abort signal: `askHaiku` passes `{ signal }` as the second argument (options) of `$.model.complete`; a first version put it into the request, where the typings have no such field (found by the bug hunt). `ModelCompleteRequest.effort` exists in the typings but is not set: an observation, not measured (thinking may take part of `maxTokens`). Test: "the Haiku call gets the abort signal as an option".

Earlier state: Open. Found in the re-run on 0.3.2 (EVALUATION-2026-11-13.md, "Re-run on 0.3.2 / jevfort 0.9.1") while checking F04 against the 2.1.323 typings.

## Problem

1. `askHaiku` calls `$.model.complete(spec)` without the second argument. The 2.1.323 typings offer `ModelCompleteOptions.signal`: "aborting it cuts the call while it runs, which then resolves `aborted`". When the call is abandoned, `askHaiku` answers at once (F05/F06 race) but the model call runs on to its end (up to jevfort's 14 s `timeoutMs`) and is billed. Unlike `$.http.fetch` (F09: `HttpInit` still has no `signal` in 2.1.323), this one can be cancelled.
2. No `effort` is sent, so Haiku 5.5 runs at its default (`medium`) with adaptive thinking on by default (`claude-api` skill, model table cached 2026-11-03). Thinking tokens count against `maxTokens`, so the F04 budget (512 for a `noul`, 4492 for a 255-option choice, 19% above the estimated minimum reply) may be partly spent on thinking and the JSON cut off (`fallback: Haiku's reply had no valid ... answer`). Whether the engine sends thinking for `$.model.complete` at all is not stated in the typings ("Default: the model's own").

## Evidence

Proven from the engine typings (`claude-code.d.ts` of 2.1.323: `ModelCompleteOptions.signal`, `ModelCompleteRequest.effort` default "the model's own", `maxTokens` up to min(model limit, 64,000)). Estimated: thinking share and latency at default effort (no model call made); the cost of a run-on call is small (Haiku 5.5: $0.10 / $0.50 per MTok).

## Code locations

- `askHaiku` (the `$.model.complete` call and its race)

## Approach

1. Pass `{ signal }` to `$.model.complete` (the call's `next.signal`); keep the race for an immediate answer.
2. Measure Haiku through `$.model.complete` (live, `claude -p --plugin-dir`) at the default effort and at `effort: "low"`: latency, `usage.output_tokens`, cut-off rate on the 255-option choice. Only send `effort: "low"` if the 0.3.1 calibration still holds at that effort (re-run the 120-prompt check, see `../CLAUDE.md` "Haiku calibration"), otherwise raise the per-question base of `haikuTokens` instead.

## Verification

Test: "an abandoned Haiku call is cut" (the kit's `model.complete` stub records the `signal` it got and that it aborted). Live numbers go into a new dated evaluation.

## Constraints

Calibration (0.3.1) was measured at Haiku's default effort through `claude -p`; changing effort changes answers.

## Related

F04, F05, F06, F09.
