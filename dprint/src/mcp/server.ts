#!/usr/bin/env node
/**
 * `dprint-hooks` MCP stdio server: the tool table; the dual-era JSON-RPC loop is `@shared/mcp-core.js`.
 *
 * @remarks
 * stdout carries JSON-RPC only; logs go to stderr. Each tool backs one hook in `hooks/hooks.json`:
 * `format_pre` (PreToolUse `Write|Edit`) formats via `dprint lsp` and returns `updatedInput`;
 * `cwd_changed` (CwdChanged), `worktree_entered` and `worktree_exited` (PostToolUse `EnterWorktree`/`ExitWorktree`)
 * track the session's cwd; `file_written` (PostToolUse `Write|Edit`) records Edit/Write results and
 * `file_changed` (FileChanged) formats watched files changed by other tools on disk; `bash_started`/`bash_finished`
 * (PreToolUse/PostToolUse `Bash`) format what a Bash call changed before the model reads its output, and
 * `drain_notices` (PreToolUse, UserPromptSubmit) tells the model about reformats nobody announced yet.
 *
 * @packageDocumentation
 */
import { readManifestVersion, serveMcp, type ToolDef } from "@shared/mcp-core.js";
import { bashFinished, bashStarted, cwdChanged, disposeLsp, drainNotices, fileChanged, fileWritten, formatPre, type HookInput, type HookInputs, type HookResult, worktreeEntered, worktreeExited } from "./format.js";

/**
 * Every tool `hooks.json` calls, keyed by name and typed by its generated input: a tool missing here, an
 * extra one, or a handler with the wrong input type is a compile error.
 */
type Tools = { [K in keyof HookInputs]: ToolDef<HookInput<K>, HookResult> };

const TOOLS: Tools = {
  format_pre: {
    description: "PreToolUse Write|Edit: format the write/edit with the project's dprint config via `dprint lsp` before it lands (updatedInput; Edit stays a minimal range-bounded diff).",
    handler: formatPre,
  },
  cwd_changed: {
    description: "CwdChanged: use the new working directory for this session/agent's later format_pre calls.",
    handler: cwdChanged,
  },
  worktree_entered: {
    description: "PostToolUse EnterWorktree: CwdChanged does not fire for it, so capture the worktree path here for later format_pre calls.",
    handler: worktreeEntered,
  },
  worktree_exited: {
    description: "PostToolUse ExitWorktree: switch later format_pre calls back to the cwd from before EnterWorktree.",
    handler: worktreeExited,
  },
  file_written: {
    description: "PostToolUse Write|Edit: remember the written content so file_changed leaves Edit/Write results alone.",
    handler: fileWritten,
  },
  file_changed: {
    description: "FileChanged: format a watched file inside the cwd on disk after a change not made by Edit/Write.",
    handler: fileChanged,
  },
  bash_started: {
    description: "PreToolUse Bash: remember when the Bash call started, for bash_finished.",
    handler: bashStarted,
  },
  bash_finished: {
    description: "PostToolUse and PostToolUseFailure Bash: format the watched files the Bash call changed and tell the model its tool output predates the formatting.",
    handler: bashFinished,
  },
  drain_notices: {
    description: "PreToolUse and UserPromptSubmit: tell the model once about files file_changed reformatted since the last notice.",
    handler: drainNotices,
  },
};

// the name stays aligned with the `.mcp.json` key; stdin closing kills every `dprint lsp` child
serveMcp({ name: "dprint-hooks", version: readManifestVersion(import.meta.url), tools: TOOLS, onClose: disposeLsp });
