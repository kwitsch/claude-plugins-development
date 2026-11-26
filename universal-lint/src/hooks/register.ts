/**
 * Claude Code function-hooks module of universal-lint: sends every Write/Edit to the plugin's `lint` MCP server and,
 * in an interactive session, wakes the idle session when a held lint report is ready.
 *
 * @remarks
 * EARLY ACCESS API (verified live on Claude Code 2.1.332 under a managed policy, evaluation page
 * `EVALUATION-2026-11-26-mod-server.md`, "Third probe round"). No `classic.*` and no `tool.check` hook: a managed org
 * passes those over user-tier plugins. Every `$` call after `next` is caught: the tool result is never altered by a
 * failure. The engine members are typed structurally (no engine type import). Only this file uses `$`.
 *
 * @packageDocumentation
 */

/** The one prompt the idle wake submits; the findings themselves reach the model as `prompt_submitted` hook context. */
export const WAKE_TEXT = "universal-lint: files that changed while the session was idle have lint findings. They are attached to this message as hook context. Fix them, or say why not.";

/** The part of a `$.mcp.call` answer the mod reads: the JSON text of the first content item. */
type McpResult = { content?: { text?: unknown }[]; isError?: unknown } | undefined;

/** The engine members the mod uses, typed structurally. */
type Engine = {
  /** MCP access: `connect` answers the full server name that `call` takes. */
  mcp: { connect(key: string): Promise<{ isConnected: boolean; server: string }>; call(server: string, tool: string, args: Record<string, unknown>): Promise<McpResult> };
  /** The session id and the calling agent's cwd. */
  session: { id(): Promise<string>; cwd(): Promise<string> };
  /** Environment variables of the Claude Code process. */
  env: { get(name: string): Promise<string | undefined> };
  /** Starts a turn in the idle session. */
  prompt: { submit(input: { text: string }): Promise<unknown> };
  /** Out-of-frame timers. */
  clock: { after(ms: number, fn: () => unknown): unknown };
};

/** The `tool.call` event fields the mod reads (Write: `content`; `agentId` only for a subagent). */
type ToolEvent = { tool?: string; file_path?: string; content?: string; agentId?: string };

/** The `tool.call` result after `next`: `result` carries the patch and the old content for Write and Edit. */
type ToolOutcome = { result?: { structuredPatch?: unknown; originalFile?: unknown }; context?: string[]; deny?: unknown; isError?: unknown } | undefined;

/**
 * The rest of the hook chain.
 *
 * @typeParam E - The event.
 * @typeParam R - The event's result.
 */
type Next<E, R> = ((e: E) => Promise<R>) & { signal?: AbortSignal };

/**
 * A hook body.
 *
 * @typeParam E - The event.
 * @typeParam R - The event's result.
 */
type Hook<E, R> = ($: Engine, e: E, next: Next<E, R>) => Promise<R>;

/** The registration function the engine passes to {@link register}. */
type On = {
  (event: "tool.call", matcher: { tool: string[] }, hook: Hook<ToolEvent, ToolOutcome>): void;
  (event: "session.start" | "session.end" | "turn.complete", hook: Hook<{ agentId?: string }, unknown>): void;
};

/** Per-session mod state: server name, session key, three-valued headless flag, wake generation and whether a wake poll runs. */
type State = { server: string | undefined; key: string | undefined; headless: boolean | undefined; gen: number; waiting: boolean };

/** A tool answer of the server: a key issue `{ key, headless }`, a `file_edited` `{ context }` or a `next_report` `{ state }`. */
type Answer = { key?: unknown; headless?: unknown; context?: unknown; state?: unknown };

/**
 * One tool call with the current key; connects lazily.
 *
 * @param $ - The engine.
 * @param st - The mod state.
 * @param tool - The server tool.
 * @param args - The tool arguments without the key.
 * @returns The parsed answer; throws on a missing answer or `isError`.
 */
