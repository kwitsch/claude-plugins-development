# dprint: audit of the MCP server's tool visibility

Answers whether every tool of the `dprint-hooks` server is used only by hooks and so has to be hidden from the model; result: yes and already so, no code change.

## Audit (2026-11-17, plugin 0.14.0)

- The server's tool table (`src/mcp/server.ts`, `TOOLS`) has nine tools: `format_pre`, `cwd_changed`, `worktree_entered`, `worktree_exited`, `file_written`, `file_changed`, `bash_started`, `bash_finished`, `drain_notices`. `hooks.json` calls exactly these nine, and no other `mcp_tool` hook and no skill, mod or script calls the server (grep of `src/`, `plugin/skills/`, `plugin/README.md`). `Tools`, mapped over the generated `McpToolHookInputs` (since 0.14.5), makes a tool without a hook, or a hook without a tool, a compile error.
- Every tool of `tools/list` carries `_meta.ui.visibility: ["app"]`; `tests/mcp-server.test.ts` pins it for each tool and both protocol eras.
- No mod calls the server (`$.mcp.call` cannot reach an app-only tool, see [mcp-dual-era.md](../../../../../.claude/rules/mcp-dual-era.md)), so nothing needs the tools visible, and no `tool.check` hook is needed to keep the model off them.

## Live check (Claude Code 2.1.326, 2026-11-17, `claude -p --plugin-dir dprint/plugin`, throwaway repo, dprint 0.64.3)

- A `Write` of `const   x  =  {a:1,b:2}` was formatted on write to `const x = { a: 1, b: 2 };`; the debug log shows `mcp_tool calling plugin:dprint:dprint-hooks/format_pre`, `drain_notices` and `file_written`. So `mcp_tool` hooks reach hidden tools.
- `ToolSearch` for "dprint" found no tool (only the skill).
- A direct call of `mcp__plugin_dprint_dprint-hooks__drain_notices` (even in `--allowedTools`) answered `No such tool available`, so the model can neither find nor call the tools.

## Not exercised

- `worktree_entered`/`worktree_exited`, `bash_*`, `cwd_changed` and `file_changed` in this run (covered by `tests/mcp-server.test.ts` and the earlier evaluation).
