#!/usr/bin/env node
/**
 * `dprint-hooks` MCP stdio server: newline-delimited JSON-RPC 2.0, loop copied from universal-format's
 * `server.ts`.
 *
 * @remarks
 * stdout carries JSON-RPC only; logs go to stderr. Each tool backs one hook in `hooks/hooks.json`:
 * `format_pre` (PreToolUse `Write|Edit`) formats via `dprint lsp` and returns `updatedInput`;
 * `cwd_changed` (CwdChanged) and `worktree_entered` (PostToolUse `EnterWorktree`) track the session's cwd.
 *
 * @packageDocumentation
 */
import process from "node:process";
import readline from "node:readline";
import { readFileSync } from "node:fs";
import {
  cwdChanged,
  disposeLsp,
  formatPre,
  worktreeEntered,
  type HookResult,
} from "./format.mjs";

/** Server name reported on `initialize`; keep aligned with the `.mcp.json` key. */
const SERVER_NAME = "dprint-hooks";
/** `serverInfo` reported on `initialize`. */
const SERVER_INFO = { name: SERVER_NAME, version: readVersion() };
/** Protocol version answered when the client's `initialize` omits one. */
const DEFAULT_PROTOCOL = "2025-11-25";

/**
 * Read the plugin version from the generated manifest next to this server.
 *
 * @returns The manifest `version`, or `0.0.0` when the manifest is missing or unreadable.
 */
function readVersion(): string {
  try {
    return (
      JSON.parse(
        readFileSync(
          new URL("../.claude-plugin/plugin.json", import.meta.url),
          "utf8",
        ),
      ).version ?? "0.0.0"
    );
  } catch {
    return "0.0.0";
  }
}

/** One MCP tool: its `tools/list` entry plus the hook handler behind `tools/call`. */
type ToolDef = {
  /** Tool name referenced by `hooks.json`. */
  name: string;
  /** Human-readable purpose shown in `tools/list`. */
  description: string;
  /** Accepts any object: Claude Code builds the hook input from the `hooks.json` templates. */
  inputSchema: { type: string; additionalProperties: boolean };
  /** Hook handler; its result becomes the tool call's `structuredContent`. */
  handler: (args: any) => HookResult | Promise<HookResult>;
};

/**
 * Serve MCP over stdio until stdin closes, then dispose every `dprint lsp` child and exit.
 */
function startServer(): void {
  const TOOLS: ToolDef[] = [
    {
      name: "format_pre",
      description:
        "PreToolUse Write|Edit: format the write/edit with the project's dprint config via `dprint lsp` before it lands (updatedInput; Edit stays a minimal range-bounded diff).",
      inputSchema: { type: "object", additionalProperties: true },
      handler: formatPre,
    },
    {
      name: "cwd_changed",
      description:
        "CwdChanged: use the new working directory for this session/agent's later format_pre calls.",
      inputSchema: { type: "object", additionalProperties: true },
      handler: cwdChanged,
    },
    {
      name: "worktree_entered",
      description:
        "PostToolUse EnterWorktree: CwdChanged does not fire for it, so capture the worktree path here for later format_pre calls.",
      inputSchema: { type: "object", additionalProperties: true },
      handler: worktreeEntered,
    },
  ];
  const findTool = (name: string) => TOOLS.find((t) => t.name === name);
  const send = (msg: unknown) =>
    process.stdout.write(JSON.stringify(msg) + "\n");
  const ok = (id: unknown, result: unknown) =>
    send({ jsonrpc: "2.0", id, result });
  const fail = (id: unknown, code: number, message: string) =>
    send({ jsonrpc: "2.0", id, error: { code, message } });

  const handle = async (msg: any) => {
    const { id, method, params } = msg;
    switch (method) {
      case "initialize":
        return ok(id, {
          protocolVersion: params?.protocolVersion ?? DEFAULT_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      case "notifications/initialized":
      case "notifications/cancelled":
        return;
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, {
          tools: TOOLS.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        });
      case "tools/call": {
        const tool = findTool(params?.name);
        if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`);
        let result;
        try {
          result = await tool.handler(params?.arguments ?? {});
        } catch (e: any) {
          return fail(id, -32603, `tool error: ${e?.message ?? e}`);
        }
        return ok(id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        });
      }
      default:
        if (id === undefined) return;
        return fail(id, -32601, `method not found: ${method}`);
    }
  };

  process.stderr.write(`[${SERVER_NAME}] running (v${SERVER_INFO.version})\n`);

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      process.stderr.write(`[${SERVER_NAME}] non-JSON line ignored\n`);
      return;
    }
    Promise.resolve(handle(msg)).catch((e: any) => {
      process.stderr.write(
        `[${SERVER_NAME}] handler crash: ${e?.stack ?? e}\n`,
      );
      // a request (has an id) must always get a response, or the client hangs
      if (msg?.id !== undefined)
        fail(msg.id, -32603, `internal error: ${e?.message ?? e}`);
    });
  });
  rl.on("close", () => {
    disposeLsp();
    process.exit(0);
  });
}

startServer();
