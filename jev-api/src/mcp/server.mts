#!/usr/bin/env node
/**
 * `jev-api-http` MCP stdio server: the HTTP part of jev-api. The mod calls it with `$.mcp.call` because the engine's
 * `$.http.fetch` has no timeout option and no cancellation, and `$.mcp.call` itself is not cancelled when the mod's
 * dispatch is abandoned (measured live on Claude Code 2.1.325). The server therefore enforces the per-call timeout
 * with an `AbortController` on its own `fetch` and aborts a request on the app-level `cancel` tool.
 *
 * @remarks
 * Newline-delimited JSON-RPC 2.0, dual-era (2025-11-25 `initialize`, 2026-07-28 `server/discover`) as in
 * `.claude/rules/mcp-dual-era.md`, modelled on `dprint/src/mcp/server.mts`; no tasks. stdout carries JSON-RPC only.
 * The two tools stay visible: a tool with `_meta.ui.visibility` without `model` is not callable by `$.mcp.call`
 * (measured), so the model is kept off them by the mod's `tool.check` hook, and the server takes no URL, header or key
 * from its caller: it reads `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `JEV_URL` and `TYPESAFE_DEFAULT_MODEL` from its own
 * environment, which is the whole Claude Code environment including the settings' `env` block (measured live).
 *
 * @packageDocumentation
 */
import type { CallToolResult, DiscoverResult, Implementation, JSONRPCErrorResponse, JSONRPCRequest, JSONRPCResultResponse, ListToolsResult, ServerCapabilities, Tool } from "@modelcontextprotocol/server";
import { readFileSync } from "node:fs";
import process from "node:process";
import readline from "node:readline";
import { messageOf, named, sendRequest } from "../shared/http.mjs";
import type { HttpEnv, Outcome } from "../shared/http.mjs";

/** Server name reported on `initialize`; the `.mcp.json` key is `http`, the engine names the server `plugin:jev-api:http`. */
const SERVER_NAME = "jev-api-http";
/** Protocol version answered when the client's `initialize` omits one. */
const DEFAULT_PROTOCOL = "2025-11-25";
/** The one 2026-07-28-era protocol version this server speaks (stateless: no `initialize`, `_meta` on every request). */
const MODERN_PROTOCOL = "2026-07-28";
/** `_meta` key under which a modern request names its protocol version. */
const VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
/** Cache hint of list-like modern results: the tool table is static, so one hour for every client. */
const CACHE_HINT = { ttlMs: 3_600_000, cacheScope: "public" };
/** Capabilities of both eras: tools only (no tasks: a request ends within the caller's timeout of at most 30 s). */
const CAPABILITIES: ServerCapabilities = { tools: {} };
/** A JSON-RPC request id. */
type RequestId = JSONRPCRequest["id"];

/** The longest timeout a request may ask for (ms): the plugin's 30 s bound, which is also the engine's own cap. */
const MAX_TIMEOUT_MS = 30_000;
/** The most bytes of a response body the server reads; System One answers are small, anything beyond is refused. */
const MAX_BODY_BYTES = 1_048_576;
/** How many cancelled call ids are remembered for a request that has not arrived yet. */
const MAX_TOMBSTONES = 256;
/** How long a remembered cancel lives (ms); `JEV_API_TOMBSTONE_MS` overrides it, for tests only. */
const TOMBSTONE_MS = ((): number => {
  const v = Number(process.env["JEV_API_TOMBSTONE_MS"]);
  return Number.isInteger(v) && v >= 0 && process.env["JEV_API_TOMBSTONE_MS"] !== undefined ? v : 60_000;
})();
/** A call id: 1 to 64 of letters, digits, dot, underscore, dash. */
const CALL_ID = /^[A-Za-z0-9._-]{1,64}$/;
/** What every tool description starts with: the model is told not to use the tool. */
const INTERNAL = "Internal transport of the jev-api plugin; calls from the model are refused.";

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

/** `serverInfo` reported on `initialize` and in modern `_meta`. */
const SERVER_INFO: Implementation = { name: SERVER_NAME, version: readVersion() };
/** `_meta` a modern result may carry so the client knows the server. */
const SERVER_INFO_META = { "io.modelcontextprotocol/serverInfo": SERVER_INFO };

