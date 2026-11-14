/**
 * The System One request: endpoint, error redaction, the HTTP call and the overflow reactions of one call (`ask`, `answerJev`).
 *
 * @packageDocumentation
 */

import { askHaiku, HAIKU_MAX_CHARS } from "./haiku.mjs";
import { contextRefusal, cutState, estimateTokens, isTooBig, learn, MAX_DENSITY, OPTIMISTIC_FACTOR, preflightError, refusedDensity, stateForBudget, timeBudgetTokens, tooBigError } from "./size.mjs";
import type { Knowledge, TooBig } from "./size.mjs";
import type { Engine, Env, Overflow, Question, ToolName, ToolResult } from "./types.mjs";
import { fail, hide, hideHost, isRecord, json, message, questionId, questionsBody } from "./util.mjs";

/** The System One endpoint used when neither JEV_URL nor TYPESAFE_BASE_URL is set. */
export const DEFAULT_JEV_URL = "https://api.typesafe.ai/v1/systemone";

/** The model sent when TYPESAFE_DEFAULT_MODEL is unset or blank. */
export const DEFAULT_MODEL = "jev-latest";

/** An http(s) URL: the `JEV_URL` check. */
export const HTTP_URL = /^https?:\/\/[^/?#\s]+(?:[/?#]\S*)?$/i;

/** An http(s) API root: like {@link HTTP_URL} but without query or fragment, since a path gets appended. */
export const HTTP_BASE = /^https?:\/\/[^/?#\s]+(?:\/[^?#\s]*)?$/i;

/** The most characters of an API error reason passed on to the model (a server may send megabytes; cut after the redaction, never before it). */
export const MAX_DETAIL = 1000;

/** The shortest API key that is replaced in error texts (a shorter one would match ordinary words). */
export const MIN_REDACT_KEY = 6;

/**
 * Resolves the System One endpoint: JEV_URL, else TYPESAFE_BASE_URL plus `/v1/systemone`, else the default.
 *
 * @param jev - The trimmed JEV_URL value (full route), undefined when unset or blank.
 * @param base - The trimmed TYPESAFE_BASE_URL value (API root), undefined when unset or blank.
 * @returns The URL, or the error naming the invalid variable (an invalid set value never falls back).
 */
export function endpoint(jev: string | undefined, base: string | undefined): { ok: true; url: string } | { ok: false; error: string } {
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
 * @param redact - Replaces what must not reach the model; applied to every string and object key of the reason before a non-string one is made into JSON text.
 * @param numbers - Whether a number can carry a secret (the key is made of number characters): only then is every number of the body redacted, which costs seconds on an error body of megabytes of numbers.
 * @returns The reason redacted (a string as is, anything else JSON-stringified), or undefined when there is none.
 */
export function detail(text: string, redact: (s: string) => string, numbers: boolean): string | undefined {
  // A number is matched on its source text: parsing rounds 20 digits to 17 and drops `.0` and `e0`, so a numeric key would no longer match.
  const body = json(text, numbers ? (_k, v, c) => (typeof v === "number" && c?.source !== undefined && redact(c.source) !== c.source ? c.source : v) : undefined);
  if (!isRecord(body)) return undefined;
  const error = body["error"];
  const why = body["detail"] ?? (isRecord(error) ? error["message"] : undefined);
  if (why === undefined) return undefined;
  // Redacted per string, number (a numeric key echoed as a JSON number) and object key before the JSON text is made: JSON escapes quotes and backslashes, a secret containing one would no longer match.
  /** The JSON.stringify replacer: redacts strings, numbers and object keys; other values pass. */
  const clean = (v: unknown): unknown => {
    if (typeof v === "string") return redact(v);
    if (typeof v === "number") return numbers && redact(String(v)) !== String(v) ? redact(String(v)) : v;
    return isRecord(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [redact(k), x])) : v;
  };
  return typeof why === "string" ? redact(why) : JSON.stringify(why, (_k, v: unknown) => clean(v));
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
    if (key && key.length >= MIN_REDACT_KEY) t = t.replaceAll(key, "<TYPESAFE_API_KEY>"); // not a short key: it would match ordinary words
    return env.jevUrl || env.base ? hideHost(t, target.url) : t;
  };
  let timer: { cancel(): void } | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const request = $.http.fetch(target.url, { method: "POST", headers, body: JSON.stringify({ model, state, questions: questionsObject }) });
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
      const refused = res.status === 400 ? contextRefusal(res.text) : undefined;
      if (refused) {
        // The refusal counts the prompt exactly: it teaches the density, and the caller reacts with the numbers.
        onSample(chars, refused.tokens);
        return { tooBig: { tokens: refused.tokens, limit: refused.nctx - 1, chars, questionsChars } };
      }
      // Only a key made of number characters can sit inside a JSON number's text.
      const why = detail(res.text, redact, key !== undefined && key.length >= MIN_REDACT_KEY && /^[-+.\deE]+$/.test(key));
      let text = why === undefined ? "" : why.trim(); // detail() already redacted it: a second pass would nest the host placeholder
      if (text.length > MAX_DETAIL) {
        text = text.slice(0, MAX_DETAIL);
        if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1); // not a lone high surrogate
        text += "…";
      }
      return fail(tool, `HTTP ${res.status}${text === "" ? "" : `: ${text}`}`);
    }
    const body = json(res.text);
    if (body === undefined) return fail(tool, `HTTP ${res.status} response was not valid JSON`);
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
  } catch (err) {
    // The engine's fetch errors quote the URL, whose host, path or query may be private: name the variable instead.
    return fail(tool, redact(message(err)));
  } finally {
    timer?.cancel();
    if (onAbort) signal.removeEventListener("abort", onAbort); // a signal shared by many calls must not collect listeners
  }
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
  const estimate = estimateTokens(input.state.length + questionsChars, Math.min(MAX_DENSITY, OPTIMISTIC_FACTOR * know.density));
  let refused: TooBig["tooBig"] | undefined;
  if (estimate <= budget) {
    const first = await send(input.state);
    if (!isTooBig(first)) return first;
    refused = first.tooBig;
    if (signal.aborted) return fail(tool, "the call was abandoned");
  }
  if (mode === "error") return refused ? tooBigError(tool, refused) : preflightError(tool, estimate, budget, limit, timeoutMs, stateForBudget(budget, know.density, questionsChars));
  if (mode === "haiku") return await askHaiku($, tool, cutState(input.state, HAIKU_MAX_CHARS), input.questions, timeoutMs, signal);
  // truncate: what the budget (the limit and the timeout) allows, at the learned density, or after a refusal at the exact density its count gave;
  // a cut sent without a refusal before it (the preflight said no) that is refused too gets one more cut at its exact density, so never more than two requests
  const cut = (r: TooBig["tooBig"] | undefined) => send(cutState(input.state, stateForBudget(r ? Math.min(budget, r.limit) : budget, r ? refusedDensity(r) : know.density, questionsChars)));
  let answer = await cut(refused);
  if (!refused && isTooBig(answer)) {
    if (signal.aborted) return fail(tool, "the call was abandoned");
    answer = await cut(answer.tooBig);
  }
  return isTooBig(answer) ? tooBigError(tool, answer.tooBig) : answer;
}
