/**
 * Claude Code function-hooks module of jev-api: registers the TypeSafe Jev System One question types `noul`,
 * `choice` and `score` as tools and answers their calls with one System One request each.
 *
 * @remarks
 * EARLY ACCESS API. No engine type import (the engine typings are not in the repo): the used `$` members and
 * events are typed structurally below. `development/scripts/build-plugin.mts` keeps `hooks/*.mjs` unmangled and
 * uncompressed, since the engine's static check wants `$`/`on` spelled as such and no `$.<noun>` passed as a bare
 * value; every hook is a named function literal. No imports: HTTP goes through `$.http.fetch`.
 *
 * @packageDocumentation
 */

/** The tool names, which are also the System One question types. */
const TYPES = ["noul", "choice", "score"] as const;

/** One of {@link TYPES}. */
type QuestionType = (typeof TYPES)[number];

/** One System One question as sent in the request body. */
type Question =
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
type FetchResponse = {
  /** The HTTP status code. */
  status: number;
  /** Whether the status is 2xx. */
  ok: boolean;
  /** The raw response body. */
  text: string;
};

/** A tool registration passed to `$.tool.register`. */
type ToolSpec = {
  /** The bare tool name (the engine prefixes it with `mcp__jev-api__`). */
  name: QuestionType;
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
type Engine = {
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
type Next<E, R> = ((e: E) => Promise<R>) & {
  /** Aborts when the dispatch is abandoned (the user interrupted, a hook above settled first). */
  readonly signal: AbortSignal;
};

/**
 * A hook: the engine, the event, the rest of the chain.
 *
 * @typeParam E - The event's input.
 * @typeParam R - What the hook resolves.
 */
type Hook<E, R> = ($: Engine, e: E, next: Next<E, R>) => Promise<R>;

/** A `tool.call` event: the full tool name plus the tool input fields. */
type ToolCall = { tool: string } & Record<string, unknown>;

/** What a `tool.call` hook resolves: the tool result for the model, or a refusal it reads as an error. */
type ToolResult = {
  /** The tool's output. */
  result?: unknown;
  /** The error text; the model reads it as an error result (core drops a hook's own `isError`). */
  deny?: string;
} & Record<string, unknown>;

/** The env values a call uses, trimmed; undefined when unset or blank. */
type Env = {
  /** TYPESAFE_API_KEY. */
  key: string | undefined;
  /** TYPESAFE_BASE_URL. */
  base: string | undefined;
  /** JEV_URL. */
  jevUrl: string | undefined;
  /** TYPESAFE_DEFAULT_MODEL. */
  model: string | undefined;
};

/** The `on` registrar of the module: one overload per hooked event. */
type On = {
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

/** Description tail shared by the three tools. */
const NEEDS = " Needs TYPESAFE_API_KEY, TYPESAFE_BASE_URL or JEV_URL to be set.";

/** The `state` input property shared by the three tools. */
const STATE = { type: "string", description: "The text the question is about." };

/** The System One endpoint used when neither JEV_URL nor TYPESAFE_BASE_URL is set. */
const DEFAULT_JEV_URL = "https://api.typesafe.ai/v1/systemone";

/** The model sent when TYPESAFE_DEFAULT_MODEL is unset or blank. */
const DEFAULT_MODEL = "jev-latest";

/** How long one request may take before the tool reports a timeout, in milliseconds. */
const TIMEOUT_MS = 30_000;

/** The key of the single question in `questions` and of its answer in `answers`. */
const QUESTION_ID = "answer";

/** An http(s) URL (jevfort's `JEV_URL` check). */
const HTTP_URL = /^https?:\/\/[^/?#\s]+(?:[/?#]\S*)?$/i;

/** An http(s) API root: like {@link HTTP_URL} but without query or fragment, since a path gets appended. */
const HTTP_BASE = /^https?:\/\/[^/?#\s]+(?:\/[^?#\s]*)?$/i;

/** The most options a `choice` question may have. */
const MAX_OPTIONS = 255;

/** The fewest levels a `score` question may have (the API refuses one). */
const MIN_LEVELS = 2;

/** The most levels a `score` question may have. */
const MAX_LEVELS = 10;

/** The engine names a registered tool `mcp__<plugin>__<name>`. */
const TOOL_PREFIX = "mcp__jev-api__";

/** The three tool registrations without their name, keyed by question type (the key is the name). */
const SPECS: Record<QuestionType, Omit<ToolSpec, "name">> = {
  noul: {
    description: "Ask TypeSafe Jev a yes/no question about a text; returns the probability (0..1) that the answer is true." + NEEDS,
    inputSchema: {
      type: "object",
      properties: {
        instructions: { type: "string", description: "The yes/no question to answer about the text." },
        state: STATE,
        criteria: {
          type: "object",
          description: "Optional: what counts as true and what counts as false.",
          properties: {
            true: { type: "string", description: "What counts as true." },
            false: { type: "string", description: "What counts as false." },
          },
          additionalProperties: false,
        },
      },
      required: ["instructions", "state"],
    },
  },
  choice: {
    description: "Ask TypeSafe Jev to pick one of named options for a text; returns the choice, its confidence and every option's probability." + NEEDS,
    inputSchema: {
      type: "object",
      properties: {
        instructions: { type: "string", description: "What to choose." },
        state: STATE,
        criteria: {
          type: "object",
          description: "The options: option name -> description of when to pick it.",
          additionalProperties: { type: "string" },
          minProperties: 1,
          maxProperties: MAX_OPTIONS,
        },
      },
      required: ["instructions", "state", "criteria"],
    },
  },
  score: {
    description: "Ask TypeSafe Jev to rate a text along ordered levels; returns the score (the expected level: 0 is the first, values between levels are fractional), its confidence, each level's probability and the legend."
      + NEEDS,
    inputSchema: {
      type: "object",
      properties: {
        instructions: { type: "string", description: "What to rate." },
        state: STATE,
        criteria: {
          type: "array",
          description: "The levels, lowest first; scores start at 0.",
          items: { type: "string" },
          minItems: MIN_LEVELS,
          maxItems: MAX_LEVELS,
        },
      },
      required: ["instructions", "state", "criteria"],
    },
  },
};

/**
 * Whether a value is a plain object (not an array, not null).
 *
 * @param v - The value to test.
 * @returns True for a plain object.
 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Whether a value is a string or undefined.
 *
 * @param v - The value to test.
 * @returns True for a string or undefined.
 */
function isOptionalString(v: unknown): v is string | undefined {
  return v === undefined || typeof v === "string";
}

/**
 * Parses JSON without throwing.
 *
 * @param text - The raw text.
 * @returns The parsed value, or undefined when the text is not JSON (valid JSON never parses to undefined).
 */
function json(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Builds a tool error: a `deny`, which the model reads as an error result (core drops a hook's own `isError`).
 *
 * @param type - The question type (the tool called), prefixed to the message.
 * @param reason - What went wrong.
 * @returns The error answer for the model.
 */
function fail(type: QuestionType, reason: string): ToolResult {
  return { deny: `${type}: ${reason}` };
}

/**
 * The message of a thrown value.
 *
 * @param err - What was thrown or rejected.
 * @returns Its message, or the value as text.
 */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Replaces a URL in an error text, as the URL parser spells it and as given, with a placeholder.
 *
 * @param text - The error text.
 * @param url - The URL to hide.
 * @param placeholder - What stands in its place.
 * @returns The text without the URL.
 */
function hide(text: string, url: string, placeholder: string): string {
  let href = url;
  try {
    href = new URL(url).href;
  } catch {
    // The engine quotes a URL it cannot parse as given.
  }
  return text.replaceAll(href, placeholder).replaceAll(url, placeholder);
}

/**
 * Whether a value is a string with content after trimming.
 *
 * @param v - The value to test.
 * @returns True for a non-blank string.
 */
function isText(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * Validates the model-supplied tool input and builds the System One question. Values pass through unchanged.
 *
 * @param type - The question type (the tool called).
 * @param e - The `tool.call` event carrying the input fields.
 * @returns The state and question, or the error message (no request is sent).
 */
function parseInput(type: QuestionType, e: ToolCall): { state: string; question: Question } | string {
  const { instructions, state, criteria } = e;
  if (!isText(instructions)) return "instructions must be a non-empty string";
  if (!isText(state)) return "state must be a non-empty string";
  if (type === "noul") {
    const msg = "criteria must be an object with optional string fields true and false";
    if (criteria === undefined) return { state, question: { type, instructions } };
    if (!isRecord(criteria)) return msg;
    const { true: yes, false: no, ...rest } = criteria;
    if (Object.keys(rest).length > 0 || !isOptionalString(yes) || !isOptionalString(no)) return msg;
    return { state, question: { type, instructions, criteria: { true: yes, false: no } } }; // JSON drops undefined fields
  }
  if (type === "choice") {
    const msg = `criteria must map 1 to ${MAX_OPTIONS} non-blank option names to string descriptions`;
    if (!isRecord(criteria)) return msg;
    const entries = Object.entries(criteria);
    const valid = entries.filter((p): p is [string, string] => p[0].trim() !== "" && typeof p[1] === "string");
    if (entries.length < 1 || entries.length > MAX_OPTIONS || valid.length !== entries.length) return msg;
    return { state, question: { type, instructions, criteria: Object.fromEntries(valid) } };
  }
  const msg = `criteria must be an array of ${MIN_LEVELS} to ${MAX_LEVELS} strings`;
  if (!Array.isArray(criteria) || criteria.length < MIN_LEVELS || criteria.length > MAX_LEVELS || !criteria.every((v): v is string => typeof v === "string")) return msg;
  return { state, question: { type, instructions, criteria } };
}

/**
 * Resolves the System One endpoint: JEV_URL, else TYPESAFE_BASE_URL plus `/v1/systemone`, else the default.
 *
 * @param jev - The trimmed JEV_URL value (full route), undefined when unset or blank.
 * @param base - The trimmed TYPESAFE_BASE_URL value (API root), undefined when unset or blank.
 * @returns The URL, or the error naming the invalid variable (an invalid set value never falls back).
 */
function endpoint(jev: string | undefined, base: string | undefined): { ok: true; url: string } | { ok: false; error: string } {
  if (jev) return HTTP_URL.test(jev) ? { ok: true, url: jev } : { ok: false, error: "JEV_URL must be an http(s) URL" };
  if (base) {
    return HTTP_BASE.test(base) ? { ok: true, url: base.replace(/\/+$/, "") + "/v1/systemone" } : { ok: false, error: "TYPESAFE_BASE_URL must be an http(s) URL without query or fragment" };
  }
  return { ok: true, url: DEFAULT_JEV_URL };
}

/**
 * Extracts the API's reason from an error body: its `detail`, else the `message` of its `error` object.
 *
 * @param text - The raw response body.
 * @returns The reason (a string as is, anything else JSON-stringified), or undefined when there is none.
 */
function detail(text: string): string | undefined {
  const body = json(text);
  if (!isRecord(body)) return undefined;
  const error = body["error"];
  const why = body["detail"] ?? (isRecord(error) ? error["message"] : undefined);
  if (why === undefined) return undefined;
  return typeof why === "string" ? why : JSON.stringify(why);
}

/**
 * Sends one System One question and maps every outcome to a tool result.
 *
 * @param $ - The engine.
 * @param state - The text the question is about.
 * @param question - The question; its type is the tool called.
 * @param env - The env values, trimmed, undefined when unset or blank.
 * @param signal - Aborts when the call is abandoned; the hook then answers at once.
 * @returns The answer object as JSON, or an error answer prefixed with the type.
 */
async function ask($: Engine, state: string, question: Question, env: Env, signal: AbortSignal): Promise<ToolResult> {
  const { type } = question;
  const target = endpoint(env.jevUrl, env.base);
  if (!target.ok) return fail(type, target.error);
  const { key } = env;
  const model = env.model ?? DEFAULT_MODEL;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // The key never travels in cleartext: over plain http the request goes out without it.
  if (key && /^https:/i.test(target.url)) headers["Authorization"] = `Bearer ${key}`;
  let timer: { cancel(): void } | undefined;
  try {
    const request = $.http.fetch(target.url, { method: "POST", headers, body: JSON.stringify({ model, state, questions: { [QUESTION_ID]: question } }) });
    request.catch(() => undefined); // a late rejection after the timeout or an abort won must not go unhandled
    // The engine does not stop a hook's request when its dispatch is abandoned: answer at once instead of lingering.
    const stop = new Promise<"timeout" | "aborted">((resolve) => {
      timer = $.clock.after(TIMEOUT_MS, () => resolve("timeout"));
      if (signal.aborted) resolve("aborted");
      else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    const res = await Promise.race([request, stop]);
    if (res === "timeout") return fail(type, `timeout after ${TIMEOUT_MS}ms`);
    if (res === "aborted") return fail(type, "the call was abandoned");
    if (!res.ok) {
      const why = detail(res.text);
      return fail(type, `HTTP ${res.status}${why === undefined ? "" : `: ${why}`}`);
    }
    const body = json(res.text);
    if (body === undefined) return fail(type, `HTTP ${res.status} response was not valid JSON`);
    const answers = isRecord(body) ? body["answers"] : undefined;
    const answer = isRecord(answers) ? answers[QUESTION_ID] : undefined;
    if (!isRecord(answer) || answer["type"] !== type) return fail(type, `response had no ${type} answer`);
    return { result: JSON.stringify(answer) };
  } catch (err) {
    // The engine's fetch errors quote the URL, whose host, path or query may be private: name the variable instead.
    const why = message(err);
    return fail(type, env.jevUrl ? hide(why, target.url, "<JEV_URL>") : env.base ? hide(why, target.url, "<TYPESAFE_BASE_URL>/v1/systemone") : why);
  } finally {
    timer?.cancel();
  }
}

/**
 * Registers the module's hooks.
 *
 * @param on - The engine's hook registrar.
 */
export function register(on: On): void {
  // Full tool name -> question type: the default names (a call can reach an instance that saw no session.start), plus what the engine returned.
  const names = new Map<string, QuestionType>(TYPES.map((t) => [TOOL_PREFIX + t, t]));
  on("session.start", async function onSessionStart($, e, next) {
    // One failing registration must not drop the others.
    const results = await Promise.allSettled(TYPES.map((type) => $.tool.register({ name: type, ...SPECS[type] })));
    for (const [i, r] of results.entries()) {
      const type = TYPES[i];
      // The engine starts a log line with the plugin's name; logging is best effort.
      if (r.status === "rejected") await Promise.resolve($.ui.log(`registering ${type} failed: ${message(r.reason)}`)).catch(() => undefined);
      else {
        // Only a mcp__<plugin>__<type> name: a hook above answering anything else must not make this hook claim another tool.
        const tool = r.value?.tool;
        if (tool?.startsWith("mcp__") && tool.endsWith(`__${type}`)) names.set(tool, type);
      }
    }
    return next(e);
  });
  on("tool.call", async function onToolCall($, e, next) {
    const type = names.get(e.tool);
    if (type === undefined) return next(e);
    // Answered on every path, a throw too (a hook above refusing $.env.get): a registered tool that no hook answers fails.
    try {
      // Literal names: the engine's static check only accepts a literal first argument to $.env.get.
      const [key, base, jevUrl, model] = (await Promise.all([$.env.get("TYPESAFE_API_KEY"), $.env.get("TYPESAFE_BASE_URL"), $.env.get("JEV_URL"), $.env.get("TYPESAFE_DEFAULT_MODEL")])).map((v) => v?.trim() || undefined);
      if (!key && !base && !jevUrl) return fail(type, "none of TYPESAFE_API_KEY, TYPESAFE_BASE_URL, JEV_URL is set");
      const input = parseInput(type, e);
      if (typeof input === "string") return fail(type, input);
      return await ask($, input.state, input.question, { key, base, jevUrl, model }, next.signal);
    } catch (err) {
      return fail(type, message(err));
    }
  });
}
