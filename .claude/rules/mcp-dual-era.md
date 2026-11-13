---
paths:
  - "*/src/mcp/**"
  - "*/plugin/.mcp.json"
  - "*/plugin/hooks/hooks.json"
---

# Rule: MCP servers are dual-era from the start

Every plugin MCP server (`<name>/src/mcp/server.mts`, zero-dependency stdio node script) answers **both** protocol eras:
2025-11-25 (`initialize`) and 2026-07-28 (`server/discover`, stateless). Model: `dprint/src/mcp/server.mts` (tools,
hooks only, no tasks). Facts below were verified live on Claude Code 2.1.323 (2026-11-13) with a throwaway stdio `.mjs`
server unless marked _static_ (read from the binary) or _spec_ (modelcontextprotocol.io/specification/2026-07-28).

## Era negotiation (client side)

- Claude Code carries both eras. On stdio it first sends `server/discover` (id `server-discover-probe-1`,
  `params._meta` = `io.modelcontextprotocol/protocolVersion` `"2026-07-28"`, `clientInfo`, `clientCapabilities`).
  An answer with `supportedVersions` containing `2026-07-28` makes the session modern: **no `initialize` is sent**.
  No answer (timeout), an error, or a result that does not validate falls back to `initialize` with 2025-11-25.
- Every modern request carries the same `_meta` envelope (`protocolVersion`, `clientInfo`, `clientCapabilities`) and
  needs `resultType` in the result (`"complete"`, `"task"`, `"input_required"`). A modern list-like result
  (`tools/list`, `server/discover`) also needs `ttlMs` (int >= 0) and `cacheScope` (`"public"`/`"private"`); put
  `io.modelcontextprotocol/serverInfo` in the result `_meta`. Unsupported version: error `-32022` with
  `data: { supported, requested }`; missing client capability `-32021`; resource-not-found is now `-32602`.
- `MCP_PROTOCOL_NEGOTIATION=legacy|auto` (env of the Claude process, e.g. settings `env`; a plugin cannot set it)
  forces the mode. Without it the stdio default is auto-probe, gated by the feature flag
  `tengu_mcp_protocol_negotiation_stdio` (default on). A per-server prior (_static_: `burnedListingDiscoverPriors`)
  can skip the probe for a server config that listed legacy before: one old test server was never probed while a
  fresh copy was; the invalidation is unknown. A server that must stay reachable therefore keeps answering `initialize`.
- `mcp_tool` hooks work over the modern era (the hook call arrives as a normal `tools/call` with the envelope).

## Server design

- One tool table, one handler per method; the era only changes the envelope. A request is modern when
  `params._meta["io.modelcontextprotocol/protocolVersion"]` is present or the method is `server/discover`; anything
  else (`initialize`, bare requests) is served as 2025-11-25 with the unchanged result shapes.
- `server/discover` result: `{ resultType: "complete", supportedVersions: ["2026-07-28"], capabilities, _meta:
  { "io.modelcontextprotocol/serverInfo": { name, version } }, ttlMs, cacheScope }`. Declare
  `capabilities.extensions["io.modelcontextprotocol/tasks"] = {}` only when a tool can return a task.
- Keep the 2025-era fields (`structuredContent` plus a text block with the same JSON) in both eras; stdout carries
  JSON-RPC only; notifications (no `id`) get no answer; an unknown method answers `-32601`.
- Tool `_meta` the client reads: `ui.visibility` without `"model"` keeps the tool from the model and ToolSearch (hooks
  still call it; hook-only servers set `{ ui: { visibility: ["app"] } }` on every tool, also `mcp_status` still shows
  it); `anthropic/alwaysLoad` (true: never deferred behind ToolSearch, at server level it also blocks startup until
  connected), `anthropic/searchHint`, `anthropic/maxResultSizeChars`, `anthropic/requiresUserInteraction` (forces a
  permission prompt), `anthropic/permissionDisplay`. The spec adds `title`, `icons`, `outputSchema` and `annotations`
  on tools (_spec_, annotation names not confirmed).

## Tasks extension (long-running tools)

- **Interactive sessions only.** The client declares `io.modelcontextprotocol/tasks` in `clientCapabilities` of the
  discover probe in every mode, but on `tools/call` only in an interactive session with the feature flag
  `tengu_glowing_lark` on (default on for the normal CLI). `claude -p`, single-shot and headless runs, and
  `CLAUDE_CODE_DISABLE_MCP_TASKS=1` send no extension: a server must then answer the call synchronously. Never return
  a task to a request that did not declare the extension (spec).
- Task creation: `{ resultType: "task", taskId, status: "working", ttlMs, pollIntervalMs }`; `taskId` is 1-128
  printable ASCII chars without space. The server must have stored the task before it answers.
- The client polls `tasks/get { taskId }` (+ the envelope) every `pollIntervalMs` (clamped 250 ms to 30 s, default
  2 s). Answer `{ resultType: "complete", taskId, status, createdAt?, lastUpdatedAt?, ttlMs?, pollIntervalMs? }`
  plus `result` (the `tools/call` result incl. its own `resultType: "complete"`) for `completed`, `error:
  { code?, message?, data? }` for `failed`, `inputRequests` (map of up to 512 keys to `{ method, params }`) for
  `input_required`; `status` is `working | input_required | completed | failed | cancelled`.
- The model sees "running in the background" first, then a completion notice with the result. Aborting sends
  `tasks/cancel { taskId }`, answer `{ resultType: "complete" }` (cooperative). `tasks/update` (spec: `inputResponses`
  for an `input_required` task), `notifications/tasks` and `subscriptions/listen` were not exercised; polling is the
  default.
- Tasks need a real MCP server process: a mod's `$.tool.register` tools are served by hooks and have no task path.

## Not verified

`input_required`, `failed`, `cancelled` and `tasks/update` flows; stdio `subscriptions/listen`; `title`, `icons`,
`outputSchema`, `annotations`; whether a modern-only server (no `initialize`) is accepted when a legacy prior exists.
Re-test with `MCP_PROTOCOL_NEGOTIATION=auto claude -p` (tasks: an interactive session, e.g. in tmux) before relying on them.
