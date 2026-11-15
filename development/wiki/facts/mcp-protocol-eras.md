# MCP: how Claude Code negotiates the protocol era, tool `_meta`, and the tasks extension

What Claude Code's MCP client sends and expects in the 2025-11-25 and 2026-07-28 eras, in the detail a server author needs when something does not connect or a long-running tool is planned.

The constraints for a plugin's server (dual-era, types, cancellation) are in [mcp-dual-era.md](../../../.claude/rules/mcp-dual-era.md). Facts below were seen live on Claude Code 2.1.323 (2026-11-13) with a throwaway stdio server unless marked (binary) or (spec: modelcontextprotocol.io/specification/2026-07-28).

## Era negotiation

- Claude Code carries both eras. On stdio it first sends `server/discover` (id `server-discover-probe-1`, `params._meta` = `io.modelcontextprotocol/protocolVersion` `"2026-07-28"`, `clientInfo`, `clientCapabilities`). An answer whose `supportedVersions` contains `2026-07-28` makes the session modern: no `initialize` is sent. No answer (timeout), an error, or a result that does not validate falls back to `initialize` with 2025-11-25.
- Every modern request carries the same `_meta` envelope (`protocolVersion`, `clientInfo`, `clientCapabilities`) and needs `resultType` in the result (`"complete"`, `"task"`, `"input_required"`). A modern list-like result (`tools/list`, `server/discover`) also needs `ttlMs` (int >= 0) and `cacheScope` (`"public"`/`"private"`), and `io.modelcontextprotocol/serverInfo` in the result `_meta`.
- Error codes: unsupported version `-32022` with `data: { supported, requested }`; missing client capability `-32021`; resource-not-found is now `-32602`.
- `MCP_PROTOCOL_NEGOTIATION=legacy|auto` in the environment of the Claude process (for example settings `env`; a plugin cannot set it) forces the mode. Without it the stdio default is the probe, gated by the feature flag `tengu_mcp_protocol_negotiation_stdio` (default on).
- A per-server prior (binary: `burnedListingDiscoverPriors`) can skip the probe for a server config that listed legacy before: one old test server was never probed while a fresh copy was. What invalidates the prior is unknown.
- `mcp_tool` hooks work over the modern era: the hook call arrives as a normal `tools/call` with the envelope.

## Cancellation

- When a call is aborted, the client sends `notifications/cancelled { requestId, reason }`: no `id`, the modern `_meta` envelope inside `params`. Seen for an `mcp_tool` hook that hit its `timeout`: 4 cancels for 4 delayed calls. Work a handler does past its last check of the abort signal finishes in the background and its result is dropped.

## Types on npm (checked 2026-11-13)

- `@modelcontextprotocol/server` 2.x (Apache-2.0) exports the types including the 2026-07-28 ones. `@modelcontextprotocol/sdk` 1.x has no 2026-07-28 types, `@modelcontextprotocol/types` does not exist, `@modelcontextprotocol/core` exports zod schemas only.

## Tool `_meta` the client reads

- `ui.visibility` without `"model"` keeps the tool from the model and from ToolSearch; hooks still call it and `mcp_status` still shows it.
- `anthropic/alwaysLoad` (true: never deferred behind ToolSearch; at server level it also blocks startup until connected), `anthropic/searchHint`, `anthropic/maxResultSizeChars`, `anthropic/requiresUserInteraction` (forces a permission prompt), `anthropic/permissionDisplay`.
- The spec adds `title`, `icons`, `outputSchema` and `annotations` on tools (spec; annotation names not confirmed).

## Tasks extension (long-running tools)

- The client declares `io.modelcontextprotocol/tasks` in `clientCapabilities` of the discover probe in every mode, but on `tools/call` only in an interactive session with the feature flag `tengu_glowing_lark` on (default on for the normal CLI). `claude -p`, single-shot and headless runs, and `CLAUDE_CODE_DISABLE_MCP_TASKS=1` send no extension.
- Task creation: `{ resultType: "task", taskId, status: "working", ttlMs, pollIntervalMs }`; `taskId` is 1-128 printable ASCII characters without a space. The server must have stored the task before it answers.
- The client polls `tasks/get { taskId }` (plus the envelope) every `pollIntervalMs` (clamped 250 ms to 30 s, default 2 s). The answer is `{ resultType: "complete", taskId, status, createdAt?, lastUpdatedAt?, ttlMs?, pollIntervalMs? }` plus `result` (the `tools/call` result including its own `resultType: "complete"`) for `completed`, `error: { code?, message?, data? }` for `failed`, `inputRequests` (a map of up to 512 keys to `{ method, params }`) for `input_required`. `status` is `working | input_required | completed | failed | cancelled`.
- The model sees "running in the background" first, then a completion notice with the result. Aborting sends `tasks/cancel { taskId }`; the answer is `{ resultType: "complete" }` (cooperative).
- Tasks need a real MCP server process: a mod's `$.tool.register` tools are served by hooks and have no task path.

## Not verified

- The `input_required`, `failed`, `cancelled` and `tasks/update` flows (spec: `inputResponses` for an `input_required` task), `notifications/tasks`, stdio `subscriptions/listen`; polling is the default.
- `title`, `icons`, `outputSchema`, `annotations`.
- Whether a modern-only server (no `initialize`) is accepted when a legacy prior exists.
- Re-test with `MCP_PROTOCOL_NEGOTIATION=auto claude -p` (tasks: an interactive session, for example in tmux) before relying on any of these.
