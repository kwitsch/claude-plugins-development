#!/usr/bin/env node
/**
 * `dprint-hooks` MCP stdio server: newline-delimited JSON-RPC 2.0, loop copied from universal-format's
 * `server.ts`.
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
import { readFileSync } from "node:fs";
import process from "node:process";
import readline from "node:readline";
import { bashFinished, bashStarted, cwdChanged, disposeLsp, drainNotices, fileChanged, fileWritten, formatPre, type HookResult, worktreeEntered, worktreeExited } from "./format.mjs";
import type { HookInputs } from "./hook-inputs.mjs";

/** Server name reported on `initialize`; keep aligned with the `.mcp.json` key. */
const SERVER_NAME = "dprint-hooks";
/** `serverInfo` reported on `initialize`. */
const SERVER_INFO = { name: SERVER_NAME, version: readVersion() };
/** Protocol version answered when the client's `initialize` omits one. */
const DEFAULT_PROTOCOL = "2025-11-25";
/** The one 2026-07-28-era protocol version this server speaks (stateless: no `initialize`, `_meta` on every request). */
const MODERN_PROTOCOL = "2026-07-28";
/** `_meta` key under which a modern request names its protocol version. */
const VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
/** `_meta` a modern result may carry so the client knows the server (`serverInfo`). */
const SERVER_INFO_META = { "io.modelcontextprotocol/serverInfo": SERVER_INFO };
/** Cache hint of list-like modern results: the tool table is static, so one hour for every client. */
const CACHE_HINT = { ttlMs: 3_600_000, cacheScope: "public" };
/** Input schema of every tool: any object, since Claude Code builds the input from the `hooks.json` templates. */
const ANY_OBJECT = { type: "object", additionalProperties: true };
/**
 * Tool `_meta` that withholds every tool from the model (ToolSearch finds none) while `mcp_tool` hooks still call
 * them. Live-checked on Claude Code 2.1.323 with a local stdio server; the docs name it only for cloud sessions.
 */
const HOOK_ONLY_META = { ui: { visibility: ["app"] } };

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
  params?: { protocolVersion?: unknown; name?: unknown; arguments?: unknown; _meta?: unknown };
};

/**
 * The protocol version a 2026-07-28 request names in `params._meta`.
 *
 * @param params - The request's `params`.
 * @returns The value under the version key (any type, so a malformed one is rejected rather than served as legacy), or `undefined` for a 2025-11-25 request (which carries none).
 */
function requestedVersion(params: RpcRequest["params"]): unknown {
  const meta = params?._meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  return (meta as Record<string, unknown>)[VERSION_META_KEY];
}

/**
 * Message of a caught value.
 *
 * @param e - Anything thrown.
 * @returns `e.message` for an `Error`, else `String(e)`.
 */
const errMsg = (e: unknown): string => e instanceof Error ? e.message : String(e);

/**
 * Serve MCP over stdio until stdin closes, then dispose every `dprint lsp` child and exit.
 */
function startServer(): void {
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
      description: "PostToolUse Bash: format the watched files the Bash call changed and tell the model its tool output predates the formatting.",
      handler: bashFinished,
    },
    drain_notices: {
      description: "PreToolUse and UserPromptSubmit: tell the model once about files file_changed reformatted since the last notice.",
      handler: drainNotices,
    },
  };
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
  const ok = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
  const fail = (id: unknown, code: number, message: string, data?: unknown) => send({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });

  const handle = async (msg: RpcRequest) => {
    const { id, method, params } = msg;
    const version = requestedVersion(params);
    // a request is modern when it names a protocol version in `_meta` (every 2026-07-28 request must) or is
    // `server/discover`; anything else (`initialize`, bare requests) is served as 2025-11-25
    const modern = version !== undefined || method === "server/discover";
    if (version !== undefined && version !== MODERN_PROTOCOL) {
      // a notification (no id) naming an unsupported version is dropped, never run
      if (id === undefined) return;
      return fail(id, -32022, "Unsupported protocol version", { supported: [MODERN_PROTOCOL], requested: version });
    }
    /** Answer `id`; a modern answer gets `resultType` and, for list-like results, the cache hint. */
    const reply = (result: object, cached = false) => ok(id, modern ? { resultType: "complete", ...(cached ? CACHE_HINT : {}), ...result } : result);
    switch (method) {
      case "initialize":
        return ok(id, {
          protocolVersion: params?.protocolVersion ?? DEFAULT_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      case "server/discover":
        return reply({
          supportedVersions: [MODERN_PROTOCOL],
          capabilities: { tools: {} },
          _meta: SERVER_INFO_META,
        }, true);
      case "notifications/initialized":
      case "notifications/cancelled":
        return;
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: Object.entries(TOOLS).map(([name, { description }]) => ({
            name,
            description,
            inputSchema: ANY_OBJECT,
            _meta: HOOK_ONLY_META,
          })),
          ...(modern ? { _meta: SERVER_INFO_META } : {}),
        }, true);
      case "tools/call": {
        const name = params?.name;
        if (typeof name !== "string" || !Object.hasOwn(TOOLS, name)) {
          return fail(id, -32602, `unknown tool: ${String(name)}`);
        }
        const args = params?.arguments ?? {};
        if (typeof args !== "object" || args === null || Array.isArray(args)) {
          return fail(id, -32602, "arguments must be an object");
        }
        // trust boundary: the object's shape is the hooks.json template that typed this tool's input
        const handler = TOOLS[name as keyof Tools].handler;
        let result;
        try {
          result = await handler(args);
        } catch (e) {
          return fail(id, -32603, `tool error: ${errMsg(e)}`);
        }
        return reply({
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
      if (req.id !== undefined) {
        fail(req.id, -32603, `internal error: ${errMsg(e)}`);
      }
    });
  });
  rl.on("close", () => {
    disposeLsp();
    process.exit(0);
  });
}

startServer();
