/**
 * The tool registration: name, description and input schema of `request`.
 *
 * @packageDocumentation
 */

import { DEFAULT_OVERFLOW, OVERFLOWS, TYPES } from "./types.js";
import type { ToolName, ToolSpec } from "./types.js";
import { DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S } from "./util.js";

/** The `state` input property of the tool. */
export const STATE = { type: "string", description: "The text the question is about." };

/** The optional `timeout` input property of the tool. */
export const TIMEOUT = { type: "number", exclusiveMinimum: 0, description: `Optional: the HTTP timeout of the request in seconds, at most ${MAX_TIMEOUT_S}. Default: the plugin's timeout option, else ${DEFAULT_TIMEOUT_S}.` };

/** The optional `overflow` input property of the tool. */
export const OVERFLOW = { type: "string", enum: [...OVERFLOWS], description: `Optional: what happens when the state and questions are too large for System One (or for the timeout): error refuses with the numbers, truncate cuts the middle of the state, haiku answers with Claude Haiku. Default: the plugin's overflow option, else ${DEFAULT_OVERFLOW}.` };

/** The most options a `choice` question may have. */
export const MAX_OPTIONS = 255;

/** The fewest levels a `score` question may have (the API refuses one). */
export const MIN_LEVELS = 2;

/** The most levels a `score` question may have. */
export const MAX_LEVELS = 10;

/** The engine names a registered tool `mcp__<plugin>__<name>`. */
export const TOOL_PREFIX = "mcp__jev-api__";

/** The tool registrations without their name, keyed by tool name. */
export const SPECS: Record<ToolName, Omit<ToolSpec, "name">> = {
  request: {
    description: "Ask TypeSafe Jev one or more noul (yes/no probability), choice (pick one of named options) and score (rate along ordered levels) questions about one text in a single request; returns a JSON array of the answers in question order. One invalid or unanswered question fails the whole call.",
    inputSchema: {
      type: "object",
      properties: {
        state: STATE,
        timeout: TIMEOUT,
        overflow: OVERFLOW,
        questions: {
          type: "array",
          description: "The questions, each { type, instructions, criteria }; timeout and overflow apply to the whole request.",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: [...TYPES], description: "The question type." },
              instructions: { type: "string", description: "The question." },
              criteria: { description: `noul: optional { true, false } strings; choice: 1 to ${MAX_OPTIONS} option names -> descriptions; score: ${MIN_LEVELS} to ${MAX_LEVELS} levels, lowest first.` },
            },
            required: ["type", "instructions"],
          },
        },
      },
      required: ["state", "questions"],
    },
  },
};
