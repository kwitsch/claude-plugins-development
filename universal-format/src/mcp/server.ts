#!/usr/bin/env node
/**
 * `universal-format-hooks` MCP stdio server: the tool table; the dual-era JSON-RPC loop is `@shared/mcp-core.js`.
 *
 * @remarks
 * stdout carries JSON-RPC only; logs go to stderr. Its one tool `format_pre` backs the one hook in
 * `hooks/hooks.json` (PreToolUse `Write|Edit`): every supported language is formatted before the write and handed
 * back as `updatedInput` (see `handlers.ts`).
 *
 * @packageDocumentation
 */
import { readManifestVersion, serveMcp, type ToolDef } from "@shared/mcp-core.js";
import { formatPre, type FormatPreInput, type HookResult } from "./handlers.js";

// the name stays aligned with the `.mcp.json` key
serveMcp({
  name: "universal-format-hooks",
  version: readManifestVersion(import.meta.url),
  tools: {
    format_pre: {
      description: "PreToolUse Write|Edit: format the content before the write (updatedInput): the prettier languages in-process with the bundled prettier, Kotlin, Python, Go and Rust through the first CLI formatter on PATH, fed on stdin.",
      handler: formatPre satisfies ToolDef<FormatPreInput, HookResult>["handler"],
    },
  },
});
