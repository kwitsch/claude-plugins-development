#!/usr/bin/env node
/**
 * `lint` MCP stdio server of universal-lint: the tool table; the dual-era JSON-RPC loop is `@shared/mcp-core.js`.
 *
 * @remarks
 * stdout carries JSON-RPC only; logs go to stderr. `file_edited` and `next_report` are called by the plugin's mod
 * through `$.mcp.call`, so they are model-visible and act only for the per-session key; `stop`, `file_changed` and
 * `prompt_submitted` back the `mcp_tool` hooks of `hooks/hooks.json` and are hook-only.
 *
 * @packageDocumentation
 */
import { readManifestVersion, serveMcp, type ToolDef } from "@shared/mcp-core.js";
import { type Answer, createHandlers, type ToolArgs } from "./handlers.js";

/** The handlers and their shared state, one set per server process. */
const h = createHandlers();
/** The five tools, by name. */
const TOOLS: Record<string, ToolDef<ToolArgs, Answer>> = {
  file_edited: {
    description: "Internal: called by the universal-lint plugin after a Write or Edit to lint the written file read-only. A call without the plugin's session key is ignored.",
    modelVisible: true,
    inputSchema: { type: "object", properties: { key: { type: "string" }, cwd: { type: "string" }, session_id: { type: "string" }, agent_id: { type: "string" }, tool_name: { type: "string" }, tool_input: { type: "object" }, tool_response: { type: "object" } }, required: ["cwd", "session_id", "tool_name", "tool_input"] },
    handler: h.file_edited,
  },
  next_report: {
    description: "Internal: called by the universal-lint plugin while the session is idle to learn whether a lint report is ready. A call without the plugin's session key is ignored.",
    modelVisible: true,
    inputSchema: { type: "object", properties: { key: { type: "string" }, session_id: { type: "string" }, wait_ms: { type: "number" } }, required: ["session_id"] },
    handler: h.next_report,
  },
  stop: { description: "Stop and SubagentStop: lint the stopping agent's files no report has covered yet and block the stop once with the findings.", handler: h.stop },
  file_changed: { description: "FileChanged: lint a watched file changed outside Write/Edit; findings are reported later.", handler: h.file_changed },
  prompt_submitted: { description: "UserPromptSubmit: hand the main conversation its ready lint reports as context.", handler: h.prompt_submitted },
};

// the name stays aligned with the `.mcp.json` key; stdin closing aborts every running lint
serveMcp({ name: "lint", version: readManifestVersion(import.meta.url), tools: TOOLS, onClose: h.closeAll });
