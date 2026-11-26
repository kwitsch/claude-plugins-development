# Mods engine: registered tools, `$.tool.call`, `tool.check` and permissions

What happens to a tool a plugin registers with `$.tool.register`, how one plugin calls another's tool, and what a `tool.check` hook can and cannot decide.

The constraints that follow load by themselves with [claude-code-hook-facts.md](../../../.claude/rules/claude-code-hook-facts.md); this page is the detail and the evidence.

## Registration

- A registered tool reaches the model and the `tool.call` hooks as `mcp__<plugin>__<name>`, hyphens kept (e.g. `mcp__jev-api__request`). Its input fields arrive top-level on the `tool.call` event, next to `tool` (live 2.1.322).
- Core's `$.tool.register` polls the session's tool list until the new tool is listed (up to 8 s, then it resolves anyway; under a deny rule it resolves at once), and `$.tool.list()` reads the same list, so a resolved registration is listed (binary 2.1.322).
- The `inputSchema` check only requires a JSON object; `isDeferred` (boolean) is accepted too (binary 2.1.322).
- Registrations survive a hot reload of the plugin: the reload loads a fresh module, but the tool registry forgets a plugin's tools only when the plugin unloads. There is no `$.tool.unregister` (binary 2.1.322).
- A registered tool that no hook answers gets core's permission step and then the error text `<plugin> registered the tool <name> but no tool.call hook answered this call`. A plugin must therefore answer its registered tools in every state, also "inactive" (binary 2.1.322).
- `$.tool.list()` builds each description through the tool's own prompt function, cached per tool; it raises no `agent.offer` (binary 2.1.322).
- `$.tool.register` rejects until the session is bound, that is before `session.start`. A memoized failure then lasts for the whole session: retry per hook with back-off, and bound the wait for a registration that never answers, paying it once per tool (typings and an in-process harness, not measured live).
- Input schemas are not enforced: `enum`, `required`, `type`, `minItems`, `maxItems` and bounds only describe the tool to the model; a call that breaks them reaches the `tool.call` hook unchanged (live 2.1.325).

## Serving a tool

- A matched hook, `on("tool.call", { tool: "mcp__<plugin>__<name>" }, ...)`, answers its calls even when the module saw no `session.start`, and passes `claude plugin validate`. Cost per foreign tool call: about 15-40 µs for a matched hook (the engine filters before dispatch), about 80 µs plus 0.35 ms per MB of input and result for a matcher-less hook that returns `next(e)` (`claude plugin test` 2.1.322, measured 2026-11-11).
- A matcher leaf is compared with `===` or is a `RegExp`; an array means any-of (typings 2.1.322).
- A hook's own `{ isError: true, result }` reaches the model as a normal tool result (no `is_error`, text only), while `{ deny: text }` reaches it as `<tool_use_error>text</tool_use_error>` with `is_error: true` and no `permission_denials` entry. A result read back through `$.tool.call` carries `isError: true` or `deny` (live 2.1.322 and 2.1.325).
- Result shapes: a hook-served tool answers `{ result: "<text>" }`, a real MCP tool `{ result: [{ type: "text", text }], text }`; a `tool.call` result has no `exitCode`. The worktree tools' output carries both `worktreePath` and `restoredCwd` (for ExitWorktree use `restoredCwd`) (live 2.1.325).
- A tool call refused before it ran comes back as an error result whose text starts with `The user doesn't want to proceed with this tool use`, `Permission for this tool use was denied`, `Permission to use … has been denied` or `Hook '<name>' blocked`; a failed run does not match these (live 2.1.325).
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
- A hook that returns an existing `allow` with a new `reason` makes `cc-plugin-sec-default` warn the user that a plugin tried to reword an allow rule, and report the hook as skipped; returning the verdict unchanged avoids both (live 2.1.325).
- Claude Code already allows in-project reads, so its `ask` on a `Read` means the path resolves outside the working directories (live 2.1.325).
- `tool.check` runs before the permission mode settles an ask. A hook that answers `ask` puts the call to the mode's decider and forces the prompt in auto mode: a hook that only wants to loosen must never return `ask` (live 2.1.319).
- For a call to a plugin's own MCP server tool, the hook sees `origin { plugin: <own>, tier: "user" }` when the mod itself called it through `$.mcp.call`, and `{ plugin: "engine", tier: "core" }` for the model's direct call. Answering `{ decision: "deny", reason }` for the latter keeps the model off the tool, even when it is in `--allowedTools`; the notice `its tool.check hook was skipped (cc-plugin-sec-default)` still appears, the deny applies (live 2.1.325). Correction (live 2.1.332, managed policy): under the managed policy the `tool.check` hook never ran in the third probe round, so the deny did not keep the model off the tool; a design on a managed machine must make such a tool harmless for a model call. Evidence: [EVALUATION-2026-11-26-mod-server.md](../plugins/universal-lint/evaluations/EVALUATION-2026-11-26-mod-server.md), "Third probe round".

## `tool.call` event and result of Write and Edit (live 2.1.332)

- A mod's `tool.call` hook with matcher `{ tool: ["Write", "Edit"] }` gets `file_path`, `content` (Write only), `tool`, `tool_use_id` and `agentId` (subagent only); Edit gets `replace_all`, `file_path`, `old_string` and `new_string`. After `next` the value is `{ ref, result, text }`; `result.structuredPatch` is an array (`[]` for a new file) and `result.originalFile` a string, for Write and Edit alike (live 2.1.332, evaluation page, "Third probe round", P1).
- `$.session.id()` and `$.session.cwd()` answer in every hook. A `${tool_response.structuredPatch}` placeholder in a `mcp_tool` hook input arrives as JSON text, `${tool_response.originalFile}` as the plain string (P4).
