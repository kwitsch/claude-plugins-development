import { MAX_LEVELS, MAX_OPTIONS, MIN_LEVELS } from "./tools.mjs";
import { OVERFLOWS, TYPES } from "./types.mjs";
import { isOptionalString, isOverflow, isRecord, isText, isType } from "./util.mjs";
export function parseQuestion(type, instructions, criteria) {
	if (!isText(instructions)) return "instructions must be a non-empty string";
	if (type === "noul") {
		const msg = "criteria must be an object with optional string fields true and false";
		if (criteria === undefined) return {
			type,
			instructions
		};
		if (!isRecord(criteria)) return msg;
		const { true: yes, false: no, ...rest } = criteria;
		if (Object.keys(rest).length > 0 || !isOptionalString(yes) || !isOptionalString(no)) return msg;
		return {
			type,
			instructions,
			criteria: {
				true: yes,
				false: no
			}
		};
	}
	if (type === "choice") {
		const msg = `criteria must map 1 to ${MAX_OPTIONS} non-blank option names to string descriptions`;
		if (!isRecord(criteria)) return msg;
		const entries = Object.entries(criteria);
		const valid = entries.filter((p) => p[0].trim() !== "" && typeof p[1] === "string");
		if (entries.length < 1 || entries.length > MAX_OPTIONS || valid.length !== entries.length) return msg;
		return {
			type,
			instructions,
			criteria: Object.fromEntries(valid)
		};
	}
	const msg = `criteria must be an array of ${MIN_LEVELS} to ${MAX_LEVELS} strings`;
	if (!Array.isArray(criteria) || criteria.length < MIN_LEVELS || criteria.length > MAX_LEVELS || !criteria.every((v) => typeof v === "string")) return msg;
	return {
		type,
		instructions,
		criteria
	};
}
export function parseQuestions(tool, e) {
	const { instructions, state } = e;
	if (tool !== "batch" && !isText(instructions)) return "instructions must be a non-empty string";
	if (!isText(state)) return "state must be a non-empty string";
	if (tool !== "batch") {
		const question = parseQuestion(tool, instructions, e["criteria"]);
		return typeof question === "string" ? question : {
			state,
			questions: [question]
		};
	}
	const list = e["questions"];
	if (!Array.isArray(list) || list.length < 1) return "questions must be a non-empty array";
	const questions = [];
	for (const [i, q] of list.entries()) {
		if (!isRecord(q) || !isType(q["type"])) return `questions[${i}]: type must be one of ${TYPES.join(", ")}`;
		const question = parseQuestion(q["type"], q["instructions"], q["criteria"]);
		if (typeof question === "string") return `questions[${i}]: ${question}`;
		questions.push(question);
	}
	return {
		state,
		questions
	};
}
export function parseInput(tool, e) {
	const parsed = parseQuestions(tool, e);
	if (typeof parsed === "string") return parsed;
	const overflow = e["overflow"];
	if (overflow === undefined) return parsed;
	return isOverflow(overflow) ? {
		...parsed,
		overflow
	} : `overflow must be one of ${OVERFLOWS.join(", ")}`;
}
