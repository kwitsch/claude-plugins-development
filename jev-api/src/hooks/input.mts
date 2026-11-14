/**
 * Validation of the model-supplied tool input into the state, the System One questions and the call's overflow mode.
 *
 * @packageDocumentation
 */

import { MAX_LEVELS, MAX_OPTIONS, MIN_LEVELS } from "./tools.mjs";
import { OVERFLOWS, TYPES } from "./types.mjs";
import type { Overflow, Question, QuestionType, ToolCall, ToolName } from "./types.mjs";
import { isOptionalString, isOverflow, isRecord, isText, isType } from "./util.mjs";

/**
 * Validates one question's fields and builds the System One question. Values pass through unchanged.
 *
 * @param type - The question type.
 * @param instructions - The question text.
 * @param criteria - The type's criteria, as given.
 * @returns The question, or the error message (no request is sent).
 */
export function parseQuestion(type: QuestionType, instructions: unknown, criteria: unknown): Question | string {
  if (!isText(instructions)) return "instructions must be a non-empty string";
  if (type === "noul") {
    const msg = "criteria must be an object with optional string fields true and false";
    if (criteria === undefined) return { type, instructions };
    if (!isRecord(criteria)) return msg;
    const { true: yes, false: no, ...rest } = criteria;
    if (Object.keys(rest).length > 0 || !isOptionalString(yes) || !isOptionalString(no)) return msg;
    return { type, instructions, criteria: { true: yes, false: no } }; // JSON drops undefined fields
  }
  if (type === "choice") {
    const msg = `criteria must map 1 to ${MAX_OPTIONS} non-blank option names to string descriptions`;
    if (!isRecord(criteria)) return msg;
    const entries = Object.entries(criteria);
    const valid = entries.filter((p): p is [string, string] => p[0].trim() !== "" && typeof p[1] === "string");
    if (entries.length < 1 || entries.length > MAX_OPTIONS || valid.length !== entries.length) return msg;
    return { type, instructions, criteria: Object.fromEntries(valid) };
  }
  const msg = `criteria must be an array of ${MIN_LEVELS} to ${MAX_LEVELS} strings`;
  if (!Array.isArray(criteria) || criteria.length < MIN_LEVELS || criteria.length > MAX_LEVELS || !criteria.every((v): v is string => typeof v === "string")) return msg;
  return { type, instructions, criteria };
}

/**
 * Validates the state and questions of the model-supplied tool input: one question for a question-type tool, the
 * `questions` array for `batch`.
 *
 * @param tool - The tool called.
 * @param e - The `tool.call` event carrying the input fields.
 * @returns The state and questions, or the error message (no request is sent).
 */
export function parseQuestions(tool: ToolName, e: ToolCall): { state: string; questions: Question[] } | string {
  const { instructions, state } = e;
  // A question-type tool checks instructions, then state, then criteria.
  if (tool !== "batch" && !isText(instructions)) return "instructions must be a non-empty string";
  if (!isText(state)) return "state must be a non-empty string";
  if (tool !== "batch") {
    const question = parseQuestion(tool, instructions, e["criteria"]);
    return typeof question === "string" ? question : { state, questions: [question] };
  }
  const list = e["questions"];
  if (!Array.isArray(list) || list.length < 1) return "questions must be a non-empty array";
  const questions: Question[] = [];
  for (const [i, q] of list.entries()) {
    if (!isRecord(q) || !isType(q["type"])) return `questions[${i}]: type must be one of ${TYPES.join(", ")}`;
    const question = parseQuestion(q["type"], q["instructions"], q["criteria"]);
    if (typeof question === "string") return `questions[${i}]: ${question}`;
    questions.push(question);
  }
  return { state, questions };
}

/**
 * Validates the model-supplied tool input and builds the System One questions, plus the call's own overflow mode.
 *
 * @param tool - The tool called.
 * @param e - The `tool.call` event carrying the input fields.
 * @returns The state, the questions and the overflow mode the call named (undefined: the option decides), or the error
 * message (no request is sent).
 */
export function parseInput(tool: ToolName, e: ToolCall): { state: string; questions: Question[]; overflow?: Overflow } | string {
  const parsed = parseQuestions(tool, e);
  if (typeof parsed === "string") return parsed;
  const overflow = e["overflow"];
  if (overflow === undefined) return parsed;
  return isOverflow(overflow) ? { ...parsed, overflow } : `overflow must be one of ${OVERFLOWS.join(", ")}`;
}
