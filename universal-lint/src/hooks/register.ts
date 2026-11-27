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
  mcp: {
    /** Connects to the plugin's own server by its `.mcp.json` key; answers the full name (`plugin:<plugin>:<key>`) that `call` takes. */
    connect(key: string): Promise<{ isConnected: boolean; server: string }>;
    /** Calls a server tool; there is no timeout and a cancelled dispatch does not cancel the call, so the server enforces its own deadlines. */
    call(server: string, tool: string, args: Record<string, unknown>): Promise<McpResult>;
  };
  /** The session id and the calling agent's cwd. */
  session: {
    /** The current session id; it changes on `/clear` while the same server process keeps running. */
    id(): Promise<string>;
    /** The cwd of the calling agent (the worktree after EnterWorktree, a subagent's own worktree), read per call. */
    cwd(): Promise<string>;
  };
  /** Environment variables of the Claude Code process. */
  env: {
    /** The value of a variable, or `undefined` when it is unset; a hook above can refuse the call. */
    get(name: string): Promise<string | undefined>;
  };
  /** Starts a turn in the idle session. */
  prompt: {
    /** Queues a prompt of this plugin that runs when the session is idle; it does not pass through this mod's own `prompt.submit` hook. */
    submit(input: { text: string }): Promise<unknown>;
  };
  /** Out-of-frame timers. */
  clock: {
    /** Runs `fn` once after `ms` outside any hook frame; the returned handle is not used. */
    after(ms: number, fn: () => unknown): unknown;
  };
};

/** The `tool.call` event fields the mod reads. */
type ToolEvent = {
  /** The tool name (`Write` or `Edit` for this mod's matcher). */
  tool?: string;
  /** The path as the tool call gave it, absolute or relative to the agent's cwd. */
  file_path?: string;
  /** The written text as the model gave it, present for Write only: a PreToolUse `updatedInput` rewrite (universal-format) comes after it, so it is not what landed (`ToolOutcome` has that). */
  content?: string;
  /** The calling subagent's id; absent in the main conversation. */
  agentId?: string;
};

/** The `tool.call` result after `next`. */
type ToolOutcome = {
  /** The tool's own result: for Write and Edit the jsdiff `structuredPatch` array and the `originalFile` text before the change, for Write also the `content` that landed (after any PreToolUse `updatedInput` rewrite or permission-dialog edit; live 2.1.332). */
  result?: { structuredPatch?: unknown; originalFile?: unknown; content?: unknown };
  /** Extra text for the model that rides on the tool result; this mod appends the findings here. */
  context?: string[];
  /** Set when a hook above refused the call. */
  deny?: unknown;
  /** Set when the tool itself failed. */
  isError?: unknown;
} | undefined;

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
  (event: "session.start" | "session.end" | "turn.complete" | "prompt.submit", hook: Hook<{ agentId?: string }, unknown>): void;
};

/** Most session ids whose key the mod remembers; past it the oldest is dropped (that session would not get its key back). */
const MAX_KEYS = 50;

/** Mod state of one plugin load (it spans `/clear`: the server process and its session keys outlive a session id). */
type State = {
  /** The full server name after the first connect; cleared after a failed call so the next call connects again. */
  server: string | undefined;
  /** The session key the server issued, per session id: the server keys each id once, and the process can come back to an id it keyed before. */
  keys: Map<string, string>;
  /** The call that is fetching the key of a session id; overlapping calls of that session wait for it (see `call`). */
  shakes: Map<string, Promise<unknown>>;
  /** Whether the session is headless (`claude -p`): `true` or `false` once a source answered, `undefined` while unknown. Only `false` arms the idle wake. */
  headless: boolean | undefined;
  /** Generation of the idle window: bumped by `session.start`, `session.end` and every typed prompt, so a wake loop of an older window stops. */
  gen: number;
  /** Whether a wake loop of the current generation is scheduled or polling; owned by `turn.complete` (set) and the loop's `finally` (cleared). */
  waiting: boolean;
};

/** A tool answer of the server: a key issue `{ key, headless }`, a `file_edited` `{ context }` or a `next_report` `{ state }`. */
type Answer = {
  /** The session key of a key issue. */
  key?: unknown;
  /** The server's view of headless in a key issue. */
  headless?: unknown;
  /** The findings text for the tool result (a `file_edited` answer). */
  context?: unknown;
  /** The wake poll's state: `ready`, `timeout` or `busy` (a `next_report` answer). */
  state?: unknown;
};

