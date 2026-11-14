/**
 * Small shared helpers: type guards, JSON parsing, tool errors, text redaction and the request's question keys.
 *
 * @packageDocumentation
 */

import { OVERFLOWS, TYPES } from "./types.mjs";
import type { Overflow, Question, QuestionType, ToolName, ToolResult } from "./types.mjs";

/** How long one request may take, in seconds, when neither the call's `timeout` nor the `timeout` option is valid. */
export const DEFAULT_TIMEOUT_S = 20;

/**
 * The longest timeout in seconds; a longer one counts as this. The engine ends one `$.http.fetch` after 30 s itself,
 * and a delay past 2^31-1 ms would make the engine's setTimeout-based timer fire at once.
 */
export const MAX_TIMEOUT_S = 30;

/**
 * Whether a value is one of the overflow modes.
 *
 * @param v - The value to test.
 * @returns True for `error`, `truncate` or `haiku`.
 */
export function isOverflow(v: unknown): v is Overflow {
  return (OVERFLOWS as readonly unknown[]).includes(v);
}

/** The key of a single-question tool's question in `questions` and of its answer in `answers` (`batch` keys them `q0`, `q1`, ... by index). */
export const QUESTION_ID = "answer";

/**
 * Whether a value is a plain object (not an array, not null).
 *
 * @param v - The value to test.
 * @returns True for a plain object.
 */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Whether a value is a string or undefined.
 *
 * @param v - The value to test.
 * @returns True for a string or undefined.
 */
export function isOptionalString(v: unknown): v is string | undefined {
  return v === undefined || typeof v === "string";
}

/**
 * Parses JSON without throwing.
 *
 * @param text - The raw text.
 * @param reviver - Optional `JSON.parse` reviver; its third argument carries a primitive's source text where the engine supports it.
 * @returns The parsed value, or undefined when the text is not JSON (valid JSON never parses to undefined).
 */
export function json(text: string, reviver?: (key: string, value: unknown, context?: { source?: string }) => unknown): unknown {
  try {
    return JSON.parse(text, reviver) as unknown;
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
export function fail(tool: ToolName, reason: string): ToolResult {
  return { deny: `${tool}: ${reason}` };
}

/**
 * A timeout in seconds, if the value is one: a finite number above 0, capped at {@link MAX_TIMEOUT_S}.
 *
 * @param v - The value to test (a tool input field or an option).
 * @returns The seconds, or undefined for anything else.
 */
export function seconds(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(v, MAX_TIMEOUT_S) : undefined;
}

/**
 * Whether a value is one of the question types.
 *
 * @param v - The value to test.
 * @returns True for `noul`, `choice` or `score`.
 */
export function isType(v: unknown): v is QuestionType {
  return (TYPES as readonly unknown[]).includes(v);
}

/**
 * The message of a thrown value.
 *
 * @param err - What was thrown or rejected.
 * @returns Its message, or the value as text.
 */
export function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error"; // a null-prototype object, or one whose toString throws
  }
}

/**
 * Replaces a URL in an error text, as the URL parser spells it and as given, with a placeholder.
 *
 * @param text - The error text.
 * @param url - The URL to hide.
 * @param placeholder - What stands in its place.
 * @returns The text without the URL.
 */
export function hide(text: string, url: string, placeholder: string): string {
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
 * not turn `jev-latest` or `api.jev`, nor the host `10.0.0.5` turn `110.0.0.5`, into something else.
 *
 * @param text - The text.
 * @param url - The endpoint URL; one that does not parse changes nothing.
 * @returns The text with the host as `<host>`.
 */
export function hideHost(text: string, url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return text;
  }
  if (!host) return text;
  // An IPv6 host comes with brackets, an error text quotes the bare address.
  let t = text;
  for (const h of new Set([host, host.replace(/^\[(.*)\]$/, "$1")])) {
    t = t.replace(new RegExp(`(?<![\\w.-])${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "gi"), "<host>");
  }
  return t;
}

/**
 * Whether a value is a string with content after trimming.
 *
 * @param v - The value to test.
 * @returns True for a non-blank string.
 */
export function isText(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * The questions as the request body carries them: keyed `q0`, `q1`, ... for `batch`, by {@link QUESTION_ID} for a single tool.
 *
 * @param tool - The tool called.
 * @param questions - The questions, in input order.
 * @returns The `questions` object of the request body (the answers come back under the same keys).
 */
export function questionsBody(tool: ToolName, questions: Question[]): Record<string, Question> {
  return Object.fromEntries(questions.map((q, i) => [questionId(tool, i), q]));
}

/**
 * The key of question `i` in the request and of its answer in the response.
 *
 * @param tool - The tool called.
 * @param i - The question's index.
 * @returns `q<i>` for `batch`, {@link QUESTION_ID} otherwise.
 */
export function questionId(tool: ToolName, i: number): string {
  return tool === "batch" ? `q${i}` : QUESTION_ID;
}
