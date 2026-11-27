# Mods engine: `$.http.fetch`, `$.model.complete`, `$.clock`, `$.mcp`, `$.ui`

Limits, error texts and cancellation behaviour of the mods API calls that reach outside the hook.

The constraints that follow load by themselves with [claude-code-hook-facts.md](../../../.claude/rules/claude-code-hook-facts.md); this page is the detail and the evidence. MCP server design is in [mcp-dual-era.md](../../../.claude/rules/mcp-dual-era.md).

## `$.http.fetch`

- `HttpInit` has `method`, `headers`, `body`, `compress`, `auth` and `socketPath` only. One call is capped at 30 s, redirects and body included, and bodies at 4 MiB (docs, binary 2.1.322). A `{ signal }` passed anyway is silently ignored: the fetch ran to completion at 17.8 s after an abort at 1 s (live 2.1.325).
- The only HTTP route a mod can kill is `$.process.run(["curl", ...], { timeoutMs })`: it kills the child at the timeout (default 30 s, at most 10 min), has no cancel handle (so no kill when `next.signal` aborts), needs `curl`, and the key must stay out of `argv` (docs, live 2.1.325).
- Error texts, all unredacted (binary 2.1.322):
  - timeout: `<plugin>: $.http.fetch(<url>) aborted: no complete answer within 30000ms`
  - failure: `<plugin>: $.http.fetch(<href>) failed: [<err.code>: ]<runtime message>`
  - a URL with `user:pass@`: `<plugin>: $.http.fetch: <host> refused: credentials in the URL` (host only)
  - a string `new URL` cannot parse: `...: not a URL: <raw string>`, which echoes the raw string including any userinfo
- A DNS failure quotes the bare host name, not the URL (`getaddrinfo ENOTFOUND <host>`), so redacting only the full URL leaks a private host. Redaction order: URL, then secret, then host (whole names only, ignoring case, IPv6 without brackets, since Node errors print `::1:443` where `URL.hostname` is `[::1]`); a secret may contain the host text, and a host may be part of ordinary words (live 2.1.325).
- A timed-out or abandoned request runs on until it settles or hits the 30 s cap. In `claude -p` and other headless runs the process exit and the next prompt wait for it; an interactive session does not (live 2.1.325).
- The engine drops a `host` header and validates no header values. Claude Code 2.1.319-2.1.322 embed Bun 1.4.4; since Bun 1.4.3 an invalid header value fails as `Header 'Authorization' has invalid value` without the value, older Bun and undici put the full value (a bearer key) into the message (binary 2.1.322).
- An own 30 s timer raced against the engine's 30 s cap is a coin toss within about 1 ms, so neither error text is guaranteed (measured with a Bun emulation, 2026-11-11).

## `$.model.complete`

- `$.model.complete(request, options?)`: `signal` is an option (second argument), not a request field. `maxTokens` and `timeoutMs` must be whole numbers >= 1 or the call is refused: seconds times 1000 can miss (`2.01 * 1000` is 2009.9999999999998), so round. Its own timeout comes back as `{ isAnswered: false, reason: "aborted" }`, the same as an aborted signal: tell the two apart by your own signal (typings 2.1.323, live 2.1.325).
- There is no `stop_reason` check: a reply cut at `max_tokens` that holds any text returns `{ isAnswered: true, text: <partial>, usage }`. Only a reply that is all thinking gives `{ isAnswered: false, reason: "empty-reply" }`. A cut-off summary can therefore stand as a full answer; only `usage.output_tokens` reveals it (binary 2.1.322).
- `usage` holds the four token counts only (no thinking tokens). `maxTokens` goes up to min(model limit, 64000) (binary 2.1.322, typings).
- For models that reject disabled thinking (`claude-haiku-5-5` in the engine table) thinking is left on, `max_tokens` becomes min(`maxTokens` + 2048, 64000) and thinking counts inside the cap (binary 2.1.322).
- `effort` (`low|medium|high|xhigh|max`) is accepted and sent on; omitting it means the model's default, which is `medium` for `claude-haiku-5-5` (binary 2.1.322).
- The request has no structured-output field. The checked fields are `model`, `prompt` and `system` (a string or blocks `{ text, cache? }`), `maxTokens`, `timeoutMs` and `effort` (binary 2.1.329). An unknown field is neither refused nor used: `output_config.format`, `outputFormat`, `responseFormat`, `format`, `schema` and `tools` with `tool_choice` each came back with an ordinary prose answer from `claude-haiku-5-5`, although the prompt asked for plain prose against a JSON schema, and no call threw (live 2.1.329, throwaway mod). A reply that must be JSON is therefore asked for in the prompt and validated by the caller.
- `$.model.classify(text, labels)` takes two positional arguments and returns the chosen label as a string (live 2.1.329). The object form `{ text, labels }` is refused with the message `takes { text, labels } (host check)`, as is any form with a `model` field, so the caller does not pick the model. It needs two or more non-empty labels, wraps the text in `<text>` tags under a fixed classifier prompt and returns no confidence and no probabilities (binary 2.1.329). Against `choice` through `$.model.complete` with `HAIKU_SYSTEM` (24 items, 3 option sets, 2 repetitions) it was not more accurate: JSON path 48/48, `classify` with the option descriptions in the text 48/48, `classify` with the labels only 46/48 (`npm install lodash` read as "network"); all answers were valid and stable between repetitions, the median latency was 560 to 570 ms against 687 ms (measured 2026-11-20, `claude-haiku-5-5`). It cannot stand in for `choice`, whose answer carries `confidence` and `probabilities`.
- `system: [{ text, cache: true }]` is passed on to prompt caching and `usage` reports `cache_creation_input_tokens` and `cache_read_input_tokens` (live 2.1.329, `claude-haiku-5-5`, same system text and a new prompt per request). A system of about 2,400 tokens wrote 2,396 tokens on the first request and read 2,396 on each of the next five (`input_tokens` fell from about 2,515 to about 120); one of about 6,900 tokens behaved the same. jev-api's `HAIKU_SYSTEM` (about 320 tokens, 590 tokens in all with the prompt) with `cache: true` wrote and read nothing, the same as without the flag, so a system below the model's minimum cacheable prefix gains nothing from it. Median latency did not improve in any variant (about 0.7 to 1.2 s). The debug log (`--debug-file`) replaces the values of `input_tokens`, `output_tokens` and the two cache fields with `[REDACTED]` wherever they appear as such keys: log the numbers under other key names (measured 2026-11-20).

