/**
 * TypeSafe System One question and answer shapes, answer readers and the name of the jev-api tool jevfort needs. All
 * questions of one decision go to jev-api's `batch` tool in one call (one System One request). Pure: the call itself
 * (`askJev`) lives in `register.mts`, the only module that may use the engine API.
 *
 * @packageDocumentation
 */

/** The local budget of one `askJev` (its one batch call) before Claude Code's own behaviour wins, in ms. */
export const TIMEOUT_MS = 4000;

/** A question Jev answers about a `state`, in the shape of one entry of jev-api's `batch` input: a yes/no probability, a choice among options, or a score along levels. */
export type Question =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

/** A yes/no answer: the probability of `true`. */
export type NoulAnswer = { type: "noul"; noul: number };
/** A choice answer: the picked option with the probability of every option. */
export type ChoiceAnswer = { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number };
/** A score answer: a value along the levels with the probability of every level. */
export type ScoreAnswer = { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };
/** Any answer. */
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** What one `askJev` came back with, and how long it took. */
export type JevResult = { ok: true; answers: Record<string, Answer>; ms: number } | { ok: false; error: string; ms: number };

/** The HTTP timeout jevfort gives every jev-api call, in seconds (jev-api's `timeout` input). */
export const JEV_API_TIMEOUT_S = 5;
/** Prefix of the jev-api plugin's tools. */
export const JEV_TOOL_PREFIX = "mcp__jev-api__";
/** jev-api's tool for several questions about one `state` in one request; its result is the answers in question order. */
export const JEV_BATCH = JEV_TOOL_PREFIX + "batch";
/** The jev-api tools jevfort needs, by full name. */
export const JEV_TOOLS = [JEV_BATCH];

/**
 * The needed jev-api tools missing from a tool listing.
 *
 * @param names - Full names of the listed tools.
 * @returns The missing full names, empty when all are there.
 */
export function missingJevTools(names: readonly string[]): string[] {
  return JEV_TOOLS.filter((t) => !names.includes(t));
}

/**
 * The `noul` probability of answer `id`.
 *
 * @param answers - A request's answers.
 * @param id - The question id.
 * @returns The probability, or `undefined` when the answer is missing or of another type.
 */
export function noul(answers: Record<string, Answer>, id: string): number | undefined {
  const a = answers[id];
  return a?.type === "noul" ? a.noul : undefined;
}

/**
 * The choice answer `id`.
 *
 * @param answers - A request's answers.
 * @param id - The question id.
 * @returns The answer, or `undefined` when missing or of another type.
 */
export function choice(answers: Record<string, Answer>, id: string): ChoiceAnswer | undefined {
  const a = answers[id];
  return a?.type === "choice" ? a : undefined;
}

/**
 * The score answer `id`.
 *
 * @param answers - A request's answers.
 * @param id - The question id.
 * @returns The answer, or `undefined` when missing or of another type.
 */
export function score(answers: Record<string, Answer>, id: string): ScoreAnswer | undefined {
  const a = answers[id];
  return a?.type === "score" ? a : undefined;
}
