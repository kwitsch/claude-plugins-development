/**
 * TypeSafe System One API shapes and answer readers. One request carries every question about one state. Pure: the
 * request itself (`askJev`) lives in `register.mts`, the only module that may use the engine API.
 *
 * @packageDocumentation
 */

/** The TypeSafe System One endpoint, used when JEV_URL is unset or blank. */
export const DEFAULT_JEV_URL = "https://api.typesafe.ai/v1/systemone";
/** The Jev model named in every request. */
export const MODEL = "jev-latest";
/** How long one Jev request may take before Claude Code's own behaviour wins, in ms. */
export const TIMEOUT_MS = 4000;

/** A question Jev answers about the request's `state`: a yes/no probability, a choice among options, or a score along levels. */
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

/** What one Jev request came back with, and how long it took. */
export type JevResult = { ok: true; answers: Record<string, Answer>; ms: number } | { ok: false; error: string; ms: number };

/**
 * The Jev endpoint: JEV_URL when set (trimmed, non-empty), else the TypeSafe API. Accepts `http:` and `https:` for
 * any host; any other scheme, a missing host or whitespace inside the URL is an error.
 *
 * @param raw - The raw `JEV_URL` value, `undefined` when unset.
 * @returns The URL to call, or the error to log.
 */
export function jevUrl(raw: string | undefined): { ok: true; url: string } | { ok: false; error: string } {
  const value = raw?.trim();
  if (!value) return { ok: true, url: DEFAULT_JEV_URL };
  if (!/^https?:\/\/[^/?#\s]+(?:[/?#]\S*)?$/i.test(value)) return { ok: false, error: "JEV_URL must be an http(s) URL" };
  return { ok: true, url: value };
}

/** Prefix of the jev-api plugin's tools; the question type completes the name. */
export const JEV_TOOL_PREFIX = "mcp__jev-api__";
/** The jev-api tools jevfort needs, by full name. */
export const JEV_TOOLS = ["noul", "choice", "score"].map((t) => JEV_TOOL_PREFIX + t);

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
