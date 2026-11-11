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
export function register(on) {
	on("session.start", async function onSessionStart($, e, next) {
		for (const type of TYPES) {
			try {
				await $.tool.register(SPECS[type]);
			} catch {}
		}
		return next(e);
	});
	on("tool.call", function onToolCall(_$, e, next) {
		return next(e);
	});
}
