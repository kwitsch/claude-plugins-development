# Hook input types from claude-code-hook-types

Why dprint's MCP tool input types (`src/mcp/hook-inputs.d.ts`) come from the published `claude-code-hook-types` CLI, why dprint is on preset 0.4.1, why handlers take a deep-optional `HookInput<K>`, and what was lost with the plugin's own generator `hooks.ts` under `scripts/` (deleted in 0.14.5). The constraints are in [hook-inputs.md](../../../../../dprint/.claude/rules/hook-inputs.md).

## Generator

- `@kwitsch/claude-code-plugin-cli` 0.1.1 (bin `claude-code-hook-types [--check] [template]`, devDependency of dprint only) reads `hooks.template.json`, follows its `hookTypes` key to `src/mcp/hook-inputs.d.ts` and writes `McpToolHookInputs`, keyed by server (`"plugin:dprint:dprint-hooks"`) and tool. `build` runs it before `tsdown`; `lint` runs it with `--check` (CI runs `lint` before `build`), so a stale committed file fails CI.
- It replaced a 327-line plugin-local script that generated one interface per tool plus a `HookInputs` map: one generator shared by every plugin instead of a private one.

## Preset 0.4.1

- Preset/core 0.2.0 copy every unknown top-level template key into the rendered `hooks.json`, so `hookTypes` would ship in `plugin/hooks/hooks.json` (an unknown key in a file Claude Code reads; the preset runs `claude plugin validate --strict`) (binary 0.2.0).
- Preset 0.4.1 strips `hookTypes` and fails the build with `hook-types-stale` when the file is missing or differs, CRLF normalized (binary 0.4.1). Its `index.d.mts` equals 0.2.0's, its tsdown peer is `~0.23.7` (typings), and it uses core 0.4.1, the core the CLI depends on, so build check and CLI render identical text (binary 0.4.1). `tsdown.config.ts` did not change.
- Only dprint moved; the other plugins stay on 0.2.0 / 0.3.0 because none has hook input types.

## Deep-optional handler inputs

- The CLI makes every field required, which is accurate for hook calls: Claude Code substitutes every template field, an absent one as `""` (live 2.1.326, see below). The CLI output was read from the generated `hook-inputs.d.ts` (typings).
- `development/shared/src/mcp-core.ts` passes `params?.arguments ?? {}` unvalidated, so a direct `tools/call` can omit any field. `src/mcp/hook-input-types.ts` therefore wraps the generated map in `Loose<T>` (every field optional, nested objects too; `Partial` is shallow and `tool_input` / `tool_response` are nested) and exports `HookInput<K>`; handler bodies kept their `= {}` defaults, `?.` and `??` guards, and `tests/mcp-format.test.ts` keeps calling handlers with partial literals.
- `Loose<T>` would also map through arrays and tuples; no current input has one.
- `server.ts` keeps `type Tools = { [K in keyof HookInputs]: ToolDef<HookInput<K>, HookResult> }`: a tool without a hook, or a hook without a tool, is still a compile error.

## What the own validator checked and the CLI does not

- Every `${…}` placeholder is a real input field of its event and, for `Write`/`Edit` matchers, of those tools' `tool_input`.
- Unknown hook events (the script had to know each event's fields).
- One input shape per tool (the CLI silently forms a union).
- `command` hooks: non-empty `command`, positive integer `timeout`, no `input`.

Decision, 2026-11-26, design review of the hook-types-cli task (no individual decider recorded): placeholder validation is dropped together with the script. Reason: the task was to use the published CLI. Rejected: an upstream feature request for placeholder validation (out of scope) and keeping `hooks.ts` as validator (see below). The guard is now the review rule in [hook-inputs.md](../../../../../dprint/.claude/rules/hook-inputs.md) plus the table below; template changes should also run `pnpm --filter dprint test:plugin` or the `live-verify` skill.

## Two runtime outcomes of a bad placeholder

- A `tool_input` sub-field the tool call lacks (e.g. `${tool_input.old_string}` on a Write) arrives as `""` (live 2.1.326, [universal-format hook design](../../universal-format/design/hook-design.md)); every handler treats `""` as absent.
- A variable that does not exist for the event is an error (live 2.1.323, [claude-code-tool-hook-facts.md](../../../../../.claude/rules/claude-code-tool-hook-facts.md)): the hook fails instead of the build. For `format_pre` the write then goes through unformatted.

## Input fields per event (review reference)

Copied from `EVENT_FIELDS` / `TOOL_INPUT` of the deleted generator `hooks.ts` (0.14.4); `x.*` means any sub-field.

Common to every event: `session_id`, `prompt_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `permission_mode`, `hook_event_name`, `agent_id`, `agent_type`, `effort.level`.

Tool events add: `tool_name`, `tool_input.*`, `mcp_server.*`.

| Event              | Fields beyond the common ones                                                      |
| ------------------ | ---------------------------------------------------------------------------------- |
| PreToolUse         | tool fields, `tool_use_id`                                                         |
| PostToolUse        | tool fields, `tool_use_id`, `tool_response.*`, `duration_ms`                       |
| PostToolUseFailure | tool fields, `tool_use_id`, `error`, `is_interrupt`                                |
| CwdChanged         | `old_cwd`, `new_cwd`                                                               |
| FileChanged        | `file_path` (absolute), `event` (`change`, `add` or `unlink`; Claude Code 2.1.316) |
| SessionStart       | `source`                                                                           |
| UserPromptSubmit   | `prompt`                                                                           |

`tool_input` fields when the matcher names only these tools (other matchers allow any `tool_input` field):

| Tool  | `tool_input` fields                                    |
| ----- | ------------------------------------------------------ |
| Write | `file_path`, `content`                                 |
| Edit  | `file_path`, `old_string`, `new_string`, `replace_all` |

The CLI types `replace_all` as `string`, which matches the runtime (Claude Code substitutes text, `"true"` / `"false"`).

## Rejected alternatives

- Required CLI types directly in the handlers (drop the `= {}` defaults): claims a guarantee the trust boundary in `mcp-core.ts` does not give, and the partial literals in `tests/mcp-format.test.ts` would fail the type check of `pnpm lint`.
- Keep preset 0.2.0 and use the CLI only in scripts: `hookTypes` would ship in `hooks.json`; a second template just for the CLI duplicates the contract.
- Keep `scripts/hooks.ts` as validator and generator next to `hookTypes`: two generators of one file and 327 lines the task was meant to remove.
