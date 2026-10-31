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
import type { HookInputs } from "./hook-inputs.mjs";

/** Server name reported on `initialize`; keep aligned with the `.mcp.json` key. */
const SERVER_NAME = "dprint-hooks";
/** `serverInfo` reported on `initialize`. */
const SERVER_INFO = { name: SERVER_NAME, version: readVersion() };
/** Protocol version answered when the client's `initialize` omits one. */
const DEFAULT_PROTOCOL = "2025-11-25";
/** Input schema of every tool: any object, since Claude Code builds the input from the `hooks.json` templates. */
const ANY_OBJECT = { type: "object", additionalProperties: true };

/**
 * Read the plugin version from the generated manifest next to this server.
 *
 * @returns The manifest `version`, or `0.0.0` when the manifest is missing or unreadable.
 */
function readVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(
        new URL("../.claude-plugin/plugin.json", import.meta.url),
        "utf8",
      ),
    ) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** One MCP tool: its `tools/list` description plus the hook handler behind `tools/call`. */
type ToolDef<A> = {
  /** Human-readable purpose shown in `tools/list`. */
  description: string;
  /** Hook handler; its result becomes the tool call's `structuredContent`. */
  handler: (args: A) => HookResult | Promise<HookResult>;
};

/**
 * Every tool `hooks.json` calls, keyed by name and typed by its generated input: a tool missing here, an
 * extra one, or a handler with the wrong input type is a compile error.
 */
type Tools = { [K in keyof HookInputs]: ToolDef<HookInputs[K]> };

/** A parsed JSON-RPC message from the client; every field is checked before use. */
type RpcRequest = {
  /** Request id; absent on notifications. */
  id?: unknown;
  /** Method name. */
  method?: unknown;
  /** Method parameters. */
  params?: { protocolVersion?: unknown; name?: unknown; arguments?: unknown };
};

/**
 * Message of a caught value.
 *
 * @param e - Anything thrown.
 * @returns `e.message` for an `Error`, else `String(e)`.
 */
const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/**
 * Serve MCP over stdio until stdin closes, then dispose every `dprint lsp` child and exit.
 */
function startServer(): void {
  const TOOLS: Tools = {
    format_pre: {
      description:
        "PreToolUse Write|Edit: format the write/edit with the project's dprint config via `dprint lsp` before it lands (updatedInput; Edit stays a minimal range-bounded diff).",
      handler: formatPre,
    },
    cwd_changed: {
      description:
        "CwdChanged: use the new working directory for this session/agent's later format_pre calls.",
      handler: cwdChanged,
    },
    worktree_entered: {
      description:
        "PostToolUse EnterWorktree: CwdChanged does not fire for it, so capture the worktree path here for later format_pre calls.",
      handler: worktreeEntered,
    },
  };
  const send = (msg: unknown) =>
    process.stdout.write(JSON.stringify(msg) + "\n");
  const ok = (id: unknown, result: unknown) =>
    send({ jsonrpc: "2.0", id, result });
  const fail = (id: unknown, code: number, message: string) =>
    send({ jsonrpc: "2.0", id, error: { code, message } });

  const handle = async (msg: RpcRequest) => {
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
          tools: Object.entries(TOOLS).map(([name, { description }]) => ({
            name,
            description,
            inputSchema: ANY_OBJECT,
          })),
        });
      case "tools/call": {
        const name = params?.name;
        if (typeof name !== "string" || !Object.hasOwn(TOOLS, name))
          return fail(id, -32602, `unknown tool: ${String(name)}`);
        const args = params?.arguments ?? {};
        if (typeof args !== "object" || args === null || Array.isArray(args))
          return fail(id, -32602, "arguments must be an object");
        // trust boundary: the object's shape is the hooks.json template that typed this tool's input
        const handler = TOOLS[name as keyof Tools].handler;
        let result;
        try {
          result = await handler(args);
        } catch (e) {
          return fail(id, -32603, `tool error: ${errMsg(e)}`);
        }
        return ok(id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        });
      }
      default:
        if (id === undefined) return;
        return fail(id, -32601, `method not found: ${String(method)}`);
    }
  };

  process.stderr.write(`[${SERVER_NAME}] running (v${SERVER_INFO.version})\n`);

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      process.stderr.write(`[${SERVER_NAME}] non-JSON line ignored\n`);
      return;
    }
    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
      process.stderr.write(`[${SERVER_NAME}] non-object message ignored\n`);
      return;
    }
    const req: RpcRequest = msg;
    handle(req).catch((e: unknown) => {
      process.stderr.write(
        `[${SERVER_NAME}] handler crash: ${e instanceof Error ? e.stack : String(e)}\n`,
      );
      // a request (has an id) must always get a response, or the client hangs
      if (req.id !== undefined)
        fail(req.id, -32603, `internal error: ${errMsg(e)}`);
    });
  });
  rl.on("close", () => {
    disposeLsp();
    process.exit(0);
  });
}

startServer();