## `$.clock`

- `$.clock.after`, `every` and `sleep` check only that `ms` is a finite number >= 0 and otherwise throw synchronously. The delay goes to Bun's `setTimeout` without a clamp, so a delay above 2^31-1 ms (about 24.8 days) fires after about 1 ms. Node 24's `setTimeout` and `node:timers/promises` do the same; `Bun.sleep` and `AbortSignal.timeout` do not. Clamp every timeout that comes from `userConfig` or tool input (binary 2.1.322, checked locally 2026-11-12).
- `$.clock.every` calls its callback without awaiting it and re-arms at a fixed rate: a slow async callback overlaps itself, nothing is dropped, and a throw is only logged (`the callback threw`). A callback that checks a guard before an `await` and sets it after must re-check after the `await` (binary 2.1.322).
- `$.clock.after` returns its timer synchronously. When a hook above refuses the timer, `fn` never runs and nothing rejects: a deadline built on it waits for the other side instead of failing fast (typings, live 2.1.322).
- `$.clock.sleep(ms, { signal })` rejects at once when the signal aborts (typings). Without a signal it has no cancel: a budget raced with `Promise.race` leaves one pending timer per call behind after the race settled. `$.clock.after(ms, fn)` returns `{ cancel }`; cancel it in `finally` (typings).

## `$.mcp`

- A `$.mcp.call` left pending at the main `turn.complete` of a `claude -p` run keeps the run alive until it answers: 33 s against 4 s for the same run without it (a 25 s call); the server saw neither a cancel nor a stdin close before it answered (live 2.1.332, P7). A mod must therefore arm a long-poll only when it knows the session is not headless.
- A mod's `$.mcp.call` (arguments and answer) left no trace in the session transcript, and the model, asked to list every line containing the marker, found none (live 2.1.332, P8).

- `$.mcp.connect("<key in .mcp.json>")` answers `{ isConnected, server }` on 2.1.332 (live 2.1.332, the `server` field is the name `plugin:<plugin>:<key>`); `$.mcp.call` takes that `server` string, and an object as first argument fails with `mcp.call: takes { server, tool, args? } (host check)` (live 2.1.332). Earlier note (live 2.1.325): `$.mcp.call(server, tool, args)` works headless without allow rules for a model-visible tool and resolves `{ isError, content: [{ type, text }] }`. `connect` inside `session.start` took 5 ms (live 2.1.325).
- The model sees such a tool as `mcp__plugin_<plugin>_<key>__<tool>` (live 2.1.325).
- A plugin's stdio MCP server inherits the whole environment of the Claude Code process, including the settings `env` block and the user's shell variables, without any `env` block in `.mcp.json`; `${VAR:-default}` interpolation in `.mcp.json` `env` works too (live 2.1.325).

- A killed stdio server (`kill <pid>` from a Bash step) is respawned by the next `$.mcp.call`: `connect` still answered `isConnected: true` in 4 ms, the following `call` took about 45 ms and was answered by a new pid (live 2.1.326, throwaway probe plugin, 2026-11-17).
- A server that exits right after start: `connect` answers `{ isConnected: false, reason: "failed", message: "... did not connect: Connection closed." }` after about 110 ms and does not retry within the session. The failure is cached across sessions: the next session's `connect` answers at once `Skipping connection (recent failure cached; retries automatically in 15 min, or edit the plugin config to retry now)`, even though the cause (a flag file) was gone. So a server must not exit to say "not configured" (live 2.1.326).
- A respawned server inherits the environment the Claude process had at launch: a `.claude/settings.local.json` `env` written mid-session reached neither `$.env.get` nor the respawned server (both kept the old value, live 2.1.326).

## `$.ui`

- `$.ui.log` lines are drawn as `<plugin>: <text>` (headless: `ui_log { plugin, text }`, debug log `[<plugin>] $.ui.log: <text>`): a mod must not prefix its own name. A refused `$.ui.log` is dropped and reported, never thrown into the hook (binary 2.1.322).
- `$.ui.toast(text, { timeoutMs })` and `$.ui.status(text)` are fire-and-forget and need no hook frame; `$.ui.invalidate` never throws (binary 2.1.322).
- `ui.render` for `AbovePrompt` (the band above the prompt, terminal and desktop only) is one nested chain per site: a hook that returns a tree without calling `next(e)` suppresses every hook beneath it. To share the band, `const below = await next(e)` and wrap `[below, own row]` in a column `Box` (binary 2.1.322, kit probe).
- The blank row under the `AbovePrompt` band is Claude Code's own layout: it shows with no plugin band drawn, between Claude Code's last line and the prompt box (live tmux capture, 2.1.327); in tmux `✔️` (VS16) draws 1 column while the layout reserves 2, leaving one extra space after it.
