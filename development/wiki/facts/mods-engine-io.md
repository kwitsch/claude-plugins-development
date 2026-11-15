# Mods engine: `$.http.fetch`, `$.model.complete`, `$.clock`, `$.mcp`, `$.ui`

Limits, error texts and cancellation behaviour of the mods API calls that reach outside the hook.

Basics (no `signal` on `$.http.fetch`, whole-number `maxTokens`/`timeoutMs`, redaction order, `$.clock.after` instead of a raced `$.clock.sleep`) are in [claude-code-hook-facts.md](../../../.claude/rules/claude-code-hook-facts.md); MCP server design is in [mcp-dual-era.md](../../../.claude/rules/mcp-dual-era.md).

## `$.http.fetch`

- `HttpInit` has `method`, `headers`, `body`, `compress`, `auth` and `socketPath` only. One call is capped at 30 s, redirects and body included, and bodies at 4 MiB (docs, binary 2.1.322). A `{ signal }` passed anyway is silently ignored: the fetch ran to completion at 17.8 s after an abort at 1 s (live 2.1.325).
- The only HTTP route a mod can kill is `$.process.run(["curl", ...], { timeoutMs })`: it kills the child at the timeout (default 30 s, at most 10 min), has no cancel handle (so no kill when `next.signal` aborts), needs `curl`, and the key must stay out of `argv` (docs, live 2.1.325).
- Error texts, all unredacted (binary 2.1.322):
  - timeout: `<plugin>: $.http.fetch(<url>) aborted: no complete answer within 30000ms`
  - failure: `<plugin>: $.http.fetch(<href>) failed: [<err.code>: ]<runtime message>`
  - a URL with `user:pass@`: `<plugin>: $.http.fetch: <host> refused: credentials in the URL` (host only)
  - a string `new URL` cannot parse: `...: not a URL: <raw string>`, which echoes the raw string including any userinfo
- The engine drops a `host` header and validates no header values. Claude Code 2.1.319-2.1.322 embed Bun 1.4.4; since Bun 1.4.3 an invalid header value fails as `Header 'Authorization' has invalid value` without the value, older Bun and undici put the full value (a bearer key) into the message (binary 2.1.322).
- An own 30 s timer raced against the engine's 30 s cap is a coin toss within about 1 ms, so neither error text is guaranteed (measured with a Bun emulation, 2026-11-11).

## `$.model.complete`

- There is no `stop_reason` check: a reply cut at `max_tokens` that holds any text returns `{ isAnswered: true, text: <partial>, usage }`. Only a reply that is all thinking gives `{ isAnswered: false, reason: "empty-reply" }`. A cut-off summary can therefore stand as a full answer; only `usage.output_tokens` reveals it (binary 2.1.322).
- `usage` holds the four token counts only (no thinking tokens). `maxTokens` goes up to min(model limit, 64000) (binary 2.1.322, typings).
- For models that reject disabled thinking (`claude-haiku-5-5` in the engine table) thinking is left on, `max_tokens` becomes min(`maxTokens` + 2048, 64000) and thinking counts inside the cap (binary 2.1.322).
- `effort` (`low|medium|high|xhigh|max`) is accepted and sent on; omitting it means the model's default, which is `medium` for `claude-haiku-5-5` (binary 2.1.322).

## `$.clock`

- `$.clock.after`, `every` and `sleep` check only that `ms` is a finite number >= 0 and otherwise throw synchronously. The delay goes to Bun's `setTimeout` without a clamp, so a delay above 2^31-1 ms (about 24.8 days) fires after about 1 ms. Node 24's `setTimeout` and `node:timers/promises` do the same; `Bun.sleep` and `AbortSignal.timeout` do not. Clamp every timeout that comes from `userConfig` or tool input (binary 2.1.322, checked locally 2026-11-12).
- `$.clock.every` calls its callback without awaiting it and re-arms at a fixed rate: a slow async callback overlaps itself, nothing is dropped, and a throw is only logged (`the callback threw`). A callback that checks a guard before an `await` and sets it after must re-check after the `await` (binary 2.1.322).
- `$.clock.after` returns its timer synchronously. When a hook above refuses the timer, `fn` never runs and nothing rejects: a deadline built on it waits for the other side instead of failing fast (typings, live 2.1.322).
- `$.clock.sleep(ms, { signal })` rejects at once when the signal aborts (typings).

## `$.mcp`

- `$.mcp.connect("<key in .mcp.json>")` answers the server name `plugin:<plugin>:<key>`; `$.mcp.call(server, tool, args)` works headless without allow rules for a model-visible tool and resolves `{ isError, content: [{ type, text }] }`. `connect` inside `session.start` took 5 ms (live 2.1.325).
- The model sees such a tool as `mcp__plugin_<plugin>_<key>__<tool>` (live 2.1.325).
- A plugin's stdio MCP server inherits the whole environment of the Claude Code process, including the settings `env` block and the user's shell variables, without any `env` block in `.mcp.json`; `${VAR:-default}` interpolation in `.mcp.json` `env` works too (live 2.1.325).

## `$.ui`

- `$.ui.log` lines are drawn as `<plugin>: <text>` (headless: `ui_log { plugin, text }`, debug log `[<plugin>] $.ui.log: <text>`): a mod must not prefix its own name. A refused `$.ui.log` is dropped and reported, never thrown into the hook (binary 2.1.322).
- `$.ui.toast(text, { timeoutMs })` and `$.ui.status(text)` are fire-and-forget and need no hook frame; `$.ui.invalidate` never throws (binary 2.1.322).
- `ui.render` for `AbovePrompt` (the band above the prompt, terminal and desktop only) is one nested chain per site: a hook that returns a tree without calling `next(e)` suppresses every hook beneath it. To share the band, `const below = await next(e)` and wrap `[below, own row]` in a column `Box` (binary 2.1.322, kit probe).
