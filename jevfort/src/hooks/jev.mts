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

/** The most options jev-api accepts in one `choice` question. */
export const MAX_CHOICE_OPTIONS = 255;
/** The HTTP timeout jevfort gives an interactive jev-api call, in seconds (jev-api's `timeout` input): the {@link TIMEOUT_MS} budget, so the request ends with it and not a second after. */
export const JEV_API_TIMEOUT_S = 4;
/**
 * The `askJev` budget of a compaction ranking in milliseconds. System One answers a batch question by question
 * (about 140 ms each, 30 compaction-sized questions took 4.1 to 5.1 s), and a compaction is off the interactive path. Kept below the engine's 10 s limit per hook (not the 15 s Haiku budget, which applies whenever Haiku answers: an in-flight `$` call stops that clock, live on 2.1.325).
 */
export const COMPACT_TIMEOUT_MS = 9000;
/** jev-api's `timeout` input in seconds for a compaction ranking: {@link COMPACT_TIMEOUT_MS}. */
export const COMPACT_API_TIMEOUT_S = 9;
/** The `askJev` budget in milliseconds while jev-api has no Jev access configured and Haiku answers (a model call, slower than System One). */
export const HAIKU_TIMEOUT_MS = 15_000;
/** jev-api's `timeout` input in seconds in that case: just under {@link HAIKU_TIMEOUT_MS}. */
export const HAIKU_API_TIMEOUT_S = 14;
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
 * Whether a number is finite.
 *
 * @param v - Any value.
 * @returns True for a finite number.
 */
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Whether a batch answer has the asked type and the fields jevfort reads from it.
 *
 * @param a - One entry of jev-api's answer array.
 * @param type - The asked question type.
 * @returns True when the answer can be used without further checks.
 */
export function isAnswer(a: unknown, type: Question["type"]): a is Answer {
  if (typeof a !== "object" || a === null || (a as { type?: unknown }).type !== type) return false;
  const r = a as Record<string, unknown>;
  if (type === "noul") return finite(r["noul"]);
  const p = r["probabilities"];
  if (!finite(r["confidence"]) || typeof p !== "object" || p === null || !Object.values(p).every(finite)) return false;
  return type === "choice" ? typeof r["choice"] === "string" : finite(r["score"]);
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
