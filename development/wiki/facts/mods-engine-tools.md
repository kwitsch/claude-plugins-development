# Mods engine: registered tools, `$.tool.call`, `tool.check` and permissions

What happens to a tool a plugin registers with `$.tool.register`, how one plugin calls another's tool, and what a `tool.check` hook can and cannot decide.

Basics (errors as `{ deny }`, no schema enforcement, registration retry, no permission check) are in [claude-code-hook-facts.md](../../../.claude/rules/claude-code-hook-facts.md).

## Registration

- A registered tool reaches the model and the `tool.call` hooks as `mcp__<plugin>__<name>`, hyphens kept (`mcp__inline-headroom__headroom_retrieve`). Its input fields arrive top-level on the `tool.call` event, next to `tool` (live 2.1.322).
- Core's `$.tool.register` polls the session's tool list until the new tool is listed (up to 8 s, then it resolves anyway; under a deny rule it resolves at once), and `$.tool.list()` reads the same list, so a resolved registration is listed (binary 2.1.322).
- The `inputSchema` check only requires a JSON object; `isDeferred` (boolean) is accepted too (binary 2.1.322).
- Registrations survive a hot reload of the plugin: the reload loads a fresh module, but the tool registry forgets a plugin's tools only when the plugin unloads. There is no `$.tool.unregister` (binary 2.1.322).
- A registered tool that no hook answers gets core's permission step and then the error text `<plugin> registered the tool <name> but no tool.call hook answered this call`. A plugin must therefore answer its registered tools in every state, also "inactive" (binary 2.1.322).
- `$.tool.list()` builds each description through the tool's own prompt function, cached per tool; it raises no `agent.offer` (binary 2.1.322).

## Serving a tool

- A matched hook, `on("tool.call", { tool: "mcp__<plugin>__<name>" }, ...)`, answers its calls even when the module saw no `session.start`, and passes `claude plugin validate`. Cost per foreign tool call: about 15-40 µs for a matched hook (the engine filters before dispatch), about 80 µs plus 0.35 ms per MB of input and result for a matcher-less hook that returns `next(e)` (`claude plugin test` 2.1.322, measured 2026-11-11).
- A matcher leaf is compared with `===` or is a `RegExp`; an array means any-of (typings 2.1.322).
- A `{ deny }` text or a result reaches the model whole: a 400 KB deny arrived as a 400,073-character tool result. Cap any text a server controls (live 2.1.325).

## Permissions

- A hook-served tool skips core's permission step: no prompt, `permissions.ask` rules, classic `PreToolUse` hooks and `tool.check` hooks never apply to the model's call (live 2.1.322).
- A `permissions.deny` of `mcp__<plugin>__<name>` or of `mcp__<plugin>` (the server-level form, also as `--disallowedTools`) removes the tools from the session's tool list (live 2.1.325).

## `$.tool.call` from a mod

- It runs through every hook but the calling one (the calling plugin's other hooks see it), then the permission check, then the tool. Plugin load order does not matter for reaching another plugin's `tool.call` hook (typings and binary 2.1.322).
- It resolves, never rejects, with `{ deny }`, a hook's own `{ result }`, or core's `{ ref, result, text }` / `{ isError: true, result, text }`, where `text` is what the model would read and `result` may be undefined (binary 2.1.322).
- It takes no options and no signal, and mints its own `tool_use_id` (typings).
- Core refuses only `Agent`, `AskUserQuestion`, `Workflow` and background-starting tools for a plugin's `$.tool.call` (binary 2.1.322).
- The `tool.call` hooks run before core's permission step. A hook-served tool therefore still answers another plugin's `$.tool.call` after a deny rule removed it from the model's tool list; a caller that caches "the tool exists" per process does not notice a deny added mid-session (binary 2.1.322).

## `tool.check`

- The event carries only `tool`, `input` and `tool_use_id`: no permission mode, session id or scratchpad directory. `$` exposes no permission mode either (typings, live 2.1.319).
- `next(e)` answers `{ decision, reason?, rule? }`; `rule` is set only when a settings rule decided, so a hook can tell a settings `ask` from a mode's ask (typings).
- `tool.check` runs before the permission mode settles an ask. A hook that answers `ask` puts the call to the mode's decider and forces the prompt in auto mode: a hook that only wants to loosen must never return `ask` (live 2.1.319).
- For a call to a plugin's own MCP server tool, the hook sees `origin { plugin: <own>, tier: "user" }` when the mod itself called it through `$.mcp.call`, and `{ plugin: "engine", tier: "core" }` for the model's direct call. Answering `{ decision: "deny", reason }` for the latter keeps the model off the tool, even when it is in `--allowedTools`; the notice `its tool.check hook was skipped (cc-plugin-sec-default)` still appears, the deny applies (live 2.1.325).
