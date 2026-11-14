---
id: F21
title: "A state too large for System One is sent anyway: it fails with a 400, or runs into the timeout and keeps burning server time"
status: done
priority: medium
area: jev-api/src/hooks (jev.mts answerJev and ask, size.mts, input.mts, register.mts), jev-solver/plugin/skills/solve/SKILL.md (state = the whole task text)
---

## Status

Done in jev-api 0.4.0 (live validation at the end of this section). Found in the live analysis of 2026-11-14 against the real endpoint (jev-api 0.3.2, model `jev-latest`, answered by `d1-3b`).

What shipped (`CLAUDE.md` "Oversized state" has the details): `answerJev` refuses or reacts before sending when the optimistic estimate does not fit `min(n_ctx - 1, time budget)`, reads the server's `exceed_context_size_error` as exact numbers, and handles an oversized prompt per overflow mode (`error`, `truncate`, `haiku`; per-call input over the `overflow` userConfig option, default `haiku`). The characters per token are learned from every answer and refusal and kept across sessions in `$.store`, not in the plugin data dir: live on Claude Code 2.1.325 a mod cannot read `CLAUDE_PLUGIN_DATA` (`$.env.get` answers undefined), while `$.store` persisted between two `claude -p` runs. Tests: `jev-api/tests/overflow.test.mts` (both sides of every bound; a hand mutation of the preflight edge fails 5 of them). The source was split into modules (`types`, `util`, `tools`, `input`, `haiku`, `size`, `jev`, `registry`, `register`) at the same time.

Not done, follow-up: jevfort passes no `overflow`, so an oversized call of it would be answered by Haiku within its short budget; it may want `overflow: "error"`.

Earlier state: Open, nothing implemented; this document held the measurements and the proposed reaction below.

## Problem

`ask` sends every valid call, whatever the size of `state` and the questions. Two kinds of request are known to fail before they are sent:

1. **Over the hard limit (HTTP 400).** The server rejects a prompt above its context window. The reason text reaches the model unchanged (`HTTP 400: request (51948 tokens) exceeds the available context size (32768 tokens), try increasing it`); "increasing it" is not something the model can do.
2. **Under the hard limit but too slow for the timeout.** Latency grows with the token count, so a state of roughly 15k tokens or more cannot finish inside the default 20 s timeout, and one of about 21k tokens or more not inside the engine's 30 s `$.http.fetch` cap. The call answers `timeout after <ms>ms`, and the server keeps computing the abandoned request (F09), slowing every later request.

Neither failure is cheap, so "send it and see" is not an acceptable detection method (see Evidence, "Failing requests are not free").

Who can send such a state: jevfort clips every field (at most ~4 KB per field, about 4k tokens in total) and stays below both limits. `jev-solver:solve` sends the user's whole task text as `state`, and the model can call `mcp__jev-api__*` directly with any text.

## Evidence

All proven live (real endpoint, requests built like the plugin builds them; `usage.input_tokens` and `n_prompt_tokens` come from the server).

### Hard limit

- The limit applies to the whole prompt: `state` + the questions JSON + about 26 tokens of overhead. `n_ctx` is 32768 and the check is strict: a prompt of 32768 tokens is rejected, 32767 passes (and takes 42 s). `output_tokens` is always 0, nothing is reserved for the output.
- The rejection is `{ error: { code: 400, type: "exceed_context_size_error", n_prompt_tokens, n_ctx, message } }`, with the **exact** token count of the rejected prompt.
- A body above somewhere between 32 MB and 100 MB is answered `413` (100 MB: 0.9 s).
- Questions count: a `noul` question costs ~26 tokens, a `choice` option ~12 (10 options 144 tokens, 100 options 1224, 255 options 3084), a 10-level `score` ~106, a 20000-character instruction ~4177.

### Tokens per character vary by a factor of 8

Measured by repeating a sample to over 250 KB and reading `n_prompt_tokens` of the rejection (26 overhead tokens subtracted). Characters are UTF-16 code units (`String.length`).