/**
 * One tool call with the key of the call's session id (none yet: unkeyed); connects lazily.
 *
 * @param $ - The engine.
 * @param st - The mod state.
 * @param tool - The server tool.
 * @param args - The tool arguments without the key; `session_id` names the session.
 * @returns The parsed answer; throws on a missing answer or `isError`.
 */
async function callOnce($: Engine, st: State, tool: string, args: Record<string, unknown>): Promise<Answer | undefined> {
  st.server ??= (await $.mcp.connect("lint")).server;
  const r = await $.mcp.call(st.server, tool, { ...args, key: st.keys.get(String(args.session_id)) });
  const text = r?.content?.[0]?.text;
  if (r?.isError || typeof text !== "string") throw new Error("no answer");
  return JSON.parse(text) as Answer;
}

/**
 * One keyed tool call; a key-issue answer is stored for the call's session id and the call repeated once (a second key issue gives `undefined`).
 *
 * @param $ - The engine.
 * @param st - The mod state.
 * @param tool - The server tool.
 * @param args - The tool arguments without the key.
 * @returns The answer, or `undefined` on any error (the server name is then cleared, so the next call reconnects).
 */
async function callKeyed($: Engine, st: State, tool: string, args: Record<string, unknown>): Promise<Answer | undefined> {
  const sid = String(args.session_id);
  try {
    for (let round = 0; round < 2; round++) {
      const a = await callOnce($, st, tool, args);
      if (typeof a?.key !== "string") return a;
      // the newest entry; past `MAX_KEYS` ids the oldest goes
      st.keys.delete(sid);
      st.keys.set(sid, a.key);
      for (const old of st.keys.keys()) {
        if (st.keys.size <= MAX_KEYS) break;
        st.keys.delete(old);
      }
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
 * One tool call of the mod's session. The server issues a session id's key to its first call and answers every other
 * call without that key neutrally (`{}`, `busy`), which reads as 'nothing to report': overlapping calls of a session
 * the mod has no key for therefore take turns, the first fetches the key and the others wait for it.
 *
 * @param $ - The engine.
 * @param st - The mod state.
 * @param tool - The server tool.
 * @param args - The tool arguments without the key; `session_id` names the session.
 * @returns The answer, or `undefined` on any error.
 */
async function call($: Engine, st: State, tool: string, args: Record<string, unknown>): Promise<Answer | undefined> {
  const sid = String(args.session_id);
  for (let first = st.shakes.get(sid); first && !st.keys.has(sid); first = st.shakes.get(sid)) await first;
  const run = callKeyed($, st, tool, args);
  if (!st.keys.has(sid)) {
    st.shakes.set(sid, run);
    void run.finally(() => st.shakes.get(sid) === run && st.shakes.delete(sid));
  }
  return run;
}

/**
 * Module entry point called by the engine.
 *
 * @param on - Registers a hook for an event.
 */
export const register = (on: On): void => {
  // State lives here, not at module level: the test kit reloads only this entry.
  const st: State = { server: undefined, keys: new Map(), shakes: new Map(), headless: undefined, gen: 0, waiting: false };
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
  // A prompt typed by the person ends the idle window (the hook runs for typed and queued prompts, live 2.1.332, managed;
  // the mod's own `$.prompt.submit` does not pass through it): a wake loop scheduled or sleeping between polls stops.
  on("prompt.submit", async function onPrompt(_$, e, next) {
    st.gen++;
    st.waiting = false;
    return next(e);
  });
  on("tool.call", { tool: ["Write", "Edit"] }, async function onEdit($, e, next) {
    const r = await next(e);
    if (next.signal?.aborted || !r || r.deny !== undefined || r.isError) return r;
    try {
      const [cwd, session_id] = await Promise.all([$.session.cwd(), $.session.id()]);
      const a = await call($, st, "file_edited", {
        cwd,
        session_id,
        agent_id: e.agentId,
        tool_name: e.tool,
        // the text that landed: `e.content` is the model's, before a PreToolUse rewrite, so its digest would not match the disk and the Write's own FileChanged echo would be linted again
        tool_input: { file_path: e.file_path, content: typeof r.result?.content === "string" ? r.result.content : e.content },
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
            if (gen !== st.gen) return; // a prompt came in before this poll: the idle window is over
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