/** The tools of the server. No `_meta.ui.visibility`: `$.mcp.call` cannot reach a hidden tool. */
const TOOLS: Tool[] = [
  {
    name: "request",
    description: `${INTERNAL} Sends one System One request to the endpoint the server's environment configures and answers its outcome. The timeout ends the HTTP request and closes the connection.`,
    inputSchema: {
      type: "object",
      properties: {
        callId: { type: "string", pattern: CALL_ID.source, description: "Names the request so `cancel` can abort it." },
        state: { type: "string", minLength: 1, description: "The text the questions are about." },
        questions: { type: "object", description: "The `questions` object of the System One request." },
        timeoutMs: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS, description: "How long the HTTP request may take, in milliseconds." },
      },
      required: ["callId", "state", "questions", "timeoutMs"],
      additionalProperties: false,
    },
  },
  {
    name: "cancel",
    description: `${INTERNAL} Aborts the request with this call id (a cancel that arrives first is remembered for 60 s) and answers whether one was running.`,
    inputSchema: { type: "object", properties: { callId: { type: "string", pattern: CALL_ID.source } }, required: ["callId"], additionalProperties: false },
  },
];

/** A parsed JSON-RPC message from the client; every field is checked before use. */
type RpcRequest = {
  /** Request id; absent on notifications. */
  id?: RequestId;
  /** Method name. */
  method?: unknown;
  /** Method parameters. */
  params?: { name?: unknown; arguments?: unknown; requestId?: unknown; _meta?: unknown };
};

/** One `request` call in flight. */
type Flight = {
  /** Aborts the call's HTTP request. */
  controller: AbortController;
  /** Set when the client cancelled the JSON-RPC call itself: no answer is written for it. */
  silent: boolean;
};

/**
 * The protocol version a 2026-07-28 request names in `params._meta`.
 *
 * @param params - The request's `params`.
 * @returns The value under the version key (any type, so a malformed one is rejected rather than served as legacy), or `undefined` for a 2025-11-25 request.
 */
function requestedVersion(params: RpcRequest["params"]): unknown {
  const meta = params?._meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  return (meta as Record<string, unknown>)[VERSION_META_KEY];
}

/**
 * An environment variable, trimmed.
 *
 * @param name - The variable.
 * @returns The value, or undefined when unset or blank.
 */
function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

/**
 * Reads a response body up to {@link MAX_BODY_BYTES}.
 *
 * @param res - The response.
 * @returns The body text.
 * @throws When the body is longer than the limit (`response too large`), or when the request is aborted while reading.
 */
