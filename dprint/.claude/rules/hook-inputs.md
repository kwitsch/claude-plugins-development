---
paths:
  - "hooks.template.json"
  - "src/mcp/hook-inputs.d.ts"
  - "src/mcp/server.ts"
  - "src/mcp/format.ts"
---

# Hook-input contract (hooks.template.json -> src/mcp/hook-inputs.d.ts)

Reasons, the lost validator checks and the per-event field table: [hook-input-types](../../../development/wiki/plugins/dprint/design/hook-input-types.md).

- `hooks.template.json` is hand-written and is the hook-input contract. `claude-code-hook-types` (devDependency `@kwitsch/claude-code-plugin-cli`) generates `McpToolHookInputs` in `src/mcp/hook-inputs.d.ts` from the `mcp_tool` `input` templates, located by the template's `hookTypes` key.
- Never edit the `.d.ts`: `pnpm build` regenerates it; `pnpm --filter dprint lint` (`claude-code-hook-types --check`) and the preset build (`hook-types-stale`) fail while it is stale.
- Handlers take `HookInput<"tool">` from `format.ts` (deep-optional over the generated required fields), because a direct MCP call may omit fields; `server.ts` maps `Tools` over `HookInputs`, so a tool missing on either side is a compile error.
- One input shape per tool: the CLI silently forms a union when two hooks call one tool with different inputs.
- Every `${…}` must be a real input field of its event (and, for `Write`/`Edit` matchers, of those tools): checked by review against the field table on the design page, not by any build step; an unknown variable is a runtime hook error.
