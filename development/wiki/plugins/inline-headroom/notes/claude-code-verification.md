# Claude Code verification log (inline-headroom)

Evidence for the engine shapes the mod relies on. Not loaded as memory: the pitfalls that change how code is written are in `.claude/rules/register-hooks.md`; this file is the evidence and the open live-check list.

## Verified engine shapes relied on (2.1.288 typings, live runs on 2.1.296 and 2.1.310)

- `turn.step` input `effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number`;
  `index: number` (0 = the user-ask step); `agentId?: string` set for subagents.
- `tool.call` result: failure is `isError: true` or `deny: string`; there is no
  `exitCode` (a failing Bash command surfaces as `isError: true`).
- `turn.step` result `usage` may be `null`.
- `command.run` returning `{}` prints no transcript row and records no model
  context (`CommandRunResult.text` absent).
- One hook per event without a matcher. Verified on 2.1.296, not 2.1.288: a
  module with a second matcher-less `on("turn.complete")` fails both
  `claude plugin validate` and `claude plugin test`, with the error
  `registered twice without a matcher`. The subagent error cleanup and a
  finished agent's dedup-corpus reset therefore share the one `turn.complete`
  hook with the storage write, registered while `storage_enabled`,
  `subagent_effort_routing_enabled` or `cross_turn_dedup_enabled` is on.
  `session.compact` has one matcher-less hook (registered while
  `cross_turn_dedup_enabled` is on) that resets the dedup corpus. `tool.call`
  likewise has one hook, which observes effort errors and answers
  `headroom_retrieve`, registered while effort routing or any compression
  lever is on. `session.append` has exactly one hook, with the matcher
  `{ door: "tool-result" }`, which runs every compression lever, registered
  while any of them is on.
- Live-run on 2.1.296 (headless `claude -p --plugin-dir … --setting-sources project`,
  a stdio MCP test server via `--mcp-config`, stream-json transcript as evidence):
  - Core resolves an MCP tool's `tool.call` to `{ ref, result, text }` where
    `result` is the content-block array itself (`[{ type: "text", text }]`),
    not `{ content: [...] }` (that is `$.mcp.call`'s shape). The typings leave
    an MCP tool's `result` as `unknown`.
  - The model's own calls carry `next.origin` `{ plugin: "engine", tier: "core" }`.
  - A hook-rewritten Bash `{ result }` and MCP content array pass core's
    validation and reach the model as the crushed JSON (200 rows → 15 + the CCR
    sentinel).
  - `$.tool.register` resolves to `mcp__inline-headroom__headroom_retrieve`; the
    tool is deferred (the model loads it through ToolSearch), its call reaches
    the matcher-less `tool.call` hook, and the `{ result: string }` answer
    reaches the model as text.
  - `headroom_retrieve` raises no permission prompt: the hook answers before
    core's permission step runs (`--permission-mode default` without an allow
    rule records no denial).