| Content                          | chars/token                                     | chars at 32767 tokens |
| -------------------------------- | ----------------------------------------------- | --------------------- |
| repeated `a`                     | 8.0                                             | ~260k                 |
| English prose                    | 4.8                                             | ~157k                 |
| German prose                     | 3.8                                             | ~125k                 |
| Markdown (this repo's CLAUDE.md) | 3.6                                             | ~118k                 |
| TypeScript, JSON                 | 3.7                                             | ~122k                 |
| minified JS                      | 3.3                                             | ~107k                 |
| Cyrillic prose                   | 3.5                                             | ~115k                 |
| ANSI-coloured error log          | 2.9                                             | ~95k                  |
| CJK / Korean                     | 2.15                                            | ~70k                  |
| hashes and paths                 | 1.9                                             | ~62k                  |
| hex                              | 1.7                                             | ~57k                  |
| base64                           | 1.5                                             | ~50k                  |
| `ä€漢` text                      | 1.0                                             | ~32k                  |
| emoji                            | 1.0 (2 tokens per emoji, a surrogate pair) | ~32k                  |

In every sample the token count was at most the string length (UTF-16 units), never below 1.0 chars/token. A byte or character limit cannot be exact.

### Latency

Idle endpoint, uniform input of exact token counts, no prompt cache (repeated identical requests cost the same):

| prompt tokens | latency                         |
| ------------- | ------------------------------- |
| 1             | 0.06 s                          |
| 500           | 0.4 s                           |
| 1000          | 0.7 s                           |
| 2000          | 1.4 s                           |
| 4000          | 2.9 s                           |
| 8000          | 6.3 s                           |
| 12000         | 10.0 to 13.6 s                  |
| 16000         | 14.5 s (18.3 s once under load) |
| 20000         | 23.1 s                          |
| 24000         | 28.6 s                          |
| 28000         | 34.7 s                          |
| 32767         | 42.1 s                          |

Fit: `ms ≈ 0.7 * t + 1.8e-5 * t^2` (t = prompt tokens). A held-out check at 10k, 12k, 14k, 18k and 22k tokens gave ratios of measured to modelled time of 1.31, 0.91, 0.91, 1.10 and 1.06, so the model holds within about ±30 %. Token budget per timeout with a 1.3 safety factor:

| timeout                 | max prompt tokens |
| ----------------------- | ----------------- |
| 4 s (jevfort budget)    | ~4k               |
| 20 s (default)          | ~15k              |
| 30 s (engine fetch cap) | ~21k              |

Between about 21k and 32767 tokens a timeout is certain, whatever the client's setting.

### Failing requests are not free

- **Over-limit requests queue.** With a 16k-token request running (18.3 s), an over-limit request sent 1.5 s later got its 400 after 16.8 s, only when the big one finished. Two tiny requests sent at the same time took 6.8 s each instead of 0.06 s.
- **The rejection costs tokenisation time.** On an idle endpoint: 250 KB 0.5 s, 2 MB 3.7 s, 8 MB 15.6 s, 32 MB 43 s (about 2 s per MB).
- **An abandoned request keeps running.** A 16k-token request abandoned by the client after 2 s: a tiny request sent 0.3 s later still took 3.5 s (idle: 0.06 s).

## Code locations

- `parseInput`: validates `state` as non-empty text only; no size check.
- `ask`: builds `body` and sends it; the HTTP error path (`detail`) passes the server's reason on.
- `askHaiku`: the alternative that has no 32k window (`$.model.complete`).
- `register` / `tool.call` hook: where the effective timeout (call input, `userConfig` option, default, cap `MAX_TIMEOUT_S`) is known.

## Approach

Decide only what is certain before sending; use the server's own count for the rest. Cheapest first:

1. **Preflight, no request.** Estimate the prompt as `ceil(length(state) + length(JSON.stringify(questions))) / 3` (a typical-text density; Markdown, code and prose sit between 3.3 and 4.8) plus 26 tokens.
   - Hard-fail bound: even at the densest repetitive text (8 chars/token) `length / 8 + 26 > 32767` (about 260k characters) cannot pass. Reject without a request.
   - Time bound: when the latency model times 1.3 for the estimate exceeds the effective timeout, the call times out for sure. Reject without a request (and the server is spared the abandoned work). The constants (0.7, 1.8e-5, 1.3, 32767, 26) live in one place.
   - Everything else is sent. Dense content (base64, CJK, hashes) is underestimated by up to 3x; step 2 catches that for the hard limit, nothing can catch it for the timeout.
2. **Use the 400 as an oracle.** On `exceed_context_size_error`, `n_prompt_tokens` is exact. Retry **once** with the state cut to `floor(length * (32767 - 26 - margin) / n_prompt_tokens)` characters (head and tail kept, a marker in the middle) when the call allows truncation; never retry a second 400.
3. **Learn the density (optional).** A successful answer carries `usage.input_tokens`; keep an exponentially smoothed chars/token for the session and use it instead of 3 in step 1.
4. **What a "too large" answer does**, as a call input `overflow`:
   - `error` (proposed default): `{ deny: "<tool>: state is about N tokens, Jev takes at most M within the timeout; shorten it to about K characters" }`. The model can shorten the state itself, no silent accuracy change.
   - `truncate`: keep head and tail (for example 60 % / 40 %), put `[... N characters omitted ...]` in the middle, then send. jevfort and `solve` (whose states are summaries or task text) are candidates.
   - `haiku`: route to the existing `askHaiku` (no 32k window). Calibrated differently from Jev and costs model calls.
5. **Replace the server's text.** Map `exceed_context_size_error` to `Jev limit 32767 tokens, the request had <n>` instead of passing "try increasing it" on.

Not proposed: splitting the state into chunks and merging the answers; how to merge `noul`, `choice` and `score` answers depends on the question.

A decision on the `overflow` default (error vs truncate) needs the user.

## Verification

- Unit tests (kit, stubbed `$.http.fetch`): a state just below and just above each bound sends or does not send a request; the 400 oracle path retries once with the computed cut and does not loop; `overflow: "error"` answers a `deny` that names the numbers; the `batch` input shape and answer shape are unchanged (jevfort depends on them).
- Live (skill `live-verify` or a smoke test with `JEV_URL` set): an over-limit state answers locally in under 50 ms without a request; a dense state (base64, 60 k characters) hits the 400, is retried once and answers; no request is left running after a rejected timeout case.
- Re-measure the latency model after any change of the server model (`d1-3b` today); the constants are only valid for this model and context size.

## Constraints

- jevfort's `batch` shape stays (F01 note in jevfort's CLAUDE.md).
- The plugin has no tokenizer (zero dependencies, `node:` builtins only), so every token figure is an estimate; only the server's count is exact.
- Constants measured with one model and one context size (`n_ctx` 32768); read `n_ctx` from the 400 body when present instead of trusting the constant.
- Not measured: the accuracy cost of truncation, the endpoint under several concurrent clients, other models behind `TYPESAFE_DEFAULT_MODEL`.

## Related

F01 (budget below batch latency), F09 (an abandoned request keeps running), F12 (no answer cache), jevfort F02 (request size drives latency).
