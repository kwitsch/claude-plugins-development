/**
 * The part of the mods engine interface this module uses, typed structurally (the engine typings are not in the repo).
 *
 * @packageDocumentation
 */

/** The result of `$.tool.call`. */
export type ToolResult = {
  /** The refusal text. */
  deny?: unknown;
  /** Whether core reported an error. */
  isError?: boolean;
  /** The tool's output. */
  result?: unknown;
  /** What the model would read. */
  text?: unknown;
};

/** The part of `$` this module uses. */
export type Engine = {
  /** Tools. */
  tool: {
    /** Registers a tool; resolves the full name the engine gave it. */
    register(spec: { name: string; description: string; inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[] }; isDeferred?: boolean }): Promise<{ tool?: string } | undefined>;
    /** Calls a tool of any plugin (through every hook but this plugin's own tool.call). */
    call(input: { tool: string } & Record<string, unknown>): Promise<ToolResult>;
  };
  /** Model requests. */
  model: {
    /** Asks a model one question; `options.signal` cuts the call. */
    complete(spec: { model: string; system: string; prompt: string; maxTokens: number; timeoutMs: number }, options?: { signal?: AbortSignal }): Promise<{ isAnswered: true; text: string } | { isAnswered: false; reason: string }>;
  };
  /** Timers. */
  clock: {
    /** Runs `fn` after `ms`; the handle cancels it. */
    after(ms: number, fn: () => void): { cancel(): void };
  };
  /** The plugin's log. */
  ui: {
    /** Logs one line (the engine adds the plugin's name). */
    log(text: string): unknown;
  };
};

/** The rest of the hook chain. */
export type Next<E, R> = ((e: E) => Promise<R>) & {
  /** Aborts when the dispatch is abandoned. */
  readonly signal: AbortSignal;
};

/** A hook. */
export type Hook<E, R> = ($: Engine, e: E, next: Next<E, R>) => Promise<R>;

/** A `tool.call` event: the full tool name plus the tool input. */
type ToolCall = { tool: string } & Record<string, unknown>;

/** What a `tool.call` hook resolves. */
type ToolAnswer = { result?: unknown; deny?: string } & Record<string, unknown>;

/** The `on` registrar of the module. */
export type On = {
  /**
   * Hooks `session.start`.
   *
   * @param event - The event name.
   * @param hook - The hook.
   */
  (event: "session.start", hook: Hook<unknown, unknown>): void;
  /**
   * Hooks `tool.call`.
   *
   * @param event - The event name.
   * @param hook - The hook.
   */
  (event: "tool.call", hook: Hook<ToolCall, ToolAnswer>): void;
};
