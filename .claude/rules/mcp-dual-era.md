---
paths:
  - "*/src/mcp/**"
  - "*/mcp.template.json"
---

# Rule: MCP servers are dual-era from the start

Every plugin MCP server (`<name>/src/mcp/server.ts`, zero-dependency stdio node script) answers **both** protocol eras: 2025-11-25 (`initialize`) and 2026-07-28 (`server/discover`, stateless). A hook-only server (tools, no tasks) is a tool table plus one call of `serveMcp` from `@shared/mcp-core.js` (`development/shared/src/mcp-core.ts`, the one implementation of the envelope, cancel handling and version read; models: `dprint/src/mcp/server.ts`, `universal-format/src/mcp/server.ts`). A change of the protocol handling goes there; every plugin that imports it needs a version bump. jev-api's server (tasks-free, but own timeout and app-level cancel) still carries its own copy. What the client sends and expects in each era, the tool `_meta` fields, the tasks protocol and what is still unverified: [mcp-protocol-eras.md](../../development/wiki/facts/mcp-protocol-eras.md) (read it before changing the envelope, adding a task, or debugging a server that does not connect).

## Types

- Use the official types, not hand-written shapes or `unknown`: `@modelcontextprotocol/server` (2.x) as a **devDependency** of the plugin, `import type` only (`Tool`, `ServerCapabilities`, `DiscoverResult`, `ListToolsResult`, `CallToolResult`, `JSONRPCRequest`, ...). The build erases type imports, so `plugin/` stays zero-dependency; runtime exports (`PROTOCOL_VERSION_META_KEY`, the `ProtocolErrorCode` enum) are not imported: copy the literal.
- Its result types omit wire-only fields (`resultType`, `ttlMs`, `cacheScope`): add those in the era wrapper, as dprint's `reply` does.
- Request input stays loosely typed at the trust boundary (`RpcRequest`), checked field by field.

## Server design

- One tool table, one handler per method; the era only changes the envelope. A request is modern when `params._meta["io.modelcontextprotocol/protocolVersion"]` is present or the method is `server/discover`; anything else (`initialize`, bare requests) is served as 2025-11-25 with the unchanged result shapes. Keep answering `initialize`: the client can skip the probe for a server it once saw as legacy.
- The `initialize` answer carries a version the server supports, never the client's echo.
- `server/discover` result: `{ resultType: "complete", supportedVersions: ["2026-07-28"], capabilities, _meta: { "io.modelcontextprotocol/serverInfo": { name, version } }, ttlMs, cacheScope }`. Every modern result needs `resultType`; list-like results also `ttlMs` and `cacheScope`.
- Keep the 2025-era fields (`structuredContent` plus a text block with the same JSON) in both eras; stdout carries JSON-RPC only; notifications (no `id`) get no answer; an unknown method answers `-32601`.
- Cancellation: on `notifications/cancelled { requestId }` (sent when a call is aborted, e.g. an `mcp_tool` hook that hit its `timeout`) stop waiting and send no answer for that id: keep an `AbortController` per in-flight `tools/call`, race the handler against its abort, hand the handler the `signal`, and check it before every new spawn and before every write. A cancel for an unknown or finished id is ignored.
- Hook-only servers set `_meta: { ui: { visibility: ["app"] } }` on every tool (kept from the model and ToolSearch, hooks still call it).
- A tool a mod calls with `$.mcp.call` must stay visible to the model (`visibility` with `"model"`), gets no timeout and no cancellation from the mod, and is not cancelled when the mod's dispatch is abandoned: implement a per-call timeout and an app-level cancel in the server (jev-api's `http` server). Under a managed policy `tool.check` never runs (live 2.1.332), so such a tool must be harmless for a model call and validate every input; a `tool.check` deny does not keep the model off it. `ToolDef` options for this are `modelVisible` and `inputSchema` (`development/shared/src/mcp-core.ts`). Take no URL or secret from the caller.
- Tasks: declare `capabilities.extensions["io.modelcontextprotocol/tasks"] = {}` only when a tool can return a task, and never return a task to a request that did not declare the extension (only interactive sessions do; `claude -p` must be answered synchronously).
- The engine's static check also applies to every module bundled into the hooks entry (`register.js`); `claude plugin validate` finds a violation the vitest kit cannot.
