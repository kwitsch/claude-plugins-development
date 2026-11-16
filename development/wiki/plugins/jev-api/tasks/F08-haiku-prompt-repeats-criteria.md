---
id: F08
title: Haiku prompt repeats identical criteria per question
status: closed
priority: low
area: jev-api/src/hooks/register.mts (askHaiku, HAIKU_SYSTEM)
---

## Status

Closed 2026-11-13, not done: optional (a shorter Haiku prompt for repeated criteria), changes the prompt shape the Haiku calibration was measured with and is only worth it if the fallback serves compactions in practice; reopen with a new measurement.

Earlier state: Open.

## Problem

`askHaiku` sends the questions as `JSON.stringify({ q0: question, q1: question, ... })`, with each question's full `criteria`. jevfort's compaction asks up to 30 `score` questions with the same four RELEVANCE levels, so the same 249-character array goes out 30 times. Input tokens are paid per call (the 1275-character `HAIKU_SYSTEM` alone is too short to be worth prompt caching).

## Evidence

Proven (harness with a stub `$.model.complete`, prompt sizes as sent):

| Case                                   | System chars | Prompt chars | Est. input tokens | maxTokens |
| -------------------------------------- | ------------ | ------------ | ----------------- | --------- |
| `noul`, 1 question                     | 1275         | 163          | 365               | 512       |
| `batch` of 3 (noul, choice, score)     | 1275         | 292          | 402               | 1024      |
| compaction, 30 scores x 500-char items | 1275         | 29,877       | 8,855             | 4096      |
| `choice`, 16 options x 200 chars       | 1275         | 6,627        | 2,212             | 512       |
| `choice`, 255 options x 200 chars      | 1275         | 59,123       | 17,211            | 512       |

The repeated criteria are 30 x (249 + key) ~= 7,830 characters, 26% of the compaction prompt. Estimated: token counts use ~4 chars/token for the system text and ~3.5 for the prompt (no tokenizer run); the saving would be ~2,000 input tokens per Haiku compaction.

## Code locations

- `askHaiku` (`prompt` template)

## Approach

Optional and small: when several questions share an identical `criteria` (compare `JSON.stringify`), list it once under a name (`"criteria_sets": {"c0": [...]}`) and refer to it from the questions, with one sentence in `HAIKU_SYSTEM`. Only worth doing if the Haiku fallback is used for compaction in practice; re-check the calibration numbers in `../CLAUDE.md` afterwards (the prompt shape changes).

## Verification

Kit test: a batch of 3 questions with the same `criteria` puts the array once in the `model.complete` prompt and the answers still map back. Re-run the calibration measurement if `HAIKU_SYSTEM` changes.

## Constraints

The System One request body stays unchanged (only the Haiku prompt). Answers keep the System One shape.

## Related

F04 (output budget), F12 (no cache).
