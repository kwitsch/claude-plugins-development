/**
 * The types of the engine interface `$` this plugin uses, of the System One questions and of the hook chain, plus the tool and overflow name lists.
 *
 * @packageDocumentation
 */

/** The System One question types, which are also the names of the single-question tools. */
export const TYPES = ["noul", "choice", "score"] as const;

/** One of {@link TYPES}. */
export type QuestionType = (typeof TYPES)[number];

/** Every tool name: the question types plus `batch`, which asks several questions in one request. */
export const TOOLS = [...TYPES, "batch"] as const;

/** One of {@link TOOLS}. */
export type ToolName = (typeof TOOLS)[number];

/** One System One question as sent in the request body. */
export type Question =
  | {
    /** The question type. */
    type: "noul";
    /** The yes/no question to answer. */
    instructions: string;
    /** Optional wording of true and false. */
    criteria?: { true?: string; false?: string };
  }
  | {
    /** The question type. */
    type: "choice";
    /** What to choose. */
    instructions: string;
    /** Option name to description. */
    criteria: Record<string, string>;
  }
  | {
    /** The question type. */
    type: "score";
    /** What to rate. */
    instructions: string;
    /** The levels, lowest first. */
    criteria: string[];
  };

/** A `$.http.fetch` response. */
export type FetchResponse = {
  /** The HTTP status code. */
  status: number;
  /** Whether the status is 2xx. */
  ok: boolean;
  /** The raw response body. */
  text: string;
};

/** A tool registration passed to `$.tool.register`. */
export type ToolSpec = {
  /** The bare tool name (the engine prefixes it with `mcp__jev-api__`). */
  name: ToolName;
  /** What the model reads to decide when to use the tool. */
  description: string;
  /** JSON Schema of the tool input. */
  inputSchema: {
    /** Always an object schema. */
    type: "object";
    /** The input fields, by name. */
    properties: Record<string, unknown>;
    /** The input fields that must be given. */
    required: string[];
  };
};

/** The part of the engine interface `$` this module uses. */
export type Engine = {
  /** Timers. */
  clock: {
    /** Runs `fn` once after `ms` milliseconds; the handle cancels the pending run. */
    after(ms: number, fn: () => unknown): { cancel(): void };
  };
  /** User-visible output. */
  ui: {
    /** Writes a line to the plugin log. */
    log(text: string): unknown;
  };
  /** The plugin's own JSON key-value store, kept between sessions (a mod cannot read `CLAUDE_PLUGIN_DATA`: live, 2.1.325). */
  store: {
    /** Reads a value; undefined when the key is unset. */
    get(key: string): Promise<unknown>;
    /** Writes a value (any JSON). */
    set(key: string, value: unknown): Promise<unknown>;
  };
  /** Environment variables. */
  env: {
    /** Reads a variable; undefined when unset. */
    get(name: string): Promise<string | undefined>;
  };
  /** HTTP client. */
  http: {
    /** Sends a request; resolves the response (rejects on network failure). */
    fetch(url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<FetchResponse>;
  };
  /** Model requests: the stand-in for Jev when no System One access is configured. */
  model: {
    /** Asks a model one question; resolves the reply, or `isAnswered: false` with the reason. `options.signal` cuts the call (the request has no such field). */
    complete(spec: { model: string; system: string; prompt: string; maxTokens: number; timeoutMs: number }, options?: { signal?: AbortSignal }): Promise<{ isAnswered: true; text: string } | { isAnswered: false; reason: string }>;
  };
  /** Tool registry. */
  tool: {
    /** Registers a tool; resolves the full tool name the engine gave it (a hook above may answer anything). */
    register(spec: ToolSpec): Promise<{ tool?: string } | undefined>;
  };
};

/**
 * The rest of the hook chain for an event.
 *
 * @typeParam E - The event's input.
 * @typeParam R - What the chain resolves.
 */
export type Next<E, R> = ((e: E) => Promise<R>) & {
  /** Aborts when the dispatch is abandoned (the user interrupted, a hook above settled first). */
  readonly signal: AbortSignal;
};

/**
 * A hook: the engine, the event, the rest of the chain.
 *
 * @typeParam E - The event's input.
 * @typeParam R - What the hook resolves.
 */
export type Hook<E, R> = ($: Engine, e: E, next: Next<E, R>) => Promise<R>;

/** A `tool.call` event: the full tool name plus the tool input fields. */
export type ToolCall = { tool: string } & Record<string, unknown>;

/** What a `tool.call` hook resolves: the tool result for the model, or a refusal it reads as an error. */
export type ToolResult = {
  /** The tool's output. */
  result?: unknown;
  /** The error text; the model reads it as an error result (core drops a hook's own `isError`). */
  deny?: string;
} & Record<string, unknown>;

/** The env values a call uses, trimmed; undefined when unset or blank. */
export type Env = {
  /** TYPESAFE_API_KEY. */
  key: string | undefined;
  /** TYPESAFE_BASE_URL. */
  base: string | undefined;
  /** JEV_URL. */
  jevUrl: string | undefined;
  /** TYPESAFE_DEFAULT_MODEL. */
  model: string | undefined;
};

/** The plugin's `userConfig` values as the engine passes them to `register`; any value may be missing or invalid. */
export type Options = Partial<Record<string, unknown>>;

/** The `on` registrar of the module: one overload per hooked event. */
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
  (event: "tool.call", hook: Hook<ToolCall, ToolResult>): void;
};

/** What a call does when its prompt cannot be answered by System One: refuse with the numbers, cut the state, or ask Haiku. */
export const OVERFLOWS = ["error", "truncate", "haiku"] as const;

/** One of {@link OVERFLOWS}. */
export type Overflow = (typeof OVERFLOWS)[number];

/** The overflow mode when neither the call nor the `overflow` option names a valid one. */
export const DEFAULT_OVERFLOW: Overflow = "haiku";
