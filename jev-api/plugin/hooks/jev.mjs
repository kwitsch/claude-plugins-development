import { HAIKU_MAX_CHARS, askHaiku } from "./haiku.mjs";
import { MAX_DENSITY, OPTIMISTIC_FACTOR, contextRefusal, cutState, estimateTokens, isTooBig, learn, preflightError, stateForBudget, stateThatFits, timeBudgetTokens, tooBigError } from "./size.mjs";
import { fail, hide, hideHost, isRecord, json, message, questionId, questionsBody } from "./util.mjs";
export const DEFAULT_JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_MODEL = "jev-latest";
export const HTTP_URL = /^https?:\/\/[^/?#\s]+(?:[/?#]\S*)?$/i;
export const HTTP_BASE = /^https?:\/\/[^/?#\s]+(?:\/[^?#\s]*)?$/i;
export const MAX_DETAIL = 1e3;
export const MIN_REDACT_KEY = 6;
export function endpoint(jev, base) {
	if (jev) return HTTP_URL.test(jev) ? {
		ok: true,
		url: jev
	} : {
		ok: false,
		error: "JEV_URL must be an http(s) URL"
	};
	if (base) {
		return HTTP_BASE.test(base) ? {
			ok: true,
			url: base.replace(/\/+$/, "") + "/v1/systemone"
		} : {
			ok: false,
			error: "TYPESAFE_BASE_URL must be an http(s) URL without query or fragment"
		};
	}
	return {
		ok: true,
		url: DEFAULT_JEV_URL
	};
}
export function detail(text, redact, numbers) {
	const body = json(text, numbers ? (_k, v, c) => typeof v === "number" && c?.source !== undefined && redact(c.source) !== c.source ? c.source : v : undefined);
	if (!isRecord(body)) return undefined;
	const error = body["error"];
	const why = body["detail"] ?? (isRecord(error) ? error["message"] : undefined);
	if (why === undefined) return undefined;
	const clean = (v) => {
		if (typeof v === "string") return redact(v);
		if (typeof v === "number") return numbers && redact(String(v)) !== String(v) ? redact(String(v)) : v;
		return isRecord(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [redact(k), x])) : v;
	};
	return typeof why === "string" ? redact(why) : JSON.stringify(why, (_k, v) => clean(v));
}
export async function ask($, tool, state, questions, env, timeoutMs, signal, onSample) {
	const ids = questions.map((_, i) => questionId(tool, i));
	const questionsObject = questionsBody(tool, questions);
	const questionsChars = JSON.stringify(questionsObject).length;
	const chars = state.length + questionsChars;
	const target = endpoint(env.jevUrl, env.base);
	if (!target.ok) return fail(tool, target.error);
	const { key } = env;
	const model = env.model ?? DEFAULT_MODEL;
	const headers = { "Content-Type": "application/json" };
	if (key && /^https:/i.test(target.url)) headers["Authorization"] = `Bearer ${key}`;
	const redact = (text) => {
		let t = env.jevUrl ? hide(text, target.url, "<JEV_URL>") : env.base ? hide(text, target.url, "<TYPESAFE_BASE_URL>/v1/systemone") : text;
		if (key && key.length >= MIN_REDACT_KEY) t = t.replaceAll(key, "<TYPESAFE_API_KEY>");
		return env.jevUrl || env.base ? hideHost(t, target.url) : t;
	};
	let timer;
	let onAbort;
	try {
		const request = $.http.fetch(target.url, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model,
				state,
				questions: questionsObject
			})
		});
		request.catch(() => undefined);
		const stop = new Promise((resolve) => {
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
				onSample(chars, refused.tokens);
				return { tooBig: {
					tokens: refused.tokens,
					limit: refused.nctx - 1,
					chars,
					questionsChars
				} };
			}
			const why = detail(res.text, redact, key !== undefined && key.length >= MIN_REDACT_KEY && /^[-+.\deE]+$/.test(key));
			let text = why === undefined ? "" : why.trim();
			if (text.length > MAX_DETAIL) {
				text = text.slice(0, MAX_DETAIL);
				if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
				text += "…";
			}
			return fail(tool, `HTTP ${res.status}${text === "" ? "" : `: ${text}`}`);
		}
		const body = json(res.text);
		if (body === undefined) return fail(tool, `HTTP ${res.status} response was not valid JSON`);
		const usage = isRecord(body) ? body["usage"] : undefined;
		if (isRecord(usage)) onSample(chars, usage["input_tokens"]);
		const answers = isRecord(body) ? body["answers"] : undefined;
		const list = [];
		for (const [i, q] of questions.entries()) {
			const answer = isRecord(answers) ? answers[ids[i]] : undefined;
			if (!isRecord(answer) || answer["type"] !== q.type) return fail(tool, `response had no ${q.type} answer${tool === "batch" ? ` for questions[${i}]` : ""}`);
			list.push(answer);
		}
		return { result: JSON.stringify(tool === "batch" ? list : list[0]) };
	} catch (err) {
		return fail(tool, redact(message(err)));
	} finally {
		timer?.cancel();
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}
export async function answerJev($, tool, input, mode, env, timeoutMs, signal, know) {
	const send = (state) => ask($, tool, state, input.questions, env, timeoutMs, signal, (chars, tokens) => learn($, know, chars, tokens));
	const questionsChars = JSON.stringify(questionsBody(tool, input.questions)).length;
	const limit = know.nctx - 1;
	const budget = Math.min(limit, timeBudgetTokens(timeoutMs));
	const estimate = estimateTokens(input.state.length + questionsChars, Math.min(MAX_DENSITY, OPTIMISTIC_FACTOR * know.density));
	let refused;
	if (estimate <= budget) {
		const first = await send(input.state);
		if (!isTooBig(first)) return first;
		know.nctx = first.tooBig.limit + 1;
		refused = first.tooBig;
		if (signal.aborted) return fail(tool, "the call was abandoned");
	}
	if (mode === "error") return refused ? tooBigError(tool, refused) : preflightError(tool, estimate, budget, limit, timeoutMs, stateForBudget(budget, know.density, questionsChars));
	if (mode === "haiku") return await askHaiku($, tool, cutState(input.state, HAIKU_MAX_CHARS), input.questions, timeoutMs, signal);
	const second = await send(cutState(input.state, refused ? stateThatFits(refused, budget) : stateForBudget(budget, know.density, questionsChars)));
	if (!isTooBig(second)) return second;
	know.nctx = second.tooBig.limit + 1;
	return tooBigError(tool, second.tooBig);
}