- Read from the typings (`claude-code.d.ts`), not live-run:
  - `tool.call` resolves to one of three `ToolCallResult` variants: `{ deny }`,
    an answered `{ result, context?, ref?, text? }`, or
    `{ isError: true, result, text?, ref?, context? }`.
  - Core validates a hook's own `{ result }` against the tool's output schema
    and maps it for the model with the tool's own mapper; `ref` and `text` are
    absent on it. `context` (`readonly string[]`, other hooks' reminder text) is
    "kept whole from `next`", but the typings do not say core restores it on a
    hook's own `{ result }`. The mod answers only `headroom_retrieve` with its
    own `{ result }`; it rewrites tool results at `session.append` instead.
  - The Bash record has `stdout`, `stderr`, `interrupted`, `isImage?`,
    `backgroundTaskId?`, `timedOutAfterMs?` (set when the command hit its
    timeout and was backgrounded), `rawOutputPath?`, `persistedOutputPath?` and
    `structuredContent?`. Each case these fields flag renders a tool_result
    text that is not one JSON document, so the crusher's whole-document parse
    at `session.append` rejects it.
  - `$.tool.register` in the first `session.start` (which is awaited) is listed
    by turn one; a reload's `session.start` registers again; `/clear` fires
    none.
- `$.ui.open(PaneOpenArgs)` resolves to `UiOpenResult`
  (`{ isPlaced: true } | { isPlaced: false, reason }`). `focus`/`closeOnEscape`
  accept only `true`. One pane per id, and re-opening retitles it.
- The `ui.render` matcher `{ component: "Pane", requestId }` selects only that
  pane and scopes `$.ui.invalidate("ui.render")` to it. Elements come from
  `$.ui.resolve(e)` as plain function calls (`Box({...})`, `Text({ children: [...] })`),
  so the module stays `.ts` without JSX.
- `session.end` input is `{ reason, sessionId, resume: { id } }` and `next(e)`
  resolves `{ sessionId }`; `reason: "clear"` is a `/clear` (the process goes on
  under a new session id).
- `turn.complete` input carries `agentId?` (absent on the main loop) and a
  required `reason`; `next(e)` resolves `{ text }`.
- `$.mcp.connect(key)` never rejects: it resolves `{ isConnected: true, server }`
  or `{ isConnected: false, reason, message }`. Read from the 2.1.289 engine binary (no live run yet): `key` is the
  bare key from this plugin's own `.mcp.json` (`"storage"`), not the
  `plugin:<name>:<key>` form, which is for `mcp_tool` hook `server` fields and
  for `$.mcp.call`. The engine namespaces the key itself; the resolved `server`
  is the namespaced name `$.mcp.call` takes. An unknown key resolves
  `{ isConnected: false, reason: "unlisted", message }` with the message
  `This plugin's manifest lists no MCP server named "<key>".`
  `$.mcp.call(server, tool, args)` resolves
  `{ content, isError, structuredContent? }`; `structuredContent` is typed only
  for tools with an `outputSchema`.
- `claude plugin validate` refuses `$.mcp` (any `$.<noun>`) as a bare value; a
  same-file helper taking the whole `$: EngineInterface` validates, and its calls
  are listed as `$.mcp.call (via callStorage)`.
- `Box` `flexDirection`/`width`/`justifyContent`/`gap` and `Text`
  `bold`/`dimColor` mount and validate in a Pane.
- Live-run on 2.1.296 for the earlier levers (headless `claude -p`, an
  interactive session in tmux, a `claude --bg` session, a throwaway probe mod;
  evidence: `--debug-file` logs and, for effort, the `/v1/messages` request
  bodies through a local pass-through proxy):
  - `$.mcp.connect("storage")` connects from the mod by the bare key.
  - `structuredContent` is not forwarded for a tool without `outputSchema`
    (the storage tools have none): `callStorage` reads the JSON text block.
  - The storage permission rules in `storage-server.md`.
  - `$.clock.every` started in `command.run`, or in `ui.render` after a hot
    reload, keeps firing with that hook's `$` after the hook returned.
  - The `ui.close` hook (matcher `{ id }`) runs on Esc and on Ctrl+X X, and the
    refresh stops.
  - A file change under `--plugin-dir` hot-reloads the module with the pane
    still open; the first redraw re-arms the refresh.
  - Agent-tool subagents raise `turn.step`, `tool.call` and `turn.complete`
    with one stable `agentId`, and `index` restarts at 0 per agent.
    `turn.complete` fires with `reason: "aborted"` for a background agent
    stopped with TaskStop.
  - Core sends the lowered `effort` (`output_config.effort`) for main-loop and
    subagent steps.
  - A `claude --bg` session's main loop carries no `agentId`.
  - The built-in `cc-plugin-sec-default` skips every user-tier hook on
    `prompt.compose`, `prompt.section` and `prompt.context` (debug log:
    `prompt.compose bypassed by cc-plugin-sec-default (tier user)`), and
    `prompt.compose` is gone from the typings. Since 2.1.310 core also reports
    every registered hook a managed plugin skips, once per session per event,
    as a user-visible notice (`its prompt.compose hook was skipped.
    "cc-plugin-sec-default" runs first and sent the event on past it.`). The mod
    therefore registers no `prompt.compose` hook and has no volatile-value
    list (0.8.2); the cache-drop counting reads `turn.step` usage and still
    works.
  - The same notice fires once per session for `tool.check`: for the mod's own
    storage call, `cc-plugin-sec-default` runs the module's `tool.check`
    (nested in the calling hook), then re-dispatches beneath the user tier to
    get core's verdict, which the engine logs as a bypass. The verdict is still
    `ask -> allow by plugins cc-plugin-sec-default, inline-headroom`, and
    calling `next(e)` before answering changes nothing (live, 2.1.310). It is
    unavoidable while the mod writes storage; documented in the README.
- Live-run on 2.1.296 for the compression levers (2026-10-11, a throwaway probe
  mod with a `session.append` `{ door: "tool-result" }` hook, headless
  `claude -p … --plugin-dir <probe> --setting-sources project --debug-file …`;
  evidence: the probe's debug lines and the stream-json transcript):
  - `claude plugin validate` lists the hook as `session.append{door=tool-result}`,
    separate from the matcher-less `tool.call`.
  - Each tool result is one row: `door: "tool-result"`,
    `origin: { kind: "tool", tool: "<name>" }`, and a `message` of
    `type: "user"`, `role: "user"` whose `content` holds one
    `{ type: "tool_result", tool_use_id, content, is_error? }` block.
    `agentId` is set on subagent rows and absent on main rows.
  - The tool_result `content` per tool: Bash a string of stdout (with
    `is_error: false`); Read a string with unpadded line numbers (`1\t…`); Grep
    in content mode a string (`1:…`); ToolSearch an array of
    `{ type: "tool_reference", tool_name }` blocks; a `$.tool.register` tool's
    `{ result: "…" }` a string; Agent an array holding one text block (the
    framed hand-back report).
  - `$.session.messages()` (or `$.session.messages({ agentId })` for a subagent
    row) called inside the hook resolves to an array with no deadlock; every
    `session.append` settled in 2.1-4.0 ms, `next` and the fetch included.
  - A rewrite through `next({ ...e, message: { ...e.message, content } })` is
    stored and read by the model, for main and subagent rows alike.
  - A `$.tool.register` tool is callable from a general-purpose subagent: the
    subagent loaded it through ToolSearch `select:`, and the module's
    `tool.call` hook answered it with `agentId` set.
  - Every model tool call, in subagents too, carries `next.origin`
    `{ plugin: "engine", tier: "core" }`.

## Not yet live-verified (unit tests only)

Shipped on unit-test and typings evidence only. The user-run live check in the PR
moves each confirmed entry into the section above and records any failure here;
delete this heading once it is empty.

- Workflow agents (only Agent-tool subagents were live-run) raise `turn.step`,
  `tool.call` and `turn.complete` with a stable `agentId`.
- An agent's `turn.complete` hook raises its `stats_put` in-frame, so the
  module's `tool.check` allows it without a permission prompt (only main-loop
  writes were live-run).
- A stdio MCP server's tool_result `content` shape at `session.append` (a
  string or a text-block array; both are handled).
- A tool-result row with `is_error: true`.
- Workflow-agent tool-result rows.
- Agent types whose `tools` allowlist names or leaves out `headroom_retrieve`.
- A dedup pointer whose original was compacted away.
- A real compaction's `session.compact` dispatch (`trigger`, `agentId` and the
  `skip` result are read from the typings; the kit raises the event with
  hand-built input): the dedup corpus reset after `/compact` or an auto-compact.
- The `origin.tool` of a plugin-registered tool's row at `session.append` (the
  protected-row check matches `headroom_retrieve` by name in any namespace to
  stay safe either way).
