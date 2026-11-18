/**
 * Validation of the model-supplied tool input into the state, the System One questions and the call's overflow mode.
 *
 * @packageDocumentation
 */

import { MAX_LEVELS, MAX_OPTIONS, MIN_LEVELS } from "./tools.js";
import { OVERFLOWS, TYPES } from "./types.js";
import type { Overflow, Question, QuestionType, ToolCall } from "./types.js";
import { isOptionalString, isOverflow, isRecord, isText, isType } from "./util.js";

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
 * Validates the model-supplied tool input and builds the System One questions, plus the call's own overflow mode.
 *
 * @param e - The `tool.call` event carrying the input fields.
 * @returns The state, the questions and the overflow mode the call named (undefined: the option decides), or the error
 * message (no request is sent); a question's error names it, `questions[<i>]: ...`.
 */
export function parseInput(e: ToolCall): { state: string; questions: Question[]; overflow?: Overflow } | string {
  const { state } = e;
  if (!isText(state)) return "state must be a non-empty string";
  const list = e["questions"];
  if (!Array.isArray(list) || list.length < 1) return "questions must be a non-empty array";
  const questions: Question[] = [];
  for (const [i, q] of list.entries()) {
    if (!isRecord(q) || !isType(q["type"])) return `questions[${i}]: type must be one of ${TYPES.join(", ")}`;
    const question = parseQuestion(q["type"], q["instructions"], q["criteria"]);
    if (typeof question === "string") return `questions[${i}]: ${question}`;
    questions.push(question);
  }
  const overflow = e["overflow"];
  if (overflow === undefined) return { state, questions };
  return isOverflow(overflow) ? { state, questions, overflow } : `overflow must be one of ${OVERFLOWS.join(", ")}`;
}
