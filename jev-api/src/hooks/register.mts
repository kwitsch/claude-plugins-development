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
  /** Environment variables. */
  env: {
    /** Reads a variable; undefined when unset. */
    get(name: string): Promise<string | undefined>;
  };
  /** Tool registry. */
  tool: {
    /** Registers a tool; resolves the full tool name the engine gave it. */
    register(spec: ToolSpec): Promise<{ tool?: string }>;
  };
};

/**
 * The rest of the hook chain for an event.
 *
 * @typeParam E - The event's input.
 * @typeParam R - What the chain resolves.
 */
type Next<E, R> = (e: E) => Promise<R>;

/**
 * A hook: the engine, the event, the rest of the chain.
 *
 * @typeParam E - The event's input.
 * @typeParam R - What the hook resolves.
 */
type Hook<E, R> = ($: Engine, e: E, next: Next<E, R>) => Promise<R>;

/** A `tool.call` event: the full tool name plus the tool input fields. */
type ToolCall = { tool: string } & Record<string, unknown>;

/** What a `tool.call` hook resolves: the tool result for the model. */
type ToolResult = { result?: unknown; isError?: boolean } & Record<string, unknown>;

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

/** The engine names a registered tool `mcp__<plugin>__<name>`. */
const TOOL_PREFIX = "mcp__jev-api__";

/** The three tool registrations, keyed by question type. */
const SPECS: Record<QuestionType, ToolSpec> = {
  noul: {
    name: "noul",
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
    name: "choice",
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
          maxProperties: 255,
        },
      },
      required: ["instructions", "state", "criteria"],
    },
  },
  score: {
    name: "score",
    description: "Ask TypeSafe Jev to rate a text along ordered levels; returns the score (level index from 0), confidence, probabilities and legend." + NEEDS,
    inputSchema: {
      type: "object",
      properties: {
        instructions: { type: "string", description: "What to rate." },
        state: STATE,
        criteria: {
          type: "array",
          description: "The levels, lowest first; scores start at 0.",
          items: { type: "string" },
          minItems: 1,
          maxItems: 10,
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
    if (Object.keys(rest).length > 0) return msg;
    const picked: { true?: string; false?: string } = {};
    if (typeof yes === "string") picked.true = yes;
    else if (yes !== undefined) return msg;
    if (typeof no === "string") picked.false = no;
    else if (no !== undefined) return msg;
    return { state, question: { type, instructions, criteria: picked } };
  }
  if (type === "choice") {
    const msg = "criteria must map 1 to 255 option names to string descriptions";
    if (!isRecord(criteria)) return msg;
    const entries = Object.entries(criteria);
    const options: Record<string, string> = {};
    for (const [name, description] of entries) if (typeof description === "string") options[name] = description;
    if (entries.length < 1 || entries.length > 255 || Object.keys(options).length !== entries.length) return msg;
    return { state, question: { type, instructions, criteria: options } };
  }
  const msg = "criteria must be an array of 1 to 10 strings";
  if (!Array.isArray(criteria)) return msg;
  const levels = criteria.filter((v): v is string => typeof v === "string");
  if (levels.length !== criteria.length || levels.length < 1 || levels.length > 10) return msg;
  return { state, question: { type, instructions, criteria: levels } };
}

/**
 * Registers the module's hooks.
 *
 * @param on - The engine's hook registrar.
 */
export function register(on: On): void {
  on("session.start", async function onSessionStart($, e, next) {
    for (const type of TYPES) {
      try {
        await $.tool.register(SPECS[type]);
      } catch {
        // One failing registration must not drop the others; there is no log channel.
      }
    }
    return next(e);
  });
  on("tool.call", async function onToolCall($, e, next) {
    const type = TYPES.find((t) => e.tool === TOOL_PREFIX + t);
    if (type === undefined) return next(e);
    // Literal names: the engine's static check only accepts a literal first argument to $.env.get.
    const configured = [await $.env.get("TYPESAFE_API_KEY"), await $.env.get("TYPESAFE_BASE_URL"), await $.env.get("JEV_URL")];
    if (!configured.some(isText)) return { isError: true, result: `${type}: none of TYPESAFE_API_KEY, TYPESAFE_BASE_URL, JEV_URL is set` };
    const input = parseInput(type, e);
    if (typeof input === "string") return { isError: true, result: `${type}: ${input}` };
    // Transitional: Task 4 replaces this line with the System One request.
    return { isError: true, result: `${type}: not implemented` };
  });
}
