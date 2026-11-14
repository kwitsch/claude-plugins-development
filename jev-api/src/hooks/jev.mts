/**
 * The System One call: the answer handling of one request (`ask`) and the overflow reactions of one call (`answerJev`).
 * The request itself is the shared HTTP core's `sendRequest`, sent through the transport of `transport.mts`.
 *
 * @packageDocumentation
 */

import { sendRequest } from "../shared/http.mjs";
import { askHaiku, HAIKU_MAX_CHARS } from "./haiku.mjs";
import { cutState, DEFAULT_DENSITY, estimateTokens, isTooBig, learn, MAX_DENSITY, OPTIMISTIC_FACTOR, preflightError, refusedDensity, stateForBudget, timeBudgetTokens, tooBigError } from "./size.mjs";
import type { Knowledge, TooBig } from "./size.mjs";
import { fetchViaEngine } from "./transport.mjs";
import type { Engine, Env, Overflow, Question, ToolName, ToolResult } from "./types.mjs";
import { fail, isRecord, json, questionId, questionsBody } from "./util.mjs";

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
 * @param questionsChars - The characters of the questions as the request body carries them (`JSON.stringify` of {@link questionsBody}): with the state they are the prompt.
 * @param onSample - Told the characters of the prompt and the tokens the server counted for it (an answer's
 * `usage.input_tokens`, or a context refusal's `n_prompt_tokens`), whatever the outcome of the call.
 * @returns The answer object as JSON (for `batch` the array of answers in question order), an error answer
 * prefixed with the tool name, or the server's refusal of a prompt over its context window ({@link TooBig}).
 */
export async function ask($: Engine, tool: ToolName, state: string, questions: Question[], env: Env, timeoutMs: number, signal: AbortSignal, questionsChars: number, onSample: (chars: number, tokens: unknown) => void): Promise<ToolResult | TooBig> {
  // The id of each question in the request and of its answer in the response.
  const ids = questions.map((_, i) => questionId(tool, i));
  const questionsObject = questionsBody(tool, questions);
  // The prompt the server tokenizes is the state plus the questions: both count for the density and the limit.
  const chars = state.length + questionsChars;
  const outcome = await sendRequest(env, state, questionsObject, fetchViaEngine($, timeoutMs, signal));
  if (outcome.kind === "error") return fail(tool, outcome.message);
  if (outcome.kind === "http") {
    if (outcome.refusal) {
      // The refusal counts the prompt exactly: it teaches the density, and the caller reacts with the numbers.
      onSample(chars, outcome.refusal.tokens);
      return { tooBig: { tokens: outcome.refusal.tokens, limit: outcome.refusal.nctx - 1, chars, questionsChars } };
    }
    return fail(tool, `HTTP ${outcome.status}${outcome.reason === undefined ? "" : `: ${outcome.reason}`}`);
  }
  const body = json(outcome.text);
  if (body === undefined) return fail(tool, `HTTP ${outcome.status} response was not valid JSON`);
  const usage = isRecord(body) ? body["usage"] : undefined;
  if (isRecord(usage)) onSample(chars, usage["input_tokens"]);
  const answers = isRecord(body) ? body["answers"] : undefined;
  const list: Record<string, unknown>[] = [];
  for (const [i, q] of questions.entries()) {
    const answer = isRecord(answers) ? answers[ids[i]] : undefined;
    if (!isRecord(answer) || answer["type"] !== q.type) return fail(tool, `response had no ${q.type} answer${tool === "batch" ? ` for questions[${i}]` : ""}`);
    list.push(answer);
  }
  return { result: JSON.stringify(tool === "batch" ? list : list[0]) };
}

/**
 * Answers one call through System One, reacting to a prompt that cannot work: before sending (the optimistic estimate
 * does not fit the budget the limit and the timeout give) or after the server's refusal (its exact count).
 *
 * @param $ - The engine.
 * @param tool - The tool called.
 * @param input - The validated state and questions.
 * @param mode - What to do with a prompt that does not fit: refuse with the numbers, cut the state (one retry after a refusal), or ask Haiku.
 * @param env - The env values, trimmed.
 * @param timeoutMs - The request timeout.
 * @param signal - Aborts when the call is abandoned.
 * @param know - What the module learned about the size limits; updated.
 * @returns The tool result.
 */
export async function answerJev($: Engine, tool: ToolName, input: { state: string; questions: Question[] }, mode: Overflow, env: Env, timeoutMs: number, signal: AbortSignal, know: Knowledge): Promise<ToolResult> {
  const questionsChars = JSON.stringify(questionsBody(tool, input.questions)).length;
  // A refusal also tells the server's context window: remembered for the rest of the instance.
  const send = async (state: string) => {
    const answer = await ask($, tool, state, input.questions, env, timeoutMs, signal, questionsChars, (chars, tokens) => learn($, know, chars, tokens));
    if (isTooBig(answer)) know.nctx = answer.tooBig.limit + 1;
    return answer;
  };
  const limit = know.nctx - 1;
  const budget = Math.min(limit, timeBudgetTokens(timeoutMs));
  // Only what does not fit even at an optimistic density is refused before sending: a wrong refusal costs a valid call, a late one a fast 400.
  // The learned density is a mix over earlier states (hex, emoji), so it never makes this test stricter than the default's; it only sizes cuts.
  const estimate = estimateTokens(input.state.length + questionsChars, Math.min(MAX_DENSITY, OPTIMISTIC_FACTOR * Math.max(DEFAULT_DENSITY, know.density)));
  let refused: TooBig["tooBig"] | undefined;
  if (estimate <= budget) {
    const first = await send(input.state);
    if (!isTooBig(first)) return first;
    refused = first.tooBig;
    if (signal.aborted) return fail(tool, "the call was abandoned");
  }
  if (mode === "error") return refused ? tooBigError(tool, refused, budget) : preflightError(tool, estimate, budget, limit, timeoutMs, stateForBudget(budget, know.density, questionsChars));
  if (mode === "haiku") return await askHaiku($, tool, cutState(input.state, HAIKU_MAX_CHARS), input.questions, timeoutMs, signal);
  // truncate: what the budget (the limit and the timeout) allows, at the learned density, or after a refusal at the exact density its count gave;
  // a cut sent without a refusal before it (the preflight said no) that is refused too gets one more cut at its exact density, so never more than two requests
  const cut = (r: TooBig["tooBig"] | undefined) => send(cutState(input.state, stateForBudget(r ? Math.min(budget, r.limit) : budget, r ? refusedDensity(r) : know.density, questionsChars)));
  let answer = await cut(refused);
  if (!refused && isTooBig(answer)) {
    if (signal.aborted) return fail(tool, "the call was abandoned");
    answer = await cut(answer.tooBig);
  }
  return isTooBig(answer) ? tooBigError(tool, answer.tooBig, budget) : answer;
}
