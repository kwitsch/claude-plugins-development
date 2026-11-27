# Claude Code: `command` hooks, hook filters and how findings appear in transcripts

Behaviour of classic hooks (`hooks.json`) beyond what the rule files state: filters, payload paths, and the transcript records a hook's exit 2 leaves behind.

Tool hooks, subagent payloads, `Stop`/`SubagentStop`, FileChanged and `watchPaths` basics are in [claude-code-tool-hook-facts.md](../../../.claude/rules/claude-code-tool-hook-facts.md).

## Command and args

- A `type: "command"` hook with `"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/<name>.mjs"]` runs: `${CLAUDE_PLUGIN_ROOT}` is expanded inside `args`, the debug log shows `Hooks: SessionStart:startup [node <absolute path>] ... finished with status 0`, and the output reaches the session (`provided additionalContext`, `provided 2 watchPaths`). Seen for SessionStart, PostToolUse and Stop with `--plugin-dir` (live 2.1.331, 2026-11-24, rc-enhancement and universal-lint as built by the tsdown preset).

## Filters

- A handler's `if` takes exactly one permission rule: `Write(*.ext)` or `Edit(*.ext)` match at any depth and case-insensitively; an `Edit` rule does not cover `Write`; brace globs and `|` alternation never match. Filtering by extension therefore needs one handler per tool and extension. Debug log: `Skipping hook due to if condition ... not matching` (live 2.1.321).
- A FileChanged `matcher` is split on `|` into literal watched file names and is also applied as a case-sensitive regex on the basename: `a.sh` and `.*\.sh$` work, the glob `*.sh` never fires. It cannot skip a hook's own echoes or `unlink` (live 2.1.321).

## Payloads

- Hook payloads carry the physical, symlink-resolved cwd: in a session started in a symlinked directory the payload `cwd`, `CLAUDE_PROJECT_DIR` and the hook's `process.cwd()` are the real path, and so is the payload `cwd` after a `cd` into a symlinked subdirectory. Only the inherited `$PWD` of the hook process keeps the symlink until the first `cd` (live 2.1.325, headless; 2.1.323 gave the same for `CwdChanged` `new_cwd`). What follows for hook code: [hook-file-safety.md](../../../.claude/rules/hook-file-safety.md).
- `watchPaths` printed by a FileChanged hook is honoured under `asyncRewake` (exit 0 plus JSON), but the watcher is re-created only when the sorted list changes: an identical list is a no-op, and a changing list re-creates the watcher on every event and drops events during a checkout. `provided N watchPaths` is logged for SessionStart hooks only (live 2.1.319).

- A `${tool_response.structuredPatch}` placeholder in an `mcp_tool` hook input arrives as JSON text (`[]` for a new file, jsdiff hunks otherwise), `${tool_response.originalFile}` as the plain string (live 2.1.332, P4). A mod reads the same values as arrays and strings from `r.result` after `next` (see [mods-engine-tools.md](mods-engine-tools.md)).

## What a hook's exit 2 leaves in a transcript

- A finding of a background (`asyncRewake`) hook is queued: the main transcript gets a `queue-operation` record with `operation: "enqueue"` whose `content` is `<task-notification>...Stop hook feedback...` followed by `Stop hook blocking error from command "<Event>:<Tool>": <stderr>`. The enqueue timestamp is the moment the hook exited (transcripts of 2.1.319-2.1.325).
- Delivery then shows up in one of two ways: a `user` record whose content is that same string (the finding started a turn of its own), or an `attachment` record of type `queued_command` plus a `queue-operation` `remove` with `reason: "absorbed_mid_turn"` (it was folded into the running turn).
- `hook_blocking_error` attachments with a `toolUseID` appear only where the hook is not backgrounded, that is in headless `claude -p` runs.
- Subagent transcripts live below the session: `<project>/<session id>/subagents/**/*.jsonl`, nested for workflow agents. They hold the subagent's tool calls but never the queued findings, which go to the main transcript.

How to mine these records: [transcript-mining.md](../methods/transcript-mining.md).
