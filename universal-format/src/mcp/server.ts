#!/usr/bin/env node
/**
 * `universal-format-hooks` MCP stdio server: newline-delimited JSON-RPC 2.0, modelled on `dprint/src/mcp/server.ts`.
 *
 * @remarks
 * stdout carries JSON-RPC only; logs go to stderr. Its one tool `format_pre` backs the one hook in
 * `hooks/hooks.json` (PreToolUse `Write|Edit`): every supported language is formatted before the write and handed
 * back as `updatedInput` (see `handlers.ts`).
 *
 * @packageDocumentation
 */
import type { CallToolResult, DiscoverResult, Implementation, JSONRPCErrorResponse, JSONRPCRequest, JSONRPCResultResponse, ListToolsResult, ServerCapabilities, Tool } from "@modelcontextprotocol/server";
import { readFileSync } from "node:fs";
import process from "node:process";
import readline from "node:readline";
import { formatPre, type FormatPreInput, type HookResult } from "./handlers.js";

/** Server name reported on `initialize`; keep aligned with the `.mcp.json` key. */
const SERVER_NAME = "universal-format-hooks";
/** `serverInfo` reported on `initialize`. */
const SERVER_INFO: Implementation = { name: SERVER_NAME, version: readVersion() };
/** The 2025-era protocol version this server answers `initialize` with. */
const DEFAULT_PROTOCOL = "2025-11-25";
/** The one 2026-07-28-era protocol version this server speaks (stateless: no `initialize`, `_meta` on every request). */
const MODERN_PROTOCOL = "2026-07-28";
/** `_meta` key under which a modern request names its protocol version. */
const VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
/** `_meta` a modern result may carry so the client knows the server (`serverInfo`). */
const SERVER_INFO_META = { "io.modelcontextprotocol/serverInfo": SERVER_INFO };
/** Cache hint of list-like modern results: the tool table is static, so one hour for every client. */
const CACHE_HINT = { ttlMs: 3_600_000, cacheScope: "public" };
/** Input schema of the tool: any object, since Claude Code builds the input from the `hooks.json` template. */
const ANY_OBJECT: Tool["inputSchema"] = { type: "object", additionalProperties: true };
/** Capabilities of both eras: tools only (no tasks: the tool is a short hook call). */
const CAPABILITIES: ServerCapabilities = { tools: {} };
/** A JSON-RPC request id. */
type RequestId = JSONRPCRequest["id"];
/** Tool `_meta` that withholds the tool from the model while the `mcp_tool` hook still calls it. */
const HOOK_ONLY_META: Tool["_meta"] = { ui: { visibility: ["app"] } };

/**
 * Read the plugin version from the generated manifest next to this server.
 *
 * @returns The manifest `version`, or `0.0.0` when the manifest is missing or unreadable.
 */
function readVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** One MCP tool: its `tools/list` description plus the hook handler behind `tools/call`. */
type ToolDef = {
  /** Human-readable purpose shown in `tools/list`. */
  description: string;
  /** Hook handler; its result becomes the tool call's `structuredContent`. `signal` aborts when the client cancels the call. */
  handler: (args: FormatPreInput, signal: AbortSignal) => Promise<HookResult>;
};

/** A parsed JSON-RPC message from the client; every field is checked before use. */
type RpcRequest = {
  /** Request id; absent on notifications. */
  id?: RequestId;
  /** Method name. */
  method?: unknown;
  /** Method parameters. */
  params?: { protocolVersion?: unknown; name?: unknown; arguments?: unknown; requestId?: unknown; _meta?: unknown };
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
 * Serve MCP over stdio until stdin closes, then exit.
 */
function startServer(): void {
  const TOOLS: Record<string, ToolDef> = {
    format_pre: {
      description: "PreToolUse Write|Edit: format the content before the write (updatedInput): the prettier languages in-process with the bundled prettier, Kotlin, Python, Go and Rust through the first CLI formatter on PATH, fed on stdin.",
      handler: formatPre,
    },
  };
  /** Abort controllers of the `tools/call` requests in flight, by request id: `notifications/cancelled` aborts one. */
  const inflight = new Map<RequestId, AbortController>();
  const send = (msg: JSONRPCResultResponse | JSONRPCErrorResponse) => process.stdout.write(JSON.stringify(msg) + "\n");
  // a message without an id is a notification: it never gets an answer
  const ok = (id: RequestId | undefined, result: JSONRPCResultResponse["result"]) => id === undefined || send({ jsonrpc: "2.0", id, result });
  const fail = (id: RequestId | undefined, code: number, message: string, data?: unknown) => id === undefined || send({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });

  const handle = async (msg: RpcRequest) => {
    const { id, method, params } = msg;
    const version = requestedVersion(params);
    // a request is modern when it names a protocol version in `_meta` (every 2026-07-28 request must) or is
    // `server/discover`; anything else (`initialize`, bare requests) is served as 2025-11-25
    const modern = version !== undefined || method === "server/discover";
    if (version !== undefined && version !== MODERN_PROTOCOL) {
      return fail(id, -32022, "Unsupported protocol version", { supported: [MODERN_PROTOCOL], requested: version });
    }
    /** Answer `id`; a modern answer gets `resultType` and, for list-like results, the cache hint. */
    const reply = (result: DiscoverResult | ListToolsResult | CallToolResult | Record<string, never>, cached = false) => ok(id, modern ? { resultType: "complete", ...(cached ? CACHE_HINT : {}), ...result } : result);
    switch (method) {
      case "initialize":
        // spec: answer with a version this server supports (the client then accepts or disconnects), never echo the request
        return ok(id, { protocolVersion: DEFAULT_PROTOCOL, capabilities: CAPABILITIES, serverInfo: SERVER_INFO });
      case "server/discover":
        return reply({ supportedVersions: [MODERN_PROTOCOL], capabilities: CAPABILITIES, _meta: SERVER_INFO_META }, true);
      case "notifications/initialized":
        return;
      case "notifications/cancelled": {
        // an unknown or finished request id is ignored (the spec allows a cancel to race the answer)
        const target = params?.requestId;
        if (typeof target === "string" || typeof target === "number") inflight.get(target)?.abort();
        return;
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: Object.entries(TOOLS).map(([name, { description }]) => ({ name, description, inputSchema: ANY_OBJECT, _meta: HOOK_ONLY_META })),
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
        // a cancelled call stops being waited for and gets no answer (spec); a format already running in-process
        // finishes in the background, its result is dropped
        const call = new AbortController();
        if (id !== undefined) inflight.set(id, call);
        let result: HookResult | undefined;
        try {
          result = await Promise.race([
            // trust boundary: the handler checks every field of the object
            TOOLS[name].handler(args, call.signal),
            new Promise<undefined>((resolve) => call.signal.addEventListener("abort", () => resolve(undefined), { once: true })),
          ]);
        } catch (e) {
          if (!call.signal.aborted) return fail(id, -32603, `tool error: ${errMsg(e)}`);
        } finally {
          if (id !== undefined) inflight.delete(id);
        }
        if (call.signal.aborted || result === undefined) {
          process.stderr.write(`[${SERVER_NAME}] cancelled tools/call ${String(id)} (${name})\n`);
          return;
        }
        return reply({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
      }
      default:
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
      process.stderr.write(`[${SERVER_NAME}] handler crash: ${e instanceof Error ? e.stack : String(e)}\n`);
      // a request (has an id) must always get a response, or the client hangs
      if (req.id !== undefined) fail(req.id, -32603, `internal error: ${errMsg(e)}`);
    });
  });
  rl.on("close", () => process.exit(0));
}

startServer();
