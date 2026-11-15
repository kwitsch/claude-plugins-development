---
paths:
  - "src/hooks/size.ts"
  - "src/hooks/jev.ts"
  - "src/hooks/input.ts"
  - "src/hooks/register.ts"
  - "tests/overflow.test.ts"
  - "tests/size-knowledge.test.ts"
---

# jev-api oversized state

Measurements (token densities, latency table, live validation): `docs/tasks/F21-oversized-state-sent-blindly.md`.

## Limits (constants block in `size.ts`)

- System One refuses a prompt (state + questions JSON + 26 tokens) of 32768 tokens or more (`n_ctx` 32768) with HTTP 400 `{ error: { type: "exceed_context_size_error", n_prompt_tokens, n_ctx } }` (exact count).
- Latency is about `0.7 t + 1.8e-5 t^2` ms for `t` tokens (model `d1-3b`, +-30 %): the 20 s default timeout fits ~15.6k tokens, the engine's 30 s cap ~21k.
- The constants are measured for one model and one context size; keep them in the constants block.
- The server's `n_ctx` from a 400 replaces 32768 while the endpoint (`JEV_URL`, `TYPESAFE_BASE_URL`) and the model stay the same; a change resets it (`know.nctxFor`).

## Preflight (`answerJev`)

- Runs from the `tool.call` hook for a configured Jev only. Haiku-only calls skip all of it, store included, except that `register.ts` caps their state at 150000 characters with `cutState`.
- `budget = min(n_ctx - 1, timeBudgetTokens(timeoutMs))`, at least 1000 tokens: a prompt that small is always sent, even with a very short timeout. At that floor the timeout deny names no size (neither "about N fit" nor a state size to shorten to), only "raise the timeout": a floor-sized prompt still times out.
- Refuse before sending only when the OPTIMISTIC estimate `ceil(chars / min(8, 2 * max(3, learned density))) + 26` exceeds the budget. The learned density never tightens the preflight (dense calls skew it; incident in F21); it only sizes cuts.
- Everything else is sent; the server's 400 is the exact oracle (`ask` returns `{ tooBig }` instead of an error).

## Overflow mode

Per call: input `overflow` > `userConfig` option `overflow` (invalid: `haiku`) > default `haiku`.

- `error`: deny with the numbers and a size to aim for in hundreds of characters.
- `truncate`: cut the middle (`cutState`: 60 % head, 40 % tail, marker, UTF-16 units, no split surrogate pair) to the budget (limit and timeout) at the learned density and, after a 400, at the exact density its count gave (a dense text such as hex would otherwise still run into the timeout); send once more; a second 400 is answered with the numbers (never a third request).
  - A cut that would keep no state at all (the questions fill the budget) sends nothing and answers `preflightError` (no refusal yet) or `tooBigError`.
  - The answer, `batch` array included, does not say it was cut.
- `haiku`: hand the state (cut over 150000 characters) to `askHaiku`.
- jevfort passes no `overflow`, so an oversized call of it would be answered by Haiku within its short budget; follow-up: jevfort may want `overflow: "error"`.

## Learned density (`$.store` key `density`)

- Chars per token, learned from every answer's `usage.input_tokens` and every refusal: samples under 400 tokens ignored, clamped to 1..8, smoothed 0.8/0.2, default 3.0. Stored as `{ v, n }`.
- Read once per instance with a 1 s bound (a refused read is read again by the next call; a read answering after the bound still counts); written fire-and-forget only when it moved over 10 %; a failing store never fails a call.
- `$.store`, not the plugin data dir: inside a mod `$.env.get("CLAUDE_PLUGIN_DATA")` is undefined; `$.store` persists across sessions.
