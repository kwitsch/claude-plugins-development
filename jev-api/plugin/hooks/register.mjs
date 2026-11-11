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
		const msg = "criteria must map 1 to 255 option names to string descriptions";
		if (!isRecord(criteria)) return msg;
		const entries = Object.entries(criteria);
		const options = {};
		for (const [name, description] of entries) if (typeof description === "string") options[name] = description;
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
export function register(on) {
	on("session.start", async function onSessionStart($, e, next) {
		for (const type of TYPES) {
			try {
				await $.tool.register(SPECS[type]);
			} catch {}
		}
		return next(e);
	});
	on("tool.call", async function onToolCall($, e, next) {
		const type = TYPES.find((t) => e.tool === TOOL_PREFIX + t);
		if (type === undefined) return next(e);
		const configured = [
			await $.env.get("TYPESAFE_API_KEY"),
			await $.env.get("TYPESAFE_BASE_URL"),
			await $.env.get("JEV_URL")
		];
		if (!configured.some(isText)) return {
			isError: true,
			result: `${type}: none of TYPESAFE_API_KEY, TYPESAFE_BASE_URL, JEV_URL is set`
		};
		const input = parseInput(type, e);
		if (typeof input === "string") return {
			isError: true,
			result: `${type}: ${input}`
		};
		return {
			isError: true,
			result: `${type}: not implemented`
		};
	});
}
