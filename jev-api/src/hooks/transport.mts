/**
 * How the System One request leaves the mod: through the plugin's own MCP server (`.mcp.json` key `http`), which
 * enforces the per-call timeout and can cancel a request, or, while that server is not available, through
 * `$.http.fetch` (`fetchViaEngine`, which can neither be cancelled nor given a timeout by the engine).
 *
 * @remarks
 * Measured live (Claude Code 2.1.325): `$.mcp.call` is not cancelled when the dispatch is abandoned and has no timeout,
 * so the mod guards the call itself and tells the server to abort with a second call, `cancel`. A hidden tool
 * (`_meta.ui.visibility` without `model`) is not callable by `$.mcp.call`, so the server's tools are visible and the
 * model is refused by the `tool.check` hook of `register.mts`.
 *
 * @packageDocumentation
 */

import { named, sendRequest } from "../shared/http.mjs";
import type { DoFetch, HttpEnv, Outcome } from "../shared/http.mjs";
import type { Engine, McpResult } from "./types.mjs";
import { isRecord, json, message } from "./util.mjs";

/** This plugin's name: the origin of its own calls in `tool.check`, and part of its server's tool names. */
export const PLUGIN = "jev-api";

/** The `.mcp.json` key of the transport server. */
const SERVER_KEY = "http";

/** What the full names of the server's tools start with: `mcp__plugin_<plugin>_<key>__`. */
export const SERVER_TOOL_PREFIX = `mcp__plugin_${PLUGIN}_${SERVER_KEY}__`;

/** How long a server that was not available is left alone before the next connect (ms). */
const RETRY_CONNECT_MS = 60_000;

/** How long the mod waits beyond `timeoutMs` for the server's answer before it gives the call up (ms): the server ends the request at `timeoutMs` itself. */
const SERVER_GUARD_MS = 1500;

/** The longest the mod waits for `$.mcp.connect` (ms). */
const CONNECT_WAIT_MS = 3000;

/** The mod's state about the transport server, one per module instance. */
export type Link = {
  /** The namespaced server name `$.mcp.call` takes; undefined while the server is not available. */
  server: string | undefined;
  /** When the next connect may be tried (ms since epoch of the engine's clock). */
  retryAt: number;
  /** Calls made so far: part of the next call id. */
  counter: number;
  /** Whether the outage in progress was logged already. */
  logged: boolean;
  /** The connect in progress: concurrent calls share it. */
  connecting: Promise<string | undefined> | undefined;
};

/**
 * A fresh link: no server known yet, nothing logged.
 *
 * @returns The link.
 */
export function newLink(): Link {
  return { server: undefined, retryAt: 0, counter: 0, logged: false, connecting: undefined };
}

/**
 * The HTTP call through the engine's `$.http.fetch`: it races the request against the timeout and the abandonment of
 * the dispatch, because the engine's fetch has no signal and no timeout option (a timed-out or abandoned request runs
 * on until it settles or hits the engine's 30 s cap).
 *
 * @param $ - The engine.
 * @param timeoutMs - How long the request may take before it ends as a `TimeoutError`.
 * @param signal - Aborts when the call is abandoned: the request then ends as an `AbortError` at once.
 * @returns The `doFetch` for `sendRequest`.
 */
