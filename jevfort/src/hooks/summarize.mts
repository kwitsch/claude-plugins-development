/**
 * Whole-turn bypass: once Jev has taken the one action a simple request needs, a small model reports the result
 * instead of the main Claude model. Pure: the model call (`summarizeResult`) lives in `register.mts`.
 *
 * @packageDocumentation
 */

/** The small model that reports the result. */
export const SUMMARY_MODEL = "claude-haiku-5-5";

/** The system prompt of the summary request. */
export const SYSTEM = [
  "You report the result of one action (a command run or a file read) to a developer, inside Claude Code.",
  "Answer the developer's request using only the action's output. Lead with the outcome (for tests: how many passed or failed, and which failed).",
  "Be brief: one to four sentences or a short list, in Markdown. Do not suggest next steps unless something failed. Never invent details that are not in the output.",
].join(" ");

/** Token usage of a model request, as the engine reports it. */
export type ModelUsage = {
  /** Prompt tokens. */
  input_tokens: number;
  /** Reply tokens. */
  output_tokens: number;
  /** Prompt tokens written to the cache. */
  cache_creation_input_tokens?: number;
  /** Prompt tokens read from the cache. */
  cache_read_input_tokens?: number;
};

/** The summary, or why there is none. */
export type Summary = { ok: true; text: string; usage: ModelUsage } | { ok: false; reason: string };
