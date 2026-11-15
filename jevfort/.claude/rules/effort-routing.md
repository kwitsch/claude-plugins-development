---
paths:
  - "src/hooks/policy.ts"
  - "src/hooks/candidates.ts"
  - "tests/policy.test.ts"
  - "tests/candidates.test.ts"
  - "tests/effort-fixture.test.ts"
---

# Effort estimate

- `estimateEffort` (`policy.ts`) is shared by step 0 and the `estimate_effort` tool; its two questions go out with the
  other step-0 questions in the same batch call. Upstream's difficulty->effort mapping and its difficulty question are
  gone.
- Rule, calibrated on `tests/fixtures/effort-scores.json` (numbers in the `MECHANICAL_FROM`/`EFFORT_CUTS` comments,
  history in `docs/EVALUATION-2026-11-15-live-notes.md`): p >= `MECHANICAL_FROM` gives `minEffort`; a missing or
  non-finite score gives the unclamped `defaultEffort`; otherwise `effortLevel(score)`, rounded and clamped.
- The score's confidence is NOT checked: the discarded scores were as accurate as the kept ones, and a threshold
  dropped every `high`/`xhigh` prompt.
- No model bias (never validated, it shifted the calibrated cuts per model); the tool's `model` input stays for callers
  and is ignored. The cuts are for `d1-3b`; jev-api's Haiku fallback is not calibrated.
- `tests/effort-fixture.test.ts` pins the acceptance numbers (A1 to A5).
- Opus/Sonnet sessions are estimated every turn; Haiku/Fable sessions only on each loop's first turn, whose estimate is
  then held while the session effort is unchanged. A model switch starts a new first turn.
- Bounds: options `minEffort`/`maxEffort`; invalid or inverted values fall back to `low`/`xhigh`.
- `words()` (`candidates.ts`) normalizes to NFC and splits at `[^\p{L}\p{M}\p{N}]`, so umlauts (also NFD-typed) and
  vowel signs survive; German prompts still share few words with English skill descriptions.
