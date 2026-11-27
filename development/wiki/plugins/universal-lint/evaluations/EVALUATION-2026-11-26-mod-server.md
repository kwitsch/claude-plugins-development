# universal-lint evaluation 2026-11-26: mod plus MCP server instead of six command hooks

Preparation for the question "should the lint logic move into an MCP server driven by a mod (function-hooks module) instead of the same script on six command hooks"; it reopens the user decision of 2026-11-06 ("command hooks, no MCP server, no persistent process", [hook-design.md](../design/hook-design.md)). No plugin code changed. **One machine**: WSL2, 12 cores, Node 24.22.3, Claude Code 2.1.332, a machine with managed settings (`cc-plugin-sec-default` seated outermost: `this machine has managed settings`, also with `--setting-sources project`).

## Method

- Live probe: a throwaway plugin in the session scratchpad with a mod (`hooks/probe.js`: `session.start`, `tool.call` on Write|Edit, `turn.complete`, and `classic.SessionStart|PostToolUse|Stop|SubagentStop|CwdChanged|FileChanged`), a dual-era stdio MCP server whose one tool logs what each call carries, and an `mcp_tool` PostToolUse hook on the same server. Recipe: [hook-payload-probe.md](../../../methods/hook-payload-probe.md) and the `live-verify` skill; `claude -p --plugin-dir <probe> --setting-sources project`, three headless runs, plus an interactive run in tmux (its own socket; the folder-trust dialog needs `Down`, `Enter`).
- Transcript mining: [transcript-mining.md](../../../methods/transcript-mining.md) over 50 main transcripts (2026-11-12 to 2026-11-26, 1401 subagent transcripts read for edits).
- `tsc` timing: cold, incremental, `--watch` and the TypeScript API on a 5-line project and on this repository's `tsconfig.src.json` (86 files), median of 5.

## Results

### Live probe (Claude Code 2.1.332)

- **Every `classic.*` hook of a user-tier mod is bypassed here.** `classic.SessionStart`, `classic.PostToolUse`, `classic.SubagentStop` and `classic.Stop` each logged `its classic.<Event> hook was skipped. "cc-plugin-sec-default" runs first and sent the event on past it`; none ran (`classic.CwdChanged` and `classic.FileChanged` were not raised: no watched file, no `cd`; the typings name no `watchPaths` result for them). So a mod cannot replace the Stop sweep, the FileChanged lint or the PostToolUse hook on a managed machine ([mods-engine-lifecycle.md](../../../facts/mods-engine-lifecycle.md)).
- **Engine events run for a user-tier mod.** `tool.call` with `{ tool: ["Write", "Edit"] }` ran for the main conversation and for a subagent (`agentId` present only for the subagent), `turn.complete` ran for the subagent (with `agentId`) and for the main conversation (without), `session.start` and `$.mcp.connect` (5 ms) too. `turn.complete` with `agentId` is a subagent-finished event; a post-`next` `tool.call` is the post-write point.
- **`$.mcp.call(server, tool, args)` takes a server name as a string**: `$.mcp.connect` answers `{ isConnected, server }`, pass its `server`; an object as first argument fails with `mcp.call: takes { server, tool, args? } (host check)`. In-frame calls took 9-15 ms; a call from a `$.clock.after` callback (out of frame) also succeeded, headless, with no denial (permission-dialog behaviour in `default` mode not exercised: the interactive run was in auto mode).
- **Tasks extension.** The `server/discover` probe carries `io.modelcontextprotocol/tasks` in `clientCapabilities`; the `tools/call` of an `mcp_tool` hook carries only `roots` and `elicitation` (headless and interactive); a mod's `$.mcp.call` carries the extension in the interactive run and not in `claude -p`. So a hook never receives a task; only a mod's call in an interactive session could.
- The `mcp_tool` hook on PostToolUse Write ran for the main conversation and the subagent.

### Wake path (`$.prompt.submit`)

- Interactive session in tmux (auto mode), main turn complete, session idle: a `$.clock.after(5000)` callback started in `turn.complete` called `$.prompt.submit({ text })` (out of frame); it resolved after 53 ms and the session started a new turn with that text as a prompt of its own (`PROBE-WAKE…`, answer `woke`, a second `turn.complete` 0.7 s later). So a mod can wake an idle interactive Claude the way `asyncRewake` does (live 2.1.332; `claude -p` not tested, a headless session ends with its turn).
- The same session's out-of-frame `$.mcp.call` from a timer (1.5 s after the Write) succeeded in 13 ms without a dialog (auto mode).