async function callOnce($: Engine, st: State, tool: string, args: Record<string, unknown>): Promise<Answer | undefined> {
  st.server ??= (await $.mcp.connect("lint")).server;
  const r = await $.mcp.call(st.server, tool, { ...args, key: st.key });
  const text = r?.content?.[0]?.text;
  if (r?.isError || typeof text !== "string") throw new Error("no answer");
  return JSON.parse(text) as Answer;
}

/**
 * One keyed tool call; a key-issue answer is stored and the call repeated once (a second key issue gives `undefined`).
 *
 * @param $ - The engine.
 * @param st - The mod state.
 * @param tool - The server tool.
 * @param args - The tool arguments without the key.
 * @returns The answer, or `undefined` on any error (the server name is then cleared, so the next call reconnects).
 */
async function call($: Engine, st: State, tool: string, args: Record<string, unknown>): Promise<Answer | undefined> {
  try {
    for (let round = 0; round < 2; round++) {
      const a = await callOnce($, st, tool, args);
      if (typeof a?.key !== "string") return a;
      st.key = a.key;
      // the server's view: `true` always wins, `false` only fills an unknown
      if (a.headless === true) st.headless = true;
      else if (st.headless === undefined && a.headless === false) st.headless = false;
    }
    return undefined;
  } catch {
    st.server = undefined;
    return undefined;
  }
}

/**
 * Module entry point called by the engine.
 *
 * @param on - Registers a hook for an event.
 */
export const register = (on: On): void => {
  // State lives here, not at module level: the test kit reloads only this entry.
  const st: State = { server: undefined, key: undefined, headless: undefined, gen: 0, waiting: false };
  on("session.start", async function onSessionStart($, e, next) {
    st.gen++;
    st.waiting = false;
    st.server = undefined;
    st.headless = undefined;
    const r = await next(e);
    try {
      const ep = await $.env.get("CLAUDE_CODE_ENTRYPOINT");
      if (typeof ep === "string") st.headless = ep.startsWith("sdk");
    } catch {
      // unknown: the server's key answer is the second source
    }
    try {
      await call($, st, "next_report", { session_id: await $.session.id(), wait_ms: 0 });
    } catch {
      // no key yet: the next call asks again
    }
    return r;
  });
  on("session.end", async function onSessionEnd(_$, e, next) {
    st.gen++;
    st.waiting = false;
    return next(e);
  });
  on("tool.call", { tool: ["Write", "Edit"] }, async function onEdit($, e, next) {
    const r = await next(e);
    if (next.signal?.aborted || !r || r.deny !== undefined || r.isError) return r;
    try {
      const a = await call($, st, "file_edited", {
        cwd: await $.session.cwd(),
        session_id: await $.session.id(),
        agent_id: e.agentId,
        tool_name: e.tool,
        tool_input: { file_path: e.file_path, content: e.content },
        tool_response: { structuredPatch: r.result?.structuredPatch, originalFile: r.result?.originalFile },
      });
      if (typeof a?.context === "string" && a.context !== "" && !next.signal?.aborted) return { ...r, context: [...(r.context ?? []), a.context] };
    } catch {
      // fail open: the tool result goes back unchanged
    }
    return r;
  });
  on("turn.complete", async function onTurnComplete($, e, next) {
    const r = await next(e);
    // a pending $.mcp.call keeps `claude -p` alive: poll only when the session is known to be interactive
    if (!e.agentId && !st.waiting && st.headless === false) {
      st.waiting = true;
      const gen = st.gen;
      $.clock.after(0, async function wake() {
        try {
          for (;;) {
            const a = await call($, st, "next_report", { session_id: await $.session.id() });
            if (gen !== st.gen) return;
            if (a?.state === "ready") {
              await $.prompt.submit({ text: WAKE_TEXT });
              return;
            }
            if (a?.state !== "timeout") return;
          }
        } catch {
          // fail open: no wake
        } finally {
          if (gen === st.gen) st.waiting = false;
        }
      });
    }
    return r;
  });
};