async function readBody(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
    if (done || value === undefined) break;
    total += value.length;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Serve MCP over stdio until stdin closes.
 */
function startServer(): void {
  /** `request` calls in flight, by JSON-RPC id (`notifications/cancelled`). */
  const byRpc = new Map<RequestId, Flight>();
  /** `request` calls in flight, by call id (`cancel`). */
  const byCall = new Map<string, Flight>();
  /** Cancels that arrived before their request: call id to expiry (insertion order is age). */
  const tombstones = new Map<string, number>();
  const send = (msg: JSONRPCResultResponse | JSONRPCErrorResponse) => process.stdout.write(JSON.stringify(msg) + "\n");
  // a message without an id is a notification: it never gets an answer
  const ok = (id: RequestId | undefined, result: JSONRPCResultResponse["result"]) => id === undefined || send({ jsonrpc: "2.0", id, result });
  const fail = (id: RequestId | undefined, code: number, message: string, data?: unknown) => id === undefined || send({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });

  /**
   * A tool result: the structured content and a text block with the same JSON.
   *
   * @param value - The result object.
   * @param isError - Whether the call failed.
   * @returns The `tools/call` result (without the modern wrapper fields).
   */
  const toolResult = (value: Record<string, unknown>, isError = false): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError });
  /**
   * A tool error for invalid input: plain text, no structured content.
   *
   * @param tool - The tool called.
   * @param why - What is wrong.
   * @returns The `tools/call` result.
   */
  const invalid = (tool: string, why: string): CallToolResult => ({ content: [{ type: "text", text: `${tool}: ${why}` }], isError: true });
  /**
   * The result of a request that ended in an outcome: an `error` outcome is an error result, everything else is not.
   *
   * @param outcome - What the request came to.
   * @returns The `tools/call` result.
   */
  const outcomeResult = (outcome: Outcome): CallToolResult => toolResult(outcome, outcome.kind === "error");

  /**
   * Whether a cancel for this call id is remembered and still valid; the memory is consumed either way.
   *
   * @param callId - The call id.
   * @returns True when the request must not be sent.
   */
  const cancelledEarly = (callId: string): boolean => {
    const until = tombstones.get(callId);
    if (until === undefined) return false;
    tombstones.delete(callId);
    return Date.now() < until;
  };

  /**
   * Handles `tools/call` `request`.
   *
   * @param args - The call's arguments (a trust boundary: checked here).
   * @param flight - The call's abort handle.
   * @returns The tool result.
   */
  const runRequest = async (args: Record<string, unknown>, flight: Flight): Promise<CallToolResult> => {
    const { callId, state, questions, timeoutMs } = args;
    if (typeof callId !== "string" || !CALL_ID.test(callId)) return invalid("request", "callId must be 1 to 64 characters of letters, digits, dot, underscore or dash");
    if (typeof state !== "string" || state === "") return invalid("request", "state must be a non-empty string");
    if (typeof questions !== "object" || questions === null || Array.isArray(questions)) return invalid("request", "questions must be an object");
    if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) return invalid("request", `timeoutMs must be a whole number from 1 to ${MAX_TIMEOUT_MS}`);
    if (byCall.has(callId)) return invalid("request", "callId is already in use by a running request");
    const config: HttpEnv = { key: env("TYPESAFE_API_KEY"), base: env("TYPESAFE_BASE_URL"), jevUrl: env("JEV_URL"), model: env("TYPESAFE_DEFAULT_MODEL") };
    if (!config.key && !config.base && !config.jevUrl) return outcomeResult({ kind: "error", code: "config", message: "no System One access configured: set TYPESAFE_API_KEY, TYPESAFE_BASE_URL or JEV_URL" });
    if (cancelledEarly(callId)) return outcomeResult({ kind: "error", code: "aborted", message: "the call was abandoned" });
    byCall.set(callId, flight);
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([timeout, flight.controller.signal]);
      const outcome = await sendRequest(config, state, questions as Record<string, unknown>, async (url, init) => {
        try {
          const res = await fetch(url, { ...init, signal });
          return { status: res.status, text: await readBody(res) };
        } catch (e) {
          // the caller's two ends first (a cancel wins over a timeout that fires at the same time), anything else as it is
          if (flight.controller.signal.aborted) throw named("AbortError", "the call was abandoned");
          if (timeout.aborted) throw named("TimeoutError", `timeout after ${timeoutMs}ms`);
          throw e;
        }
      });
      return outcomeResult(outcome);
    } finally {
      byCall.delete(callId);
    }
  };

  /**
   * Handles `tools/call` `cancel`: aborts a running request, or remembers the cancel for one that has not arrived.
   *
   * @param args - The call's arguments (a trust boundary: checked here).
   * @returns The tool result.
   */
  const runCancel = (args: Record<string, unknown>): CallToolResult => {
    const { callId } = args;
    if (typeof callId !== "string" || !CALL_ID.test(callId)) return invalid("cancel", "callId must be 1 to 64 characters of letters, digits, dot, underscore or dash");
    const running = byCall.get(callId);
    if (running) {
      running.controller.abort();
      return toolResult({ cancelled: true });
    }
    // not running (yet): remember it, oldest first out
    tombstones.delete(callId);
    while (tombstones.size >= MAX_TOMBSTONES) tombstones.delete(tombstones.keys().next().value as string);
    tombstones.set(callId, Date.now() + TOMBSTONE_MS);
    return toolResult({ cancelled: false });
  };

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
        return ok(id, {
          // spec: answer with a version this server supports (the client then accepts or disconnects), never echo the request
          protocolVersion: DEFAULT_PROTOCOL,
          capabilities: CAPABILITIES,
          serverInfo: SERVER_INFO,
        });
      case "server/discover":
        return reply({ supportedVersions: [MODERN_PROTOCOL], capabilities: CAPABILITIES, _meta: SERVER_INFO_META }, true);
      case "notifications/initialized":
        return;
      case "notifications/cancelled": {
        // Kept for any client that sends it (the dual-era rule requires it; Claude Code does for an `mcp_tool` hook that timed out):
        // the mod's `$.mcp.call` cannot, which is why the app-level `cancel` tool exists. An unknown or finished request id is ignored
        // (the spec allows a cancel to race the answer).
        const target = params?.requestId;
        if (typeof target === "string" || typeof target === "number") {
          const flight = byRpc.get(target);
          if (flight) {
            flight.silent = true;
            flight.controller.abort();
          }
        }
        return;
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS, ...(modern ? { _meta: SERVER_INFO_META } : {}) }, true);
      case "tools/call": {
        const name = params?.name;
        if (name !== "request" && name !== "cancel") return fail(id, -32602, `unknown tool: ${String(name)}`);
        const args = params?.arguments ?? {};
        if (typeof args !== "object" || args === null || Array.isArray(args)) return fail(id, -32602, "arguments must be an object");
        if (name === "cancel") return reply(runCancel(args as Record<string, unknown>));
        const flight: Flight = { controller: new AbortController(), silent: false };
        if (id !== undefined) byRpc.set(id, flight);
        try {
          const result = await runRequest(args as Record<string, unknown>, flight);
          // a call the client cancelled gets no answer (spec)
          if (flight.silent) {
            process.stderr.write(`[${SERVER_NAME}] cancelled tools/call ${String(id)} (request)\n`);
            return;
          }
          return reply(result);
        } finally {
          if (id !== undefined) byRpc.delete(id);
        }
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
      if (req.id !== undefined) fail(req.id, -32603, `internal error: ${messageOf(e)}`);
    });
  });
  rl.on("close", () => process.exit(0));
}

startServer();
