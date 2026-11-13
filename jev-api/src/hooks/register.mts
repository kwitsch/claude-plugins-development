/**
 * Claude Code function-hooks module of jev-api: registers the TypeSafe Jev System One question types `noul`,
 * `choice` and `score` as tools, plus `batch` for several questions about one text, and answers each call with one
 * System One request.
 *
 * @remarks
 * EARLY ACCESS API. No engine type import (the engine typings are not in the repo): the used `$` members and
 * events are typed structurally below. `development/scripts/build-plugin.mts` keeps `hooks/*.mjs` unmangled and
 * uncompressed, since the engine's static check wants `$`/`on` spelled as such and no `$.<noun>` passed as a bare
 * value; every hook is a named function literal. No imports: HTTP goes through `$.http.fetch`.
 *
 * @packageDocumentation
 */

/** The System One question types, which are also the names of the single-question tools. */
const TYPES = ["noul", "choice", "score"] as const;

/** One of {@link TYPES}. */
type QuestionType = (typeof TYPES)[number];

/** Every tool name: the question types plus `batch`, which asks several questions in one request. */
const TOOLS = [...TYPES, "batch"] as const;

/** One of {@link TOOLS}. */
type ToolName = (typeof TOOLS)[number];

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
  /** Model requests: the stand-in for Jev when no System One access is configured. */
  model: {
    /** Asks a model one question; resolves the reply, or `isAnswered: false` with the reason. */
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

/** The plugin's `userConfig` values as the engine passes them to `register`; any value may be missing or invalid. */
type Options = Partial<Record<string, unknown>>;

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

/** Description tail shared by the tools. */
const NEEDS = " Set TYPESAFE_API_KEY, TYPESAFE_BASE_URL or JEV_URL to use Jev; without any of them Claude Haiku answers instead.";

/** The model that stands in for Jev when none of the System One variables is set. */
const HAIKU_MODEL = "claude-haiku-5-5";

/** What Haiku is told: the System One answer format it has to reproduce. */
const HAIKU_SYSTEM = `You stand in for a text classifier. Answer every question about the given text and reply with JSON only (no prose, no code fence): {"answers":{"<id>":<answer>}} with one answer per question id.
An answer is, by question type:
- noul: {"type":"noul","noul":<probability 0..1 that the answer is yes>}
- choice: {"type":"choice","choice":"<exactly one option name>","confidence":<0..1>,"probabilities":{"<option>":<0..1>,...}} with every option listed
- score: {"type":"score","score":<number from 0 to levels-1, fractional between levels>,"confidence":<0..1>,"probabilities":{"0":<0..1>,"1":<0..1>,...}} with every level index listed
Calibration: be a calibrated estimator, not a cautious one. For noul use the whole range: 0.97 to 0.99 when the answer is clearly yes, 0.01 to 0.03 when it is clearly no, values in between only when the case is genuinely open. For choice and score spread the probabilities honestly over neighbouring options; a score is the probability-weighted mean of the level indexes, so it is rarely a whole number. For a score over ordered levels pick the lowest level that fully handles the case: most everyday cases sit in the lower half of the scale and the top two levels are rare, so when two neighbouring levels fit, give the lower one more weight.`;

/**
 * How far Haiku's `noul` probability is pushed away from 0.5 (the logit is multiplied by this). Measured 2026-11-13
 * on 120 effort prompts: Haiku says 0.8 to 0.93 where Jev says 0.95 or more, so with 2.5 the "purely mechanical"
 * share of low prompts goes from 7 to 17 of 24 (Jev: 22) and no medium prompt crosses 0.95.
 */
const NOUL_STRETCH = 2.5;

/** The `state` input property shared by the tools. */
const STATE = { type: "string", description: "The text the question is about." };

/** How long one request may take, in seconds, when neither the call's `timeout` nor the `timeout` option is valid. */
const DEFAULT_TIMEOUT_S = 20;

/**
 * The longest timeout in seconds; a longer one counts as this. The engine ends one `$.http.fetch` after 30 s itself,
 * and a delay past 2^31-1 ms would make the engine's setTimeout-based timer fire at once.
 */
const MAX_TIMEOUT_S = 30;

/** The optional `timeout` input property shared by the tools. */
const TIMEOUT = { type: "number", exclusiveMinimum: 0, description: `Optional: the HTTP timeout of the request in seconds, at most ${MAX_TIMEOUT_S}. Default: the plugin's timeout option, else ${DEFAULT_TIMEOUT_S}.` };

/** The System One endpoint used when neither JEV_URL nor TYPESAFE_BASE_URL is set. */
const DEFAULT_JEV_URL = "https://api.typesafe.ai/v1/systemone";

/** The model sent when TYPESAFE_DEFAULT_MODEL is unset or blank. */
const DEFAULT_MODEL = "jev-latest";

/** The key of a single-question tool's question in `questions` and of its answer in `answers` (`batch` keys them `q0`, `q1`, ... by index). */
const QUESTION_ID = "answer";

/** An http(s) URL: the `JEV_URL` check. */
const HTTP_URL = /^https?:\/\/[^/?#\s]+(?:[/?#]\S*)?$/i;

/** An http(s) API root: like {@link HTTP_URL} but without query or fragment, since a path gets appended. */
const HTTP_BASE = /^https?:\/\/[^/?#\s]+(?:\/[^?#\s]*)?$/i;

/** The most options a `choice` question may have. */
const MAX_OPTIONS = 255;

/** The fewest levels a `score` question may have (the API refuses one). */
const MIN_LEVELS = 2;

/** The most levels a `score` question may have. */
const MAX_LEVELS = 10;

/** The most output tokens a Haiku fallback call may ask for. */
const HAIKU_MAX_TOKENS = 16_384;

/** How long a hook waits for the tools to register before it goes on (ms): a registration that never answers must not hold a call. */
const REGISTER_WAIT_MS = 1000;

/** The engine names a registered tool `mcp__<plugin>__<name>`. */
const TOOL_PREFIX = "mcp__jev-api__";

/** The tool registrations without their name, keyed by tool name. */
const SPECS: Record<ToolName, Omit<ToolSpec, "name">> = {
  noul: {
    description: "Ask TypeSafe Jev a yes/no question about a text; returns the probability (0..1) that the answer is true." + NEEDS,
    inputSchema: {
      type: "object",
      properties: {
        instructions: { type: "string", description: "The yes/no question to answer about the text." },
        state: STATE,
        timeout: TIMEOUT,
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
        timeout: TIMEOUT,
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
        timeout: TIMEOUT,
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
  batch: {
    description: "Ask TypeSafe Jev several noul, choice and score questions about one text in a single request; returns a JSON array of the answers in question order, each as the noul, choice or score tool returns it. One invalid or unanswered question fails the whole call."
      + NEEDS,
    inputSchema: {
      type: "object",
      properties: {
        state: STATE,
        timeout: TIMEOUT,
        questions: {
          type: "array",
          description: "The questions, each with the input of the noul, choice or score tool minus state, plus its type.",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: [...TYPES], description: "The question type." },
              instructions: { type: "string", description: "The question." },
              criteria: { description: `noul: optional { true, false } strings; choice: 1 to ${MAX_OPTIONS} option names -> descriptions; score: ${MIN_LEVELS} to ${MAX_LEVELS} levels, lowest first.` },
            },
            required: ["type", "instructions"],
          },
        },
      },
      required: ["state", "questions"],
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
 * @param tool - The tool called, prefixed to the message.
 * @param reason - What went wrong.
 * @returns The error answer for the model.
 */
function fail(tool: ToolName, reason: string): ToolResult {
  return { deny: `${tool}: ${reason}` };
}

/**
 * A timeout in seconds, if the value is one: a finite number above 0, capped at {@link MAX_TIMEOUT_S}.
 *
 * @param v - The value to test (a tool input field or an option).
 * @returns The seconds, or undefined for anything else.
 */
function seconds(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(v, MAX_TIMEOUT_S) : undefined;
}

/**
 * Whether a value is one of the question types.
 *
 * @param v - The value to test.
 * @returns True for `noul`, `choice` or `score`.
 */
function isType(v: unknown): v is QuestionType {
  return (TYPES as readonly unknown[]).includes(v);
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
 * Replaces the bare host of a URL in an error text. A DNS failure quotes only the host (`getaddrinfo ENOTFOUND <host>`,
 * live on 2.1.325), which may be private too. Only whole host names are replaced, ignoring case: the host `jev` must
 * not turn `jev-latest` or `110.0.0.5` into something else.
 *
 * @param text - The text.
 * @param url - The endpoint URL; one that does not parse changes nothing.
 * @returns The text with the host as `<host>`.
 */
function hideHost(text: string, url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return text;
  }
  if (!host) return text;
  return text.replace(new RegExp(`(?<![\\w.-])${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "gi"), "<host>");
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
 * Validates one question's fields and builds the System One question. Values pass through unchanged.
 *
 * @param type - The question type.
 * @param instructions - The question text.
 * @param criteria - The type's criteria, as given.
 * @returns The question, or the error message (no request is sent).
 */
function parseQuestion(type: QuestionType, instructions: unknown, criteria: unknown): Question | string {
  if (!isText(instructions)) return "instructions must be a non-empty string";
  if (type === "noul") {
    const msg = "criteria must be an object with optional string fields true and false";
    if (criteria === undefined) return { type, instructions };
    if (!isRecord(criteria)) return msg;
    const { true: yes, false: no, ...rest } = criteria;
    if (Object.keys(rest).length > 0 || !isOptionalString(yes) || !isOptionalString(no)) return msg;
    return { type, instructions, criteria: { true: yes, false: no } }; // JSON drops undefined fields
  }
  if (type === "choice") {
    const msg = `criteria must map 1 to ${MAX_OPTIONS} non-blank option names to string descriptions`;
    if (!isRecord(criteria)) return msg;
    const entries = Object.entries(criteria);
    const valid = entries.filter((p): p is [string, string] => p[0].trim() !== "" && typeof p[1] === "string");
    if (entries.length < 1 || entries.length > MAX_OPTIONS || valid.length !== entries.length) return msg;
    return { type, instructions, criteria: Object.fromEntries(valid) };
  }
  const msg = `criteria must be an array of ${MIN_LEVELS} to ${MAX_LEVELS} strings`;
  if (!Array.isArray(criteria) || criteria.length < MIN_LEVELS || criteria.length > MAX_LEVELS || !criteria.every((v): v is string => typeof v === "string")) return msg;
  return { type, instructions, criteria };
}

/**
 * Validates the model-supplied tool input and builds the System One questions: one for a question-type tool, the
 * `questions` array for `batch`.
 *
 * @param tool - The tool called.
 * @param e - The `tool.call` event carrying the input fields.
 * @returns The state and questions, or the error message (no request is sent).
 */
function parseInput(tool: ToolName, e: ToolCall): { state: string; questions: Question[] } | string {
  const { instructions, state } = e;
  // A question-type tool checks instructions, then state, then criteria.
  if (tool !== "batch" && !isText(instructions)) return "instructions must be a non-empty string";
  if (!isText(state)) return "state must be a non-empty string";
  if (tool !== "batch") {
    const question = parseQuestion(tool, instructions, e["criteria"]);
    return typeof question === "string" ? question : { state, questions: [question] };
  }
  const list = e["questions"];
  if (!Array.isArray(list) || list.length < 1) return "questions must be a non-empty array";
  const questions: Question[] = [];
  for (const [i, q] of list.entries()) {
    if (!isRecord(q) || !isType(q["type"])) return `questions[${i}]: type must be one of ${TYPES.join(", ")}`;
    const question = parseQuestion(q["type"], q["instructions"], q["criteria"]);
    if (typeof question === "string") return `questions[${i}]: ${question}`;
    questions.push(question);
  }
  return { state, questions };
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
 * Whether a value is a probability: a finite number from 0 to 1.
 *
 * @param v - The value to test.
 * @returns True for a number in 0..1.
 */
function isUnit(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

/**
 * Whether a value maps every key to a probability.
 *
 * @param v - The value to test.
 * @param keys - The keys it must have.
 * @returns True when each key is present with a probability.
 */
function hasProbabilities(v: unknown, keys: string[]): v is Record<string, number> {
  return isRecord(v) && keys.every((k) => isUnit(v[k]));
}

/**
 * Pushes a probability away from 0.5 in logit space by {@link NOUL_STRETCH}: Haiku's verbal probabilities are
 * timid next to Jev's.
 *
 * @param p - A probability from 0 to 1; clamped to 0.001..0.999 so the logit stays finite.
 * @returns The stretched probability; 0.5 stays 0.5.
 */
function stretch(p: number): number {
  const c = Math.min(Math.max(p, 0.001), 0.999);
  return 1 / (1 + Math.exp(-NOUL_STRETCH * Math.log(c / (1 - c))));
}

/**
 * Rounds to four decimals (the answers are model estimates; more digits mean nothing).
 *
 * @param v - The number.
 * @returns The rounded number.
 */
function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * Checks one answer Haiku gave against the System One answer format and rebuilds it without extra fields, calibrated
 * toward Jev: a `noul` is stretched ({@link stretch}) and a score is the mean level index of the probabilities.
 *
 * @param q - The question.
 * @param a - The answer as parsed from Haiku's reply.
 * @returns The answer as System One would give it, or undefined when it does not fit the question.
 */
function checkAnswer(q: Question, a: unknown): Record<string, unknown> | undefined {
  if (!isRecord(a) || a["type"] !== q.type) return undefined;
  if (q.type === "noul") return isUnit(a["noul"]) ? { type: "noul", noul: round4(stretch(a["noul"])) } : undefined;
  const { confidence, probabilities } = a;
  if (!isUnit(confidence)) return undefined;
  if (q.type === "choice") {
    const options = Object.keys(q.criteria);
    const picked = a["choice"];
    if (typeof picked !== "string" || !options.includes(picked) || !hasProbabilities(probabilities, options)) return undefined;
    // Like System One (and like score below) the probabilities sum to 1: jevfort compares probabilities[choice] with a threshold.
    const sum = options.reduce((t, o) => t + probabilities[o], 0);
    if (!(sum > 0)) return undefined;
    return { type: "choice", choice: picked, confidence, probabilities: Object.fromEntries(options.map((o) => [o, round4(probabilities[o] / sum)])) };
  }
  const levels = q.criteria.map((_, i) => String(i));
  if (!hasProbabilities(probabilities, levels)) return undefined;
  const total = levels.reduce((sum, l) => sum + probabilities[l], 0);
  if (!(total > 0)) return undefined;
  // Like Jev, the score is the mean level index of the (normalized) probabilities; Haiku's own `score` field is ignored
  // (it is rounded toward whole levels and inflated: measured 2026-11-13).
  const normalized = levels.map((l) => probabilities[l] / total);
  const mean = normalized.reduce((sum, p, i) => sum + i * p, 0);
  return { type: "score", score: round4(mean), confidence, legend: Object.fromEntries(q.criteria.map((l, i) => [i, l])), probabilities: Object.fromEntries(levels.map((l, i) => [l, round4(normalized[i])])) };
}

/**
 * The output budget of one Haiku call: a base per question plus the tokens of every option or level the answer lists
 * with its probability (a `choice` with 255 options needs thousands of tokens), capped.
 *
 * @param questions - The questions of the call.
 * @returns The `maxTokens` to ask for.
 */
function haikuTokens(questions: Question[]): number {
  let n = 256;
  for (const q of questions) {
    n += 256;
    if (q.type === "choice") { for (const key of Object.keys(q.criteria)) n += Math.ceil(key.length / 3) + 12; }
    else if (q.type === "score") n += 16 * q.criteria.length;
  }
  return Math.min(HAIKU_MAX_TOKENS, n);
}

/**
 * Answers the questions of one tool call with Claude Haiku instead of System One (no Jev access configured). The
 * reply must be JSON in the System One response format; anything else is an error, never a made-up answer.
 *
 * @param $ - The engine.
 * @param tool - The tool called.
 * @param state - The text the questions are about.
 * @param questions - The questions, in input order.
 * @param timeoutMs - How long Haiku may take.
 * @param signal - Aborts when the call is abandoned.
 * @returns The answers as {@link ask} returns them, or an error answer.
 */
async function askHaiku($: Engine, tool: ToolName, state: string, questions: Question[], timeoutMs: number, signal: AbortSignal): Promise<ToolResult> {
  const ids = questions.map((_, i) => (tool === "batch" ? `q${i}` : QUESTION_ID));
  const prompt = `Text:\n${state}\n\nQuestions (JSON):\n${JSON.stringify(Object.fromEntries(ids.map((id, i) => [id, questions[i]])))}`;
  let onAbort: (() => void) | undefined;
  try {
    const reply = $.model.complete({ model: HAIKU_MODEL, system: HAIKU_SYSTEM, prompt, maxTokens: haikuTokens(questions), timeoutMs }, { signal });
    reply.catch(() => undefined); // a late rejection after an abort must not go unhandled
    const aborted = new Promise<"aborted">((resolve) => {
      if (signal.aborted) resolve("aborted");
      else {
        onAbort = () => resolve("aborted");
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    const r = await Promise.race([reply, aborted]);
    if (r === "aborted") return fail(tool, "the call was abandoned");
    if (!r.isAnswered) return fail(tool, `fallback: ${r.reason}`);
    const body = json(r.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, ""));
    const answers = isRecord(body) ? body["answers"] : undefined;
    const list: Record<string, unknown>[] = [];
    for (const [i, q] of questions.entries()) {
      const answer = checkAnswer(q, isRecord(answers) ? answers[ids[i]] : undefined);
      if (answer === undefined) return fail(tool, `fallback: Haiku's reply had no valid ${q.type} answer${tool === "batch" ? ` for questions[${i}]` : ""}`);
      list.push(answer);
    }
    return { result: JSON.stringify(tool === "batch" ? list : list[0]) };
  } catch (err) {
    return fail(tool, `fallback: ${message(err)}`);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort); // a signal shared by many calls must not collect listeners
  }
}

/**
 * Sends the questions of one tool call in one System One request and maps every outcome to a tool result.
 *
 * @param $ - The engine.
 * @param tool - The tool called: a question type with its one question, or `batch`.
 * @param state - The text the questions are about.
 * @param questions - The questions, in input order.
 * @param env - The env values, trimmed, undefined when unset or blank.
 * @param timeoutMs - How long the request may take before the tool reports a timeout.
 * @param signal - Aborts when the call is abandoned; the hook then answers at once.
 * @returns The answer object as JSON (for `batch` the array of answers in question order), or an error answer
 * prefixed with the tool name.
 */
async function ask($: Engine, tool: ToolName, state: string, questions: Question[], env: Env, timeoutMs: number, signal: AbortSignal): Promise<ToolResult> {
  // The id of each question in the request and of its answer in the response.
  const ids = questions.map((_, i) => (tool === "batch" ? `q${i}` : QUESTION_ID));
  const target = endpoint(env.jevUrl, env.base);
  if (!target.ok) return fail(tool, target.error);
  const { key } = env;
  const model = env.model ?? DEFAULT_MODEL;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // The key never travels in cleartext: over plain http the request goes out without it.
  if (key && /^https:/i.test(target.url)) headers["Authorization"] = `Bearer ${key}`;
  // Text that reaches the model (a fetch error, an error body a server may echo the request into) must not carry the endpoint
  // or the key: a runtime quotes a header value it rejects (a newline or a non-Latin1 character in the key), whole.
  const redact = (text: string): string => {
    // In this order: the URL first (it may contain the key), the key before the host (a key may contain the host text).
    let t = env.jevUrl ? hide(text, target.url, "<JEV_URL>") : env.base ? hide(text, target.url, "<TYPESAFE_BASE_URL>/v1/systemone") : text;
    if (key && key.length >= 6) t = t.replaceAll(key, "<TYPESAFE_API_KEY>"); // not a short key: it would match ordinary words
    return env.jevUrl || env.base ? hideHost(t, target.url) : t;
  };
  let timer: { cancel(): void } | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const request = $.http.fetch(target.url, { method: "POST", headers, body: JSON.stringify({ model, state, questions: Object.fromEntries(ids.map((id, i) => [id, questions[i]])) }) });
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
    if (res === "timeout") return fail(tool, `timeout after ${timeoutMs}ms`);
    if (res === "aborted") return fail(tool, "the call was abandoned");
    if (!res.ok) {
      const why = detail(res.text);
      return fail(tool, `HTTP ${res.status}${why === undefined ? "" : `: ${redact(why)}`}`);
    }
    const body = json(res.text);
    if (body === undefined) return fail(tool, `HTTP ${res.status} response was not valid JSON`);
    const answers = isRecord(body) ? body["answers"] : undefined;
    const list: Record<string, unknown>[] = [];
    for (const [i, q] of questions.entries()) {
      const answer = isRecord(answers) ? answers[ids[i]] : undefined;
      if (!isRecord(answer) || answer["type"] !== q.type) return fail(tool, `response had no ${q.type} answer${tool === "batch" ? ` for questions[${i}]` : ""}`);
      list.push(answer);
    }
    return { result: JSON.stringify(tool === "batch" ? list : list[0]) };
  } catch (err) {
    // The engine's fetch errors quote the URL, whose host, path or query may be private: name the variable instead.
    return fail(tool, redact(message(err)));
  } finally {
    timer?.cancel();
    if (onAbort) signal.removeEventListener("abort", onAbort); // a signal shared by many calls must not collect listeners
  }
}

/** The registration state of one module instance: what is registered, under way, refused and hanging. */
type RegState = {
  /** Full tool name -> tool: the default names plus what the engine returned. */
  names: Map<string, ToolName>;
  /** The tools not registered yet. */
  missing: Set<ToolName>;
  /** The tools whose registration is under way. */
  pending: Map<ToolName, Promise<void>>;
  /** When a failed tool may be tried again (ms since epoch). */
  retryAt: Map<ToolName, number>;
  /** Failed attempts per tool. */
  failures: Map<ToolName, number>;
  /** Tools whose registration did not answer within a hook's wait: later hooks do not wait for them again. */
  stuck: Set<ToolName>;
};

/** The longest a failed registration waits for its next try (ms); the first retry is immediate. */
const MAX_RETRY_MS = 300_000;

/**
 * Registers one tool and records the full name the engine gave it; never rejects.
 *
 * @param $ - The engine.
 * @param st - The registration state.
 * @param type - The tool to register.
 */
async function registerOne($: Engine, st: RegState, type: ToolName): Promise<void> {
  try {
    const r = await $.tool.register({ name: type, ...SPECS[type] });
    // Only a mcp__<plugin>__<type> name: a hook above answering anything else must not make this hook claim another tool.
    const tool = r?.tool;
    if (tool?.startsWith("mcp__") && tool.endsWith(`__${type}`)) st.names.set(tool, type);
    st.missing.delete(type);
    st.failures.delete(type);
    st.stuck.delete(type);
  } catch (err) {
    const n = (st.failures.get(type) ?? 0) + 1;
    st.failures.set(type, n);
    // The first retry is immediate (the next hook), then 5 s, 10 s, ... up to MAX_RETRY_MS: a tool the engine keeps refusing must not cost every call.
    st.retryAt.set(type, Date.now() + (n === 1 ? 0 : Math.min(MAX_RETRY_MS, 5000 * 2 ** (n - 2))));
    // The engine starts a log line with the plugin's name; logging is best effort, and once per tool.
    if (n === 1) {
      try {
        await $.ui.log(`registering ${type} failed: ${message(err)}`);
      } catch {
        // best effort: this function never rejects
      }
    }
  }
}

/**
 * Starts the registration of every missing tool that is not under way and not waiting for a retry, then waits for the
 * ones that did not hang before, at most `ms`. A registration that never answers is waited for once: the tool is marked
 * stuck, and the other tools and later hooks do not wait for it again.
 *
 * @param $ - The engine.
 * @param st - The registration state.
 * @param ms - The longest wait.
 */
async function ensureTools($: Engine, st: RegState, ms: number): Promise<void> {
  const now = Date.now();
  for (const type of TOOLS) {
    if (!st.missing.has(type) || st.pending.has(type) || (st.retryAt.get(type) ?? 0) > now) continue;
    const p = registerOne($, st, type);
    st.pending.set(type, p);
    void p.then(() => st.pending.delete(type));
  }
  const waiting = [...st.pending].filter(([type]) => !st.stuck.has(type));
  if (waiting.length === 0) return;
  let timer: { cancel(): void } | undefined;
  try {
    const late = await Promise.race([
      Promise.all(waiting.map(([, p]) => p)).then(() => false),
      new Promise<boolean>((resolve) => {
        timer = $.clock.after(ms, () => resolve(true));
      }),
    ]);
    if (late) { for (const [type] of waiting) if (st.pending.has(type)) st.stuck.add(type); }
  } finally {
    timer?.cancel();
  }
}

/**
 * Registers the module's hooks.
 *
 * @param on - The engine's hook registrar.
 * @param options - The plugin's `userConfig` values; `timeout` is the request timeout in seconds for calls that give
 * none.
 */
export function register(on: On, options?: Options): void {
  // A call's own `timeout` wins; an invalid one falls back like a missing one.
  const fallbackS = seconds(options?.["timeout"]) ?? DEFAULT_TIMEOUT_S;
  // Full tool name -> tool: the default names (a call can reach an instance that saw no session.start), plus what the engine returned.
  const names = new Map<string, ToolName>(TOOLS.map((t) => [TOOL_PREFIX + t, t]));
  // `$` reaches a module only inside its hooks, so the tools register in the first hook that runs (session.start, or an earlier tool call).
  // The engine accepts `$` only as an argument to a top-level function, hence `ensureTools` and the state object.
  // A tool whose registration failed stays in `missing`: the next hook tries it again (after a growing delay), no timers.
  const st: RegState = { names, missing: new Set<ToolName>(TOOLS), pending: new Map(), retryAt: new Map(), failures: new Map(), stuck: new Set() };
  on("session.start", async function onSessionStart($, e, next) {
    if (st.missing.size > 0) await ensureTools($, st, 5 * REGISTER_WAIT_MS);
    return next(e);
  });
  on("tool.call", async function onToolCall($, e, next) {
    const type = names.get(e.tool);
    if (type === undefined) return next(e);
    // Answered on every path, a throw too (a hook above refusing $.env.get): a registered tool that no hook answers fails.
    try {
      // best effort and bounded: a failed or hanging registration must not hold the answer
      if (st.missing.size > 0) await ensureTools($, st, REGISTER_WAIT_MS);
      // Validation needs no env: an invalid call answers before any env read.
      const input = parseInput(type, e);
      if (typeof input === "string") return fail(type, input);
      // Literal names: the engine's static check only accepts a literal first argument to $.env.get.
      const [key, base, jevUrl, model] = (await Promise.all([$.env.get("TYPESAFE_API_KEY"), $.env.get("TYPESAFE_BASE_URL"), $.env.get("JEV_URL"), $.env.get("TYPESAFE_DEFAULT_MODEL")])).map((v) => v?.trim() || undefined);
      // F05: an abandoned call sends nothing
      if (next.signal.aborted) return fail(type, "the call was abandoned");
      // No Jev access configured: Haiku stands in. A configured Jev that fails stays an error.
      // A whole number of milliseconds, at least 1: $.model.complete refuses anything else (2.01 s * 1000 is 2009.9999999999998).
      const timeoutMs = Math.max(1, Math.round((seconds(e["timeout"]) ?? fallbackS) * 1000));
      if (!key && !base && !jevUrl) return await askHaiku($, type, input.state, input.questions, timeoutMs, next.signal);
      return await ask($, type, input.state, input.questions, { key, base, jevUrl, model }, timeoutMs, next.signal);
    } catch (err) {
      return fail(type, message(err));
    }
  });
}