function fetchViaEngine($: Engine, timeoutMs: number, signal: AbortSignal): DoFetch {
  return async (url, init) => {
    let timer: { cancel(): void } | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const request = $.http.fetch(url, init);
      request.catch(() => undefined); // a late rejection after the timeout or an abort won must not go unhandled
      // The engine does not stop a hook's request when its dispatch is abandoned: answer at once instead of lingering.
      const stop = new Promise<"timeout" | "aborted">((resolve) => {
        timer = $.clock.after(timeoutMs, () => resolve("timeout"));
        if (signal.aborted) resolve("aborted");
        else {
          onAbort = () => resolve("aborted");
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
      const res = await Promise.race([request, stop]);
      if (res === "timeout") throw named("TimeoutError", `timeout after ${timeoutMs}ms`);
      if (res === "aborted") throw named("AbortError", "the call was abandoned");
      return { status: res.status, text: res.text };
    } finally {
      timer?.cancel();
      if (onAbort) signal.removeEventListener("abort", onAbort); // a signal shared by many calls must not collect listeners
    }
  };
}

/**
 * The engine's clock, or the system clock when the engine's is not there.
 *
 * @param $ - The engine.
 * @returns Milliseconds since the epoch.
 */
async function now($: Engine): Promise<number> {
  try {
    return await $.clock.now();
  } catch {
    return Date.now();
  }
}

/**
 * Logs that the server is not available, once per outage; best effort.
 *
 * @param $ - The engine.
 * @param link - The transport state.
 * @param reason - Why the server is not available.
 */
function logOutage($: Engine, link: Link, reason: string): void {
  if (link.logged) return;
  link.logged = true;
  try {
    // not awaited: a log call that never settles must not hold a request
    void Promise.resolve($.ui.log(`jev-api: HTTP server not available, using $.http.fetch: ${reason}`)).catch(() => undefined);
  } catch {
    // best effort
  }
}

/**
 * Marks the server as down until {@link RETRY_CONNECT_MS} from now and logs it once.
 *
 * @param $ - The engine.
 * @param link - The transport state.
 * @param reason - Why the server is not available.
 */
async function markDown($: Engine, link: Link, reason: string): Promise<void> {
  link.server = undefined;
  link.retryAt = (await now($)) + RETRY_CONNECT_MS;
  logOutage($, link, reason);
}

/**
 * The transport server's name, connecting when needed. A failed connect (not connected, thrown, no answer within
 * {@link CONNECT_WAIT_MS}) is not retried for {@link RETRY_CONNECT_MS}; concurrent calls share one connect.
 *
 * @param $ - The engine.
 * @param link - The transport state.
 * @returns The server name for `$.mcp.call`, or undefined while the server is not available.
 */
async function ensureServer($: Engine, link: Link): Promise<string | undefined> {
  if (link.server !== undefined) return link.server;
  if ((await now($)) < link.retryAt) return undefined;
  link.connecting ??= (async () => {
    let reason = "not connected";
    let timer: { cancel(): void } | undefined;
    try {
      const connect = Promise.resolve($.mcp.connect(SERVER_KEY));
      connect.catch(() => undefined); // a late rejection after the wait must not go unhandled
      const late = new Promise<undefined>((resolve) => {
        timer = $.clock.after(CONNECT_WAIT_MS, () => resolve(undefined));
      });
      const c = await Promise.race([connect, late]);
      if (c === undefined) reason = `no answer within ${CONNECT_WAIT_MS} ms`;
      else if (c.isConnected && typeof c.server === "string" && c.server !== "") {
        link.server = c.server;
        link.logged = false; // a later outage is a new one
        return c.server;
      } else reason = c.message ?? reason;
    } catch (err) {
      // A TypeError is the call itself failing: an engine without the mcp API (an older one, a test double) has no
      // server to reach, which is the fetch path with nothing to log. (`$.mcp` must not be read as a value: the
      // engine's static check refuses that, also in lib.mjs.)
      if (err instanceof TypeError) {
        link.retryAt = Number.MAX_SAFE_INTEGER;
        return undefined;
      }
      reason = message(err);
    } finally {
      timer?.cancel();
    }
    await markDown($, link, reason);
    return undefined;
  })().finally(() => {
    link.connecting = undefined;
  });
  return link.connecting;
}

/**
 * Reads the outcome out of an MCP tool result of the server.
 *
 * @param r - The `$.mcp.call` result.
 * @returns The outcome (the structured content, or an error outcome for the plain error text of an invalid input), or undefined when the result is neither.
 */
function readOutcome(r: McpResult): Outcome | undefined {
  const text = r.content?.find((c) => c.type === "text")?.text;
  const sc = isRecord(r.structuredContent) ? r.structuredContent : text === undefined ? undefined : json(text);
  if (isRecord(sc)) {
    if (sc["kind"] === "ok" && typeof sc["status"] === "number" && typeof sc["text"] === "string") return sc as unknown as Outcome;
    if (sc["kind"] === "http" && typeof sc["status"] === "number") return sc as unknown as Outcome;
    if (sc["kind"] === "error" && typeof sc["code"] === "string" && typeof sc["message"] === "string") return sc as unknown as Outcome;
  }
  return r.isError === true && text !== undefined ? { kind: "error", code: "network", message: text } : undefined;
}

/**
 * One request through the server, guarded: the server ends it at `timeoutMs`, the mod gives up {@link SERVER_GUARD_MS}
 * later (a hung server) or when the dispatch is abandoned, and then tells the server to abort with `cancel`.
 *
 * @param $ - The engine.
 * @param server - The server name.
 * @param callId - The id the server knows the request by.
 * @param state - The text the questions are about.
 * @param questionsObject - The `questions` of the request body.
 * @param timeoutMs - How long the HTTP request may take.
 * @param signal - Aborts when the call is abandoned.
 * @returns The outcome, or `{ down }` with the reason when the server failed (the call threw, the answer is no outcome): the caller falls back.
 */
async function callServer($: Engine, server: string, callId: string, state: string, questionsObject: Record<string, unknown>, timeoutMs: number, signal: AbortSignal): Promise<Outcome | { down: string }> {
  let timer: { cancel(): void } | undefined;
  let onAbort: (() => void) | undefined;
  /** Tells the server to abort this request; called at most once, by whichever of the guard and the abandonment wins the race. The answer is not awaited and its failure does not matter. */
  const cancel = (): void => {
    try {
      void Promise.resolve($.mcp.call(server, "cancel", { callId })).catch(() => undefined);
    } catch {
      // best effort
    }
  };
  try {
    const call = Promise.resolve($.mcp.call(server, "request", { callId, state, questions: questionsObject, timeoutMs })).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const stop = new Promise<"guard" | "aborted">((resolve) => {
      timer = $.clock.after(timeoutMs + SERVER_GUARD_MS, () => resolve("guard"));
      if (signal.aborted) resolve("aborted");
      else {
        onAbort = () => resolve("aborted");
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    const r = await Promise.race([call, stop]);
    if (r === "guard") {
      cancel();
      return { kind: "error", code: "timeout", message: `timeout after ${timeoutMs}ms` };
    }
    if (r === "aborted") {
      cancel();
      return { kind: "error", code: "aborted", message: "the call was abandoned" };
    }
    if ("error" in r) return { down: message(r.error) };
    return readOutcome(r.value) ?? { down: "the server's answer was not usable" };
  } finally {
    timer?.cancel();
    if (onAbort) signal.removeEventListener("abort", onAbort); // a signal shared by many calls must not collect listeners
  }
}

/**
 * Sends one System One request: through the transport server while it is available, else through `$.http.fetch`.
 * A server that fails (cannot connect, the call throws, an answer that is no outcome) is marked down for
 * {@link RETRY_CONNECT_MS} and the call goes out through the fetch path instead.
 *
 * @param $ - The engine.
 * @param link - The transport state.
 * @param env - The env values, trimmed (the fetch path needs them; the server reads its own environment).
 * @param state - The text the questions are about.
 * @param questionsObject - The `questions` of the request body.
 * @param timeoutMs - How long the request may take.
 * @param signal - Aborts when the call is abandoned.
 * @returns The outcome; never rejects.
 */
export async function sendOutcome($: Engine, link: Link, env: HttpEnv, state: string, questionsObject: Record<string, unknown>, timeoutMs: number, signal: AbortSignal): Promise<Outcome> {
  const server = await ensureServer($, link);
  if (server !== undefined) {
    if (signal.aborted) return { kind: "error", code: "aborted", message: "the call was abandoned" };
    // a call id the server can tell apart from every other one of this session and of earlier ones; the counter moves
    // before the await, or calls that run side by side would read the same number
    const n = ++link.counter;
    const callId = `${(await now($)).toString(36)}-${n}`;
    const outcome = await callServer($, server, callId, state, questionsObject, timeoutMs, signal);
    if (!("down" in outcome)) return outcome;
    await markDown($, link, outcome.down);
    if (signal.aborted) return { kind: "error", code: "aborted", message: "the call was abandoned" };
  }
  return sendRequest(env, state, questionsObject, fetchViaEngine($, timeoutMs, signal));
}
