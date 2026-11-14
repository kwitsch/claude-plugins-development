import { QUESTION_ID, fail, isRecord, json, message } from "./util.mjs";
export const HAIKU_MODEL = "claude-haiku-5-5";
export const HAIKU_SYSTEM = `You stand in for a text classifier. Answer every question about the given text and reply with JSON only (no prose, no code fence): {"answers":{"<id>":<answer>}} with one answer per question id.
An answer is, by question type:
- noul: {"type":"noul","noul":<probability 0..1 that the answer is yes>}
- choice: {"type":"choice","choice":"<exactly one option name>","confidence":<0..1>,"probabilities":{"<option>":<0..1>,...}} with every option listed
- score: {"type":"score","score":<number from 0 to levels-1, fractional between levels>,"confidence":<0..1>,"probabilities":{"0":<0..1>,"1":<0..1>,...}} with every level index listed
Calibration: be a calibrated estimator, not a cautious one. For noul use the whole range: 0.97 to 0.99 when the answer is clearly yes, 0.01 to 0.03 when it is clearly no, values in between only when the case is genuinely open. For choice and score spread the probabilities honestly over neighbouring options; a score is the probability-weighted mean of the level indexes, so it is rarely a whole number. For a score over ordered levels pick the lowest level that fully handles the case: most everyday cases sit in the lower half of the scale and the top two levels are rare, so when two neighbouring levels fit, give the lower one more weight.`;
export const NOUL_STRETCH = 2.5;
export const HAIKU_MAX_CHARS = 15e4;
export const HAIKU_MAX_TOKENS = 16384;
export function isUnit(v) {
	return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}
export function hasProbabilities(v, keys) {
	return isRecord(v) && keys.every((k) => isUnit(v[k]));
}
export function stretch(p) {
	const c = Math.min(Math.max(p, .001), .999);
	return 1 / (1 + Math.exp(-NOUL_STRETCH * Math.log(c / (1 - c))));
}
export function round4(v) {
	return Math.round(v * 1e4) / 1e4;
}
export function checkAnswer(q, a) {
	if (!isRecord(a) || a["type"] !== q.type) return undefined;
	if (q.type === "noul") return isUnit(a["noul"]) ? {
		type: "noul",
		noul: round4(stretch(a["noul"]))
	} : undefined;
	const { confidence, probabilities } = a;
	if (!isUnit(confidence)) return undefined;
	if (q.type === "choice") {
		const options = Object.keys(q.criteria);
		const picked = a["choice"];
		if (typeof picked !== "string" || !options.includes(picked) || !hasProbabilities(probabilities, options)) return undefined;
		const sum = options.reduce((t, o) => t + probabilities[o], 0);
		if (!(sum > 0)) return undefined;
		return {
			type: "choice",
			choice: picked,
			confidence,
			probabilities: Object.fromEntries(options.map((o) => [o, round4(probabilities[o] / sum)]))
		};
	}
	const levels = q.criteria.map((_, i) => String(i));
	if (!hasProbabilities(probabilities, levels)) return undefined;
	const total = levels.reduce((sum, l) => sum + probabilities[l], 0);
	if (!(total > 0)) return undefined;
	const normalized = levels.map((l) => probabilities[l] / total);
	const mean = normalized.reduce((sum, p, i) => sum + i * p, 0);
	return {
		type: "score",
		score: round4(mean),
		confidence,
		legend: Object.fromEntries(q.criteria.map((l, i) => [i, l])),
		probabilities: Object.fromEntries(levels.map((l, i) => [l, round4(normalized[i])]))
	};
}
export function haikuTokens(questions) {
	let n = 256;
	for (const q of questions) {
		n += 256;
		if (q.type === "choice") {
			for (const key of Object.keys(q.criteria)) n += Math.ceil(key.length / 3) + 12;
		} else if (q.type === "score") n += 16 * q.criteria.length;
	}
	return Math.min(HAIKU_MAX_TOKENS, n);
}
export async function askHaiku($, tool, state, questions, timeoutMs, signal) {
	const ids = questions.map((_, i) => tool === "batch" ? `q${i}` : QUESTION_ID);
	const prompt = `Text:\n${state}\n\nQuestions (JSON):\n${JSON.stringify(Object.fromEntries(ids.map((id, i) => [id, questions[i]])))}`;
	let onAbort;
	try {
		const reply = $.model.complete({
			model: HAIKU_MODEL,
			system: HAIKU_SYSTEM,
			prompt,
			maxTokens: haikuTokens(questions),
			timeoutMs
		}, { signal });
		reply.catch(() => undefined);
		const aborted = new Promise((resolve) => {
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
			return fail(tool, signal.aborted ? "the call was abandoned" : `fallback: timeout after ${timeoutMs}ms`);
		}
		const body = json(r.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, ""));
		const answers = isRecord(body) ? body["answers"] : undefined;
		const list = [];
		for (const [i, q] of questions.entries()) {
			const answer = checkAnswer(q, isRecord(answers) ? answers[ids[i]] : undefined);
			if (answer === undefined) return fail(tool, `fallback: Haiku's reply had no valid ${q.type} answer${tool === "batch" ? ` for questions[${i}]` : ""}`);
			list.push(answer);
		}
		return { result: JSON.stringify(tool === "batch" ? list : list[0]) };
	} catch (err) {
		return fail(tool, `fallback: ${message(err)}`);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}
