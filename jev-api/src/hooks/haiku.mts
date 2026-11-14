/**
 * The Haiku stand-in for System One: prompt, answer checking and calibration toward Jev.
 *
 * @packageDocumentation
 */

import type { Engine, Question, ToolName, ToolResult } from "./types.mjs";
import { QUESTION_ID, fail, isRecord, json, message } from "./util.mjs";

/** The model that stands in for Jev when none of the System One variables is set. */
export const HAIKU_MODEL = "claude-haiku-5-5";

/** What Haiku is told: the System One answer format it has to reproduce. */
export const HAIKU_SYSTEM = `You stand in for a text classifier. Answer every question about the given text and reply with JSON only (no prose, no code fence): {"answers":{"<id>":<answer>}} with one answer per question id.
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
export const NOUL_STRETCH = 2.5;

/** The most characters of a state handed to Haiku: its window (200k tokens) at the worst one token per UTF-16 unit. */
export const HAIKU_MAX_CHARS = 150_000;

/** The most output tokens a Haiku fallback call may ask for. */
export const HAIKU_MAX_TOKENS = 16_384;

/**
 * Whether a value is a probability: a finite number from 0 to 1.
 *
 * @param v - The value to test.
 * @returns True for a number in 0..1.
 */
export function isUnit(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

/**
 * Whether a value maps every key to a probability.
 *
 * @param v - The value to test.
 * @param keys - The keys it must have.
 * @returns True when each key is present with a probability.
 */
export function hasProbabilities(v: unknown, keys: string[]): v is Record<string, number> {
  return isRecord(v) && keys.every((k) => isUnit(v[k]));
}

/**
 * Pushes a probability away from 0.5 in logit space by {@link NOUL_STRETCH}: Haiku's verbal probabilities are
 * timid next to Jev's.
 *
 * @param p - A probability from 0 to 1; clamped to 0.001..0.999 so the logit stays finite.
 * @returns The stretched probability; 0.5 stays 0.5.
 */
export function stretch(p: number): number {
  const c = Math.min(Math.max(p, 0.001), 0.999);
  return 1 / (1 + Math.exp(-NOUL_STRETCH * Math.log(c / (1 - c))));
}

/**
 * Rounds to four decimals (the answers are model estimates; more digits mean nothing).
 *
 * @param v - The number.
 * @returns The rounded number.
 */
export function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * Checks one answer Haiku gave against the System One answer format and rebuilds it without extra fields, calibrated
 * toward Jev: a `noul` is stretched ({@link stretch}), a score is the mean level index of the probabilities, and the
 * probabilities of a `choice` and of a score are normalized to sum 1 (an all-zero set is rejected).
 *
 * @param q - The question.
 * @param a - The answer as parsed from Haiku's reply.
 * @returns The answer as System One would give it, or undefined when it does not fit the question.
 */
export function checkAnswer(q: Question, a: unknown): Record<string, unknown> | undefined {
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
export function haikuTokens(questions: Question[]): number {
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
export async function askHaiku($: Engine, tool: ToolName, state: string, questions: Question[], timeoutMs: number, signal: AbortSignal): Promise<ToolResult> {
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
    if (!r.isAnswered) {
      if (r.reason !== "aborted") return fail(tool, `fallback: ${r.reason}`);
      // `aborted` is also how the engine reports its own timeout; the signal tells the two apart (whichever abort path won the race)
      return fail(tool, signal.aborted ? "the call was abandoned" : `fallback: timeout after ${timeoutMs}ms`);
    }
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
