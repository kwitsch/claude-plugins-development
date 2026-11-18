// Shared test kit of jev-api: the kit bound to the built plugin/hooks/register.mjs, and the default `request` call with
// one valid question per type. Tests import only register.mjs through this module.
import { createKit } from "claude-engine-vitest";

export const { test, mock } = createKit({ module: new URL("../../plugin/hooks/register.mjs", import.meta.url), plugin: "jev-api" });

/** The test's `$` (the kit does not export its type). */
export type Runner = Parameters<Parameters<typeof test>[2]>[0];

/**
 * The full name the engine gives a tool of jev-api.
 *
 * @param type - The bare tool name.
 * @returns `mcp__jev-api__<type>`.
 */
export const TOOL = (type: string) => `mcp__jev-api__${type}`;

/** The state every default call asks about. */
export const STATE = "Hello there!";

/** One valid question per type, as the request carries it. */
export const QUESTION: Record<string, Record<string, unknown>> = {
  noul: { type: "noul", instructions: "Is this text a greeting?", criteria: { true: "a greeting", false: "anything else" } },
  choice: { type: "choice", instructions: "What is this text?", criteria: { greeting: "says hello", question: "asks something" } },
  score: { type: "score", instructions: "Rate the sentiment", criteria: ["negative", "neutral", "positive"] },
};

/**
 * The `request` call that asks one question of a type.
 *
 * @param type - The question type.
 * @param over - `instructions` and `criteria` replace the question's (also when `undefined`); every other field is the call's (`state`, `timeout`, `overflow`, or a whole `questions` array).
 * @returns The `tool.call` input.
 */
export const one = (type: string, over: Record<string, unknown> = {}) => {
  const { instructions, criteria, ...input } = over;
  const question = { ...QUESTION[type], ...("instructions" in over ? { instructions } : {}), ...("criteria" in over ? { criteria } : {}) };
  return { tool: TOOL("request"), state: STATE, questions: [question], ...input };
};

/**
 * Calls `request` with one question; an HTTP error status is taken over by Haiku, and most tests have no Haiku, so its
 * failure text is cut off to compare the HTTP error alone.
 *
 * @param $ - The test's `$`.
 * @param type - The question type.
 * @param input - Overrides, as {@link one} takes them.
 * @returns The tool result.
 */
export const call = async ($: Runner, type: string, input: Record<string, unknown> = {}) => {
  const r = (await $.tool.call(one(type, input))) as { result?: string; deny?: string };
  return r.deny === undefined ? r : { ...r, deny: r.deny.replace(/; fallback: [\s\S]*$/, "") };
};
