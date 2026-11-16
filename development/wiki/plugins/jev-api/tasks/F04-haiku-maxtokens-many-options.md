---
id: F04
title: Haiku fallback maxTokens is too small for a choice with many options
status: done
priority: medium
area: bug (jev-api/src/hooks/register.mts: askHaiku, checkAnswer)
---

## Status

Done in jev-api 0.3.2: `haikuTokens` sizes `maxTokens` from the answer (base per question plus the options/levels each answer lists), capped at 16384. Test: "the Haiku output budget covers a choice with many options".

Earlier state: Open.

## Problem

`askHaiku` sets `maxTokens: Math.min(4096, 256 + 256 * questions.length)`, so one question gets 512 output tokens whatever its size. `checkAnswer` requires a `choice` answer to list the probability of every option (and a `score` answer every level). A choice with many options needs a reply longer than 512 tokens: the reply is cut off, is not JSON, and the call fails with `fallback: Haiku's reply had no valid choice answer` every time. jevfort's Agent routing asks one `choice` over every offered agent type (up to `MAX_CHOICE_OPTIONS` = 255), so a session with many agent types loses the routing whenever Haiku stands in.

## Evidence

Proven: the budget (512 for any single question, from the code) and the minimal reply sizes, built from realistic agent names (average 17 characters, probabilities written as `0.0123`, no whitespace):

| Options | Minimal reply chars | Est. tokens (2.5 chars/token) | Est. tokens (3.5 chars/token) | maxTokens |
| ------- | ------------------- | ----------------------------- | ----------------------------- | --------- |
| 12      | 441                 | 176                           | 126                           | 512       |
| 16      | 584                 | 234                           | 167                           | 512       |
| 40      | 1310                | 524                           | 374                           | 512       |
| 64      | 2036                | 814                           | 582                           | 512       |
| 255     | 7980                | 3192                          | 2280                          | 512       |

Estimated: the token ratio (no tokenizer was run; JSON with digits tokenizes densely), so the break-even is ~40 to ~55 options. Haiku's reply was not measured live (no model call in this analysis). The harness confirms the plugin side: with a stub that answers in full, a 255-option choice passes `checkAnswer` (445 us per call), so only the token budget is in the way.

## Code locations

- `askHaiku` (`maxTokens` expression)
- `checkAnswer` (requires every option / level)

## Approach

Size the budget from the questions: e.g. 128 tokens base per question plus ~16 per `choice` option and per `score` level, capped at the model's output limit (4096 today; raise the cap if Haiku allows more). One line in `askHaiku`; a helper only if it stays readable.

## Verification

As shipped: the test named under Status (the `maxTokens` of a 255-option choice is above 4096, a `noul` stays 512). The plan before the fix also had "a batch of 30 4-level scores keeps <= 4096": that no longer holds on purpose (30 four-level scores get 9856). An optional live check with `claude -p --model claude-haiku-5-5` on a 60-option choice was run in the bug hunt: 3.3 s, answered.

## Constraints

Never make up answers; a truncated reply stays an error. Token cost only grows for large questions.

## Related

F08 (prompt size), jevfort `MAX_CHOICE_OPTIONS` and the Agent routing hook.
