import { MAX_TIMEOUT_S, fail, isRecord, json } from "./util.mjs";
export const DEFAULT_CONTEXT_TOKENS = 32768;
export const PROMPT_OVERHEAD_TOKENS = 26;
export const DEFAULT_DENSITY = 3;
export const MIN_DENSITY = 1;
export const MAX_DENSITY = 8;
export const DENSITY_ALPHA = .2;
export const MIN_SAMPLE_TOKENS = 400;
export const PERSIST_DELTA = .1;
export const DENSITY_KEY = "density";
export const STORE_WAIT_MS = 1e3;
export const CUT_MARGIN_TOKENS = 64;
export const CONTEXT_ERROR = "exceed_context_size_error";
export const OPTIMISTIC_FACTOR = 2;
export const LATENCY_LINEAR_MS = .7;
export const LATENCY_QUADRATIC_MS = 18e-6;
export const LATENCY_MARGIN = 1.3;
export const MIN_BUDGET_TOKENS = 1e3;
export const HEAD_SHARE = .6;
export function isTooBig(r) {
	return isRecord(r.tooBig);
}
export function loadKnowledge($, k) {
	k.loaded ??= (async () => {
		let timer;
		try {
			const read = Promise.resolve($.store.get(DENSITY_KEY));
			read.catch(() => undefined);
			const late = new Promise((resolve) => {
				timer = $.clock.after(STORE_WAIT_MS, () => resolve(undefined));
			});
			const stored = await Promise.race([read, late]);
			const v = isRecord(stored) ? stored["v"] : undefined;
			if (typeof v === "number" && Number.isFinite(v) && v >= MIN_DENSITY && v <= MAX_DENSITY && k.samples === 0) {
				k.density = v;
				k.persisted = v;
				const n = isRecord(stored) ? stored["n"] : undefined;
				k.samples = typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 0;
			}
		} catch {} finally {
			timer?.cancel();
		}
	})();
	return k.loaded;
}
export function learn($, k, chars, tokens) {
	if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < MIN_SAMPLE_TOKENS) return;
	const sample = chars / (tokens - PROMPT_OVERHEAD_TOKENS);
	if (!Number.isFinite(sample)) return;
	k.density = (1 - DENSITY_ALPHA) * k.density + DENSITY_ALPHA * Math.min(MAX_DENSITY, Math.max(MIN_DENSITY, sample));
	k.samples += 1;
	if (Math.abs(k.density - k.persisted) / k.persisted <= PERSIST_DELTA) return;
	k.persisted = k.density;
	try {
		void Promise.resolve($.store.set(DENSITY_KEY, {
			v: k.density,
			n: k.samples
		})).catch(() => undefined);
	} catch {}
}
export function timeBudgetTokens(timeoutMs) {
	const a = LATENCY_LINEAR_MS * LATENCY_MARGIN;
	const b = LATENCY_QUADRATIC_MS * LATENCY_MARGIN;
	return Math.max(MIN_BUDGET_TOKENS, Math.floor((-a + Math.sqrt(a * a + 4 * b * timeoutMs)) / (2 * b)));
}
export function estimateTokens(chars, density) {
	return Math.ceil(chars / density) + PROMPT_OVERHEAD_TOKENS;
}
export function cutState(state, keep) {
	if (state.length <= keep) return state;
	const headLength = Math.round(keep * HEAD_SHARE);
	const tailLength = keep - headLength;
	let head = state.slice(0, headLength);
	if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
	let tail = tailLength > 0 ? state.slice(-tailLength) : "";
	if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
	return `${head}\n[... ${state.length - head.length - tail.length} characters omitted ...]\n${tail}`;
}
export function stateForBudget(budget, density, questionsChars) {
	return Math.max(0, Math.floor((budget - PROMPT_OVERHEAD_TOKENS - CUT_MARGIN_TOKENS) * density) - questionsChars);
}
export function contextRefusal(text) {
	const body = json(text);
	const error = isRecord(body) ? body["error"] : undefined;
	if (!isRecord(error) || error["type"] !== CONTEXT_ERROR) return undefined;
	const tokens = error["n_prompt_tokens"];
	const nctx = error["n_ctx"];
	if (typeof tokens !== "number" || typeof nctx !== "number" || !Number.isInteger(tokens) || !Number.isInteger(nctx) || nctx < 2 || tokens < nctx) return undefined;
	return {
		tokens,
		nctx
	};
}
export function stateThatFits(refused, budget = refused.limit) {
	const prompt = Math.floor(refused.chars * (Math.min(budget, refused.limit) - PROMPT_OVERHEAD_TOKENS - CUT_MARGIN_TOKENS) / (refused.tokens - PROMPT_OVERHEAD_TOKENS));
	return Math.max(0, prompt - refused.questionsChars);
}
export function tooBigError(tool, refused) {
	const aim = Math.floor(stateThatFits(refused) / 100) * 100;
	return fail(tool, `state too large for System One: the request has ${refused.tokens} tokens, the limit is ${refused.limit}; shorten the state to about ${aim} characters`);
}
export function preflightError(tool, estimate, budget, limit, timeoutMs, aim) {
	const aimHundreds = Math.floor(aim / 100) * 100;
	if (budget >= limit) return fail(tool, `state too large for System One: at least ${estimate} tokens, the limit is ${limit}; shorten the state to about ${aimHundreds} characters`);
	return fail(tool, `state too large for the timeout of ${timeoutMs / 1e3} s: at least ${estimate} tokens, about ${budget} fit; shorten the state to about ${aimHundreds} characters or raise the timeout (at most ${MAX_TIMEOUT_S} s)`);
}