### Who is woken (transcript mining)

- 112 universal-lint enqueues in the period (all `asyncRewake`; no Stop or SubagentStop continuation records exist), all between 2026-11-12 and 2026-11-20: **57 (51%) woke an idle Claude, 55 (49%) were absorbed into a running turn.**
- Main-conversation Write/Edit: 55 reports, all absorbed (0 idle wakes). Subagent Write/Edit: 50 reports, all idle wakes (the main conversation was idle or waiting). FileChanged: 7, all idle wakes (trigger not attributed). Edit-to-report gap for the 50 PostToolUse idle wakes: median 3.2 s, max 57 s; enqueue-to-delivery median 0.04 s.
- Caveats: 8 sessions hold the 57, two of them 29; the period is mostly before 0.17.0 (2026-11-15), which routes a subagent's findings to `SubagentStop`, so the 50 subagent wakes are the case 0.17.0 removed. After 0.17.0 only FileChanged (7 of 112) needs a wake of an idle main conversation. A "turn of its own" can also be a main turn that waited on a background subagent.

### `tsc`, cold versus warm (tsc 7.0.2 native, ms, wall time with spawn)

|                                    | 5-line project | repository (86 files) |
| ---------------------------------- | -------------- | --------------------- |
| cold `tsc --noEmit -p`             | 73-85          | 429                   |
| `--incremental`, warm build info   | 67-73          | 244-256               |
| `tsc --watch`, edit to result      | 5              | 347                   |
| TS 6.0.3 `createWatchProgram`      | 264            | 291                   |
| TS 6.0.3 LanguageService, one file | 9              | 36                    |

Warm RSS: 248-302 MB for the `tsc 7` watcher on the repository, 460-595 MB for the JS API. A watcher is no faster than the incremental spawn on the repository, so a persistent checker is not a reason for a server (the plugin already keeps its build info in the data dir).

### Second probe round: `mcp_tool` hooks, command hooks, in-turn delivery (Claude Code 2.1.332, managed, same probe plus tool `hook` on the stub server)

