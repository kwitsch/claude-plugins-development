import { OVERFLOWS, TYPES } from "./types.mjs";
export const DEFAULT_TIMEOUT_S = 20;
export const MAX_TIMEOUT_S = 30;
export function isOverflow(v) {
	return OVERFLOWS.includes(v);
}
export const QUESTION_ID = "answer";
export function isRecord(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
export function isOptionalString(v) {
	return v === undefined || typeof v === "string";
}
export function json(text, reviver) {
	try {
		return JSON.parse(text, reviver);
	} catch {
		return undefined;
	}
}
export function fail(tool, reason) {
	return { deny: `${tool}: ${reason}` };
}
export function seconds(v) {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(v, MAX_TIMEOUT_S) : undefined;
}
export function isType(v) {
	return TYPES.includes(v);
}
export function message(err) {
	if (err instanceof Error) return err.message;
	try {
		return String(err);
	} catch {
		return "unknown error";
	}
}
export function hide(text, url, placeholder) {
	let href = url;
	try {
		href = new URL(url).href;
	} catch {}
	return text.replaceAll(href, placeholder).replaceAll(url, placeholder);
}
export function hideHost(text, url) {
	let host = "";
	try {
		host = new URL(url).hostname;
	} catch {
		return text;
	}
	if (!host) return text;
	let t = text;
	for (const h of new Set([host, host.replace(/^\[(.*)\]$/, "$1")])) {
		t = t.replace(new RegExp(`(?<![\\w.-])${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "gi"), "<host>");
	}
	return t;
}
export function isText(v) {
	return typeof v === "string" && v.trim() !== "";
}
export function questionsBody(tool, questions) {
	return Object.fromEntries(questions.map((q, i) => [questionId(tool, i), q]));
}
export function questionId(tool, i) {
	return tool === "batch" ? `q${i}` : QUESTION_ID;
}
