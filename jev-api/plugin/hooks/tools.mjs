import { DEFAULT_OVERFLOW, OVERFLOWS, TYPES } from "./types.mjs";
import { DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S } from "./util.mjs";
export const STATE = {
	type: "string",
	description: "The text the question is about."
};
export const TIMEOUT = {
	type: "number",
	exclusiveMinimum: 0,
	description: `Optional: the HTTP timeout of the request in seconds, at most ${MAX_TIMEOUT_S}. Default: the plugin's timeout option, else ${DEFAULT_TIMEOUT_S}.`
};
export const OVERFLOW = {
	type: "string",
	enum: [...OVERFLOWS],
	description: `Optional: what happens when the state and questions are too large for System One (or for the timeout): error refuses with the numbers, truncate cuts the middle of the state, haiku answers with Claude Haiku. Default: the plugin's overflow option, else ${DEFAULT_OVERFLOW}.`
};
export const MAX_OPTIONS = 255;
export const MIN_LEVELS = 2;
export const MAX_LEVELS = 10;
export const TOOL_PREFIX = "mcp__jev-api__";
export const SPECS = {
	noul: {
		description: "Ask TypeSafe Jev a yes/no question about a text; returns the probability (0..1) that the answer is true.",
		inputSchema: {
			type: "object",
			properties: {
				instructions: {
					type: "string",
					description: "The yes/no question to answer about the text."
				},
				state: STATE,
				timeout: TIMEOUT,
				overflow: OVERFLOW,
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
		description: "Ask TypeSafe Jev to pick one of named options for a text; returns the choice, its confidence and every option's probability.",
		inputSchema: {
			type: "object",
			properties: {
				instructions: {
					type: "string",
					description: "What to choose."
				},
				state: STATE,
				timeout: TIMEOUT,
				overflow: OVERFLOW,
				criteria: {
					type: "object",
					description: "The options: option name -> description of when to pick it.",
					additionalProperties: { type: "string" },
					minProperties: 1,
					maxProperties: MAX_OPTIONS
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
		description: "Ask TypeSafe Jev to rate a text along ordered levels; returns the score (the expected level: 0 is the first, values between levels are fractional), its confidence, each level's probability and the legend.",
		inputSchema: {
			type: "object",
			properties: {
				instructions: {
					type: "string",
					description: "What to rate."
				},
				state: STATE,
				timeout: TIMEOUT,
				overflow: OVERFLOW,
				criteria: {
					type: "array",
					description: "The levels, lowest first; scores start at 0.",
					items: { type: "string" },
					minItems: MIN_LEVELS,
					maxItems: MAX_LEVELS
				}
			},
			required: [
				"instructions",
				"state",
				"criteria"
			]
		}
	},
	batch: {
		description: "Ask TypeSafe Jev several noul, choice and score questions about one text in a single request; returns a JSON array of the answers in question order, each as the noul, choice or score tool returns it. One invalid or unanswered question fails the whole call.",
		inputSchema: {
			type: "object",
			properties: {
				state: STATE,
				timeout: TIMEOUT,
				overflow: OVERFLOW,
				questions: {
					type: "array",
					description: "The questions, each with the input of the noul, choice or score tool minus state, plus its type.",
					minItems: 1,
					items: {
						type: "object",
						properties: {
							type: {
								type: "string",
								enum: [...TYPES],
								description: "The question type."
							},
							instructions: {
								type: "string",
								description: "The question."
							},
							criteria: { description: `noul: optional { true, false } strings; choice: 1 to ${MAX_OPTIONS} option names -> descriptions; score: ${MIN_LEVELS} to ${MAX_LEVELS} levels, lowest first.` }
						},
						required: ["type", "instructions"]
					}
				}
			},
			required: ["state", "questions"]
		}
	}
};