- **`mcp_tool` hooks block like exit 2 (live 2.1.332, headless).** A Stop `mcp_tool` hook whose result text is `{"decision":"block","reason":"…"}` made the stopping agent continue and act on the reason; the next Stop carried `stop_hook_active: true`. A SubagentStop `mcp_tool` hook did the same for the subagent (`agent_id` in the payload, second call `stop_hook_active: true`). Input templates used: `${stop_hook_active}`, `${agent_id}` (empty string in the main conversation), `${file_path}`, `${tool_input.file_path}`.
- **FileChanged as `mcp_tool` hook works.** `watchPaths` came from a SessionStart _command_ hook (stdout JSON); the later change of the watched file reached the server's `file_changed`-style tool.
- **Command hooks still run under the managed policy**: a Stop command hook exiting 2 once made the agent continue (`cmdstop`); SessionStart command hooks ran.
- **In-turn delivery reaches the model from both routes**: the PostToolUse `mcp_tool` result `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":…}}` (record `hook_additional_context`, debug `provided additionalContext`) and a mod's `tool.call` result `context: [...]` added after `next` (record `hook_additional_context`); the model listed both markers.
- **`default` permission mode** (interactive, `--allowedTools Write`): the out-of-frame `$.mcp.call` from a `$.clock.after` callback ran in 11 ms without a dialog; `$.prompt.submit` from a timer woke the idle session again (the model reads it as `Prompt from the probe plugin`).
- **Not seen**: whether a SubagentStop `mcp_tool` block text reaches the _subagent_ as its own instruction (the subagent's second SubagentStop shows it continued); the `mcp_tool` hook `timeout` against a long lint.

### Third probe round: design probe P1-P8 (Claude Code 2.1.332, managed, probe v2: mod + stub server + `mcp_tool` hooks; five `claude -p` runs and one tmux session)

- **P1 mod `tool.call` shape.** Event keys: `file_path`, `content` (Write only), `tool`, `tool_use_id`, `agentId` (subagent only); Edit: `replace_all`, `file_path`, `old_string`, `new_string`. After `next`: `{ ref, result, text }`; Write `result` = `{ type, filePath, content, structuredPatch: array, originalFile: string, userModified }`, Edit `result` = `{ filePath, oldString, newString, originalFile, structuredPatch: array, userModified, replaceAll }`. `$.session.id()` and `$.session.cwd()` answer in every hook.
- **P4 patch through a hook template.** `${tool_response.structuredPatch}` arrives as JSON text (`[]` for a new file, jsdiff hunks with `\ No newline at end of file` lines otherwise), `${tool_response.originalFile}` as the plain string.
- **P6 cwd.** `$.session.cwd()` in the mod's `tool.call` is the cwd of the calling agent: the project root before `EnterWorktree`, `<root>/.claude/worktrees/<name>` after it (the `EnterWorktree` call itself still reports the old directory after `next`), the agent's own `<root>/.claude/worktrees/agent-<id>` for a subagent with `isolation: "worktree"`, the main conversation's current worktree for a subagent without isolation, and the start directory for a session started inside a worktree. The `${cwd}` of PreToolUse, PostToolUse, Stop and SubagentStop `mcp_tool` hooks agrees in every case (SubagentStop carries the subagent's own cwd). An `mcp_tool` CwdChanged hook never fired, neither after a Bash `cd` nor after `EnterWorktree`.
- **P2 owner identity.** The mod's `agentId` equals the `agent_id` of the `mcp_tool` PreToolUse, PostToolUse and SubagentStop hooks for the same subagent (two subagents in one session, one isolated), and `session_id` equals `$.session.id()`; `agent_id` is the empty string in the main conversation.
- **P3 environment.** The stdio server and the mod's `$.env.get` both see `CLAUDE_CODE_ENTRYPOINT` = `sdk-cli` in `claude -p` and `cli` interactively; the server's `CLAUDE_PROJECT_DIR` and `process.cwd()` equal the start directory (the worktree for a session started inside one). `$.mcp.connect`, `$.mcp.call` and `$.session.id()` work in `session.start` after `next`.
- **P5 UserPromptSubmit.** An `mcp_tool` UserPromptSubmit hook runs for the first prompt of `claude -p` and of an interactive session, and in the interactive session also for a prompt raised by `$.prompt.submit`; its `additionalContext` reaches the model each time (`hook_additional_context` record right after the wake prompt's user record). The woken turn ends with its own Stop hook call.
- **P7 pending call at headless exit.** A `$.mcp.call` left pending at the main `turn.complete` of a `claude -p` run keeps the run alive until it answers: 33 s against 4 s for the same run without it (25 s call). The server saw neither a cancel nor a stdin close before it answered.
- **P8 key secrecy.** A mod's `$.mcp.call` (arguments and answer markers) left no trace in the session transcript, and the model, asked to list every line containing the marker, found none.

## Bug hunt

None run: the plugin code was not touched. Findings about the plugin itself: none. Findings about the wiki: `facts/mods-engine-io.md` says `$.mcp.connect` answers the server name; on 2.1.332 it answers `{ isConnected, server }` and `$.mcp.call` wants the `server` string (see Results).

## Live validation

Run: three headless probe runs (`claude -p`, 2.1.332, `--setting-sources project`, managed machine), each with a main-conversation Write and Edit and a subagent Write; interactive tmux runs (auto mode; the first three never submitted their prompt because the driver sent the Enter too early and ended before the answer, the fourth was driven by a second Enter and completed). Not run: an unmanaged machine (every `classic.*` result is for the managed policy only), a `default` permission mode with an out-of-frame `$.mcp.call`, FileChanged and CwdChanged through a mod, `watchPaths` returned by a mod, a task returned to a mod's `$.mcp.call`, load (many events), a crash or kill of the server during a lint. The wake test ran once.

## Consequences for the design question

- Spawn cost is no argument (hook process 40-47 ms against 900-1600 ms of lint, `tsc` incremental already cheap); state simplification (Map, semaphore, timer instead of the journal, slot and lock files and parked processes) is the only gain.
- On a managed machine a mod cannot carry the Stop sweep, SubagentStop or FileChanged, so the command hooks stay for those events and for `watchPaths`; a mod could take Write/Edit through `tool.call`, the owner state, and the subagent-finished signal through `turn.complete`.
- The `mcp_tool` hook route is excluded as the carrier of tasks (no extension on hook calls).
- A mod has a wake path: `$.prompt.submit` from a timer starts a turn in an idle interactive session. What it lacks on a managed machine is a carrier for Stop, SubagentStop and FileChanged (`classic.*`), so the wake would fire for Write/Edit findings only, which after 0.17.0 are absorbed into running turns anyway (mining above).
- Open: whether an out-of-frame `$.mcp.call` raises a permission dialog in `default` mode, whether `$.prompt.submit` wakes in the same way for a finding that arrives while a turn runs (queued, origin `plugin`), and whether any of this changes under an unmanaged policy. Nothing here is a decision; the reversal of the 2026-11-06 decision is the user's.
