const TYPES = [
	"noul",
	"choice",
	"score"
];
const NEEDS = " Needs TYPESAFE_API_KEY, TYPESAFE_BASE_URL or JEV_URL to be set.";
const STATE = {
	type: "string",
	description: "The text the question is about."
};
const DEFAULT_JEV_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";
const TIMEOUT_MS = 3e4;
const QUESTION_ID = "answer";
const HTTP_URL = /^https?:\/\/[^/?#\s]+(?:[/?#]\S*)?$/i;
const TOOL_PREFIX = "mcp__jev-api__";
const SPECS = {
	noul: {
		name: "noul",
		description: "Ask TypeSafe Jev a yes/no question about a text; returns the probability (0..1) that the answer is true." + NEEDS,
		inputSchema: {
			type: "object",
			properties: {
				instructions: {
					type: "string",
					description: "The yes/no question to answer about the text."
				},
				state: STATE,
				criteria: {
					type: "object",
					description: "Optional: what counts as true and what counts as false.",
					properties: {
						true: {
							type: "string",
							description: "What counts as true."
						},
						false: {
							type: "string",
							description: "What counts as false."
						}
					},
					additionalProperties: false
				}
			},
			required: ["instructions", "state"]
		}
	},
	choice: {
		name: "choice",
		description: "Ask TypeSafe Jev to pick one of named options for a text; returns the choice, its confidence and every option's probability." + NEEDS,
		inputSchema: {
			type: "object",
			properties: {
				instructions: {
					type: "string",
					description: "What to choose."
				},
				state: STATE,
				criteria: {
					type: "object",
					description: "The options: option name -> description of when to pick it.",
					additionalProperties: { type: "string" },
					minProperties: 1,
					maxProperties: 255
				}
			},
			required: [
				"instructions",
				"state",
				"criteria"
			]
		}
	},
	score: {
		name: "score",
		description: "Ask TypeSafe Jev to rate a text along ordered levels; returns the score (level index from 0), confidence, probabilities and legend." + NEEDS,
		inputSchema: {
			type: "object",
			properties: {
				instructions: {
					type: "string",
					description: "What to rate."
				},
				state: STATE,
				criteria: {
					type: "array",
					description: "The levels, lowest first; scores start at 0.",
					items: { type: "string" },
					minItems: 1,
					maxItems: 10
				}
			},
			required: [
				"instructions",
				"state",
				"criteria"
			]
		}
	}
};
function isRecord(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isText(v) {
	return typeof v === "string" && v.trim() !== "";
}
function parseInput(type, e) {
	const { instructions, state, criteria } = e;
	if (!isText(instructions)) return "instructions must be a non-empty string";
	if (!isText(state)) return "state must be a non-empty string";
	if (type === "noul") {
		const msg = "criteria must be an object with optional string fields true and false";
		if (criteria === undefined) return {
			state,
			question: {
				type,
				instructions
			}
		};
		if (!isRecord(criteria)) return msg;
		const { true: yes, false: no, ...rest } = criteria;
		if (Object.keys(rest).length > 0) return msg;
		const picked = {};
		if (typeof yes === "string") picked.true = yes;
		else if (yes !== undefined) return msg;
		if (typeof no === "string") picked.false = no;
		else if (no !== undefined) return msg;
		return {
			state,
			question: {
				type,
				instructions,
				criteria: picked
			}
		};
	}
	if (type === "choice") {
		const msg = "criteria must map 1 to 255 non-blank option names to string descriptions";
		if (!isRecord(criteria)) return msg;
		const entries = Object.entries(criteria);
		const options = {};
		for (const [name, description] of entries) if (typeof description === "string") options[name] = description;
		if (entries.some(([name]) => name.trim() === "")) return msg;
		if (entries.length < 1 || entries.length > 255 || Object.keys(options).length !== entries.length) return msg;
		return {
			state,
			question: {
				type,
				instructions,
				criteria: options
			}
		};
	}
	const msg = "criteria must be an array of 1 to 10 strings";
	if (!Array.isArray(criteria)) return msg;
	const levels = criteria.filter((v) => typeof v === "string");
	if (levels.length !== criteria.length || levels.length < 1 || levels.length > 10) return msg;
	return {
		state,
		question: {
			type,
			instructions,
			criteria: levels
		}
	};
}
function endpoint(jevUrlRaw, baseRaw) {
	const jev = jevUrlRaw?.trim();
	if (jev) return HTTP_URL.test(jev) ? {
		ok: true,
		url: jev
	} : {
		ok: false,
		error: "JEV_URL must be an http(s) URL"
	};
	const base = baseRaw?.trim();
	if (base) {
		const url = base.replace(/\/+$/, "") + "/v1/systemone";
		return !/[?#]/.test(base) && HTTP_URL.test(url) ? {
			ok: true,
			url
		} : {
			ok: false,
			error: "TYPESAFE_BASE_URL must be an http(s) URL"
		};
	}
	return {
		ok: true,
		url: DEFAULT_JEV_URL
	};
}
function detail(text) {
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(body) || body["detail"] === undefined) return undefined;
	return typeof body["detail"] === "string" ? body["detail"] : JSON.stringify(body["detail"]);
}
async function ask($, type, state, question, cfg) {
	const fail = (reason) => ({
		isError: true,
		result: `${type}: ${reason}`
	});
	const target = endpoint(cfg.jevUrl, cfg.base);
	if (!target.ok) return fail(target.error);
	const key = cfg.key?.trim();
	const model = (await $.env.get("TYPESAFE_DEFAULT_MODEL"))?.trim() || DEFAULT_MODEL;
	const headers = { "Content-Type": "application/json" };
	if (key && /^https:/i.test(target.url)) headers["Authorization"] = `Bearer ${key}`;
	let timer;
	try {
		const request = $.http.fetch(target.url, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model,
				state,
				questions: { [QUESTION_ID]: question }
			})
		});
		request.catch(() => undefined);
		const timeout = new Promise((resolve) => timer = $.clock.after(TIMEOUT_MS, () => resolve(undefined)));
		const res = await Promise.race([request, timeout]);
		if (res === undefined) return fail(`timeout after ${TIMEOUT_MS}ms`);
		if (!res.ok) {
			const why = detail(res.text);
			return fail(`HTTP ${res.status}${why === undefined ? "" : `: ${why}`}`);
		}
		let body;
		try {
			body = JSON.parse(res.text);
		} catch {
			return fail(`HTTP ${res.status} response was not valid JSON`);
		}
		const answers = isRecord(body) ? body["answers"] : undefined;
		const answer = isRecord(answers) ? answers[QUESTION_ID] : undefined;
		if (!isRecord(answer) || answer["type"] !== type) return fail(`response had no ${type} answer`);
		return { result: JSON.stringify(answer) };
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	} finally {
		timer?.cancel();
	}
}
export function register(on) {
	const names = new Map();
	on("session.start", async function onSessionStart($, e, next) {
		const results = await Promise.allSettled(TYPES.map((type) => $.tool.register(SPECS[type])));
		for (const [i, r] of results.entries()) {
			const type = TYPES[i];
			if (r.status === "fulfilled") names.set(r.value.tool ?? TOOL_PREFIX + type, type);
			else await Promise.resolve($.ui.log(`jev-api: registering ${type} failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)).catch(() => undefined);
		}
		return next(e);
	});
	on("tool.call", async function onToolCall($, e, next) {
		const type = names.get(e.tool) ?? TYPES.find((t) => e.tool === TOOL_PREFIX + t);
		if (type === undefined) return next(e);
		const key = await $.env.get("TYPESAFE_API_KEY");
		const base = await $.env.get("TYPESAFE_BASE_URL");
		const jevUrl = await $.env.get("JEV_URL");
		if (![
			key,
			base,
			jevUrl
		].some(isText)) return {
			isError: true,
			result: `${type}: none of TYPESAFE_API_KEY, TYPESAFE_BASE_URL, JEV_URL is set`
		};
		const input = parseInput(type, e);
		if (typeof input === "string") return {
			isError: true,
			result: `${type}: ${input}`
		};
		return ask($, type, input.state, input.question, {
			key,
			base,
			jevUrl
		});
	});
}
