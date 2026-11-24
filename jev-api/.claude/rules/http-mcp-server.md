---
paths:
  - "src/mcp/**/*.ts"
  - "src/shared/http.ts"
  - "src/hooks/transport.ts"
  - "src/hooks/register.ts"
  - "src/hooks/jev.ts"
  - "mcp.template.json"
  - "tests/server.test.ts"
  - "tests/transport.test.ts"
  - "tests/http-core.test.ts"
---

# jev-api HTTP transport (bundled MCP server)

Live evidence and measurements: `development/wiki/plugins/jev-api/tasks/F22-http-through-mcp-server.md`.

## Why a server

- `$.http.fetch` has no signal and no timeout; `$.mcp.call` is not cancelled when the dispatch is abandoned either (not by `next.signal`, not by the 10 s hook budget; the server gets no `notifications/cancelled`).
- So `mcp.template.json` (generated `plugin/.mcp.json`) starts `mcp/server.mjs` (key `http`, name `plugin:jev-api:http`, tools `request`, `cancel`; dual-era, no tasks) and `transport.ts` calls it with `$.mcp.connect("http")` and `$.mcp.call`. The mod's `$.http.fetch` is used only when the server is not available.

## Protocol

- `request { callId, state, questions, timeoutMs }`. `request` takes no URL, header or key.
- The server runs the shared `sendRequest` with `fetch` under `AbortSignal.any([AbortSignal.timeout(timeoutMs), cancel])`, so the timeout and a cancel really close the connection.
- It answers an `Outcome`: `ok`; `http` with the redacted reason and the parsed context refusal; `error` (timeout, aborted, network, config). Redaction and the key never leave the server's code path.
- Guard: the server ends the request at `timeoutMs`; the mod gives up at `timeoutMs + 1500` (`SERVER_GUARD_MS`) or on `next.signal`, answers at once and fires one `cancel { callId }` (not awaited).
- A `cancel` that arrives before its request is remembered for 60 s (at most 256 ids, oldest out); `notifications/cancelled` also aborts.
- A call id is `<base36 time>-<counter>`, the counter moved before the `await` (calls side by side must not share one).
- The server splits its stdin at `\n` only, never with `readline`: `readline` also ends a line at U+2028 and U+2029, which `JSON.stringify` leaves raw (a state holding one arrived as two broken halves and was never answered).
- A network failure reaches the model as `fetch failed (<cause code>)`; the code names neither host nor port.

## Config

- The server reads `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `JEV_URL`, `TYPESAFE_DEFAULT_MODEL` from its own environment once at start; the mod sends no config (the `config` tool, `configGen` and the `unconfigured` retry are gone). The server inherits the Claude process environment, and `$.env.get` reads that same `process.env`, which does not change in a running process (a settings `env` written mid-session reached neither the mod nor a respawned server, live 2.1.326), so both always agree. [Smoke test](../../../development/wiki/facts/mods-engine-io.md)
- The server never exits for a missing configuration: Claude Code caches a failed start for 15 minutes across sessions (live 2.1.326). With none of the three variables set it answers a `config` error; the mod does not call it then (Haiku answers).
- A server killed from outside is respawned by the next `$.mcp.call` (live 2.1.326).

## Keeping the model off the server's tools

- A tool with `_meta.ui.visibility` without `model` is NOT callable by `$.mcp.call`, so both tools are visible (deferred behind ToolSearch).
- The `tool.check` hook allows origin `jev-api` and denies every other origin for `mcp__plugin_jev-api_http__*` (also when allowed by `--allowedTools`). A notice that `cc-plugin-sec-default` skipped the hook appears, but the deny applies.
- The server's tool `request` has the same bare name as the model-visible `mcp__jev-api__request`: `readOutcome` strips the server's own `request:` prefix from its input errors (`fail` adds the model-visible one), and `registerOne` accepts any `mcp__*__request` from a `tool.register` answer, so a forged answer naming the server's tool would be claimed (the real engine answers `mcp__jev-api__request`, live 2.1.327). Keep new server tool names distinct from `request`.

## Fallback

- When `$.mcp.connect` is not connected, throws, or answers nothing within 3 s, or a call throws or answers no outcome: the call goes through `sendRequest` with `fetchViaEngine` (the old race: no cancel, the engine's 30 s cap), logs `jev-api: HTTP server not available, using $.http.fetch: <reason>` once per outage and does not reconnect for 60 s.
- A `TypeError` of the connect call itself (no mcp API, a test double) is the same without the log.
- Only on this path does a timed-out or abandoned request run on, so callers still keep `timeout` at or below their own budget.

## Runtime

- Needs Node on the PATH for the server (the fallback covers its absence).
- Proxy: Node's `fetch` ignores `HTTP_PROXY` (Claude Code's `$.http.fetch` and bun honour it), so `.mcp.json` sets `NODE_USE_ENV_PROXY` to `${NODE_USE_ENV_PROXY:-1}` (Node 24.5 or later; a user can turn it off with `NODE_USE_ENV_PROXY=0`). `fetch` refuses port 9 itself (do not use it in tests).
- No bun launcher (decided on measurements in F22): bun starts slower, the other gains are noise against a real request, a `.sh` is not allowed in `plugin/`, and the proxy difference is covered by the variable.

## Endpoint, timeout, redaction (`src/shared/http.ts`)

- Endpoint (only with a variable set): `JEV_URL` > `${TYPESAFE_BASE_URL}/v1/systemone` > `https://api.typesafe.ai/v1/systemone`; an invalid set value is an error, never a fallback. Model `TYPESAFE_DEFAULT_MODEL` or `jev-latest`.
- Timeout via `$.clock.after`, cancelled when the request settles: the call's optional `timeout` input in seconds, else the `userConfig` option `timeout` (`register(on, options)`), else 20 s. A value counts only as a finite number > 0, anything else falls through silently; above 30 it counts as 30 (`MAX_TIMEOUT_S`: the engine caps one `$.http.fetch` at 30 s, and the engine's `$.clock.after` is Bun's setTimeout, which fires a delay past 2^31-1 ms at once). An aborted `next.signal` answers at once.
- The engine's fetch errors quote the URL (a DNS failure only the bare host), a runtime quotes a rejected header value whole, and a server may echo the request into an error body. So `sendRequest` redacts every error text it passes on (fetch errors and the HTTP error reason: its strings, object keys and numbers); a successful answer passes unchanged.
  - Numbers are matched on their source text (`JSON.parse` rounds a 20-digit key), and only when the key is made of number characters: a reviver over every number of a megabyte body took seconds.
  - The URL becomes the variable's name, the host `<host>`, a key of 6 or more characters `<TYPESAFE_API_KEY>`.
- The bearer key is sent only to an https endpoint; over http the same request goes out without `Authorization` (user decision 2026-11-11: the key never travels in cleartext).
- The live server answers every error, a missing field and malformed JSON included, as `{ error: { code, message, type } }`, e.g. an unknown model as 400 `model 'x' not found` (probed 2026-11-11). The public docs (docs.typesafe.ai/api/system-one, read 2026-11-11) say a top-level `detail` instead: a string for 400, an array for 422. `detail` reads both; a reason that is not a string is passed on as JSON text. Input limits of the live server: `.claude/rules/hooks-source.md`.
