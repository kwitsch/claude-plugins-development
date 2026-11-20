// Unit tests of jev-api's input validation (src/hooks/input.ts): one question's fields per type, then the whole tool input.
import { describe, expect, it } from "vitest";
import { parseInput, parseQuestion } from "../src/hooks/input.ts";
import { MAX_LEVELS, MAX_OPTIONS, MIN_LEVELS } from "../src/hooks/tools.ts";

const TOOL = "mcp__jev-api__request";
const NOUL_MSG = "criteria must be an object with optional string fields true and false";
const CHOICE_MSG = `criteria must map 1 to ${MAX_OPTIONS} non-blank option names to string descriptions`;
const SCORE_MSG = `criteria must be an array of ${MIN_LEVELS} to ${MAX_LEVELS} strings`;

/** `n` choice options named o0, o1, ... */
const options = (n: number): Record<string, string> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, "d"]));
/** `n` score levels. */
const levels = (n: number): string[] => Array.from({ length: n }, (_, i) => `level ${i}`);

describe("parseQuestion", () => {
  it("refuses blank or missing instructions for every type", () => {
    for (const type of ["noul", "choice", "score"] as const) {
      expect(parseQuestion(type, "  ", undefined)).toBe("instructions must be a non-empty string");
      expect(parseQuestion(type, undefined, undefined)).toBe("instructions must be a non-empty string");
    }
  });

  it("noul: no criteria gives a question without a criteria field", () => {
    const q = parseQuestion("noul", "Is it?", undefined);
    expect(q).toEqual({ type: "noul", instructions: "Is it?" });
    expect("criteria" in (q as object)).toBe(false);
  });

  it("noul: true and false wordings pass through, each optional", () => {
    expect(parseQuestion("noul", "Is it?", { true: "yes", false: "no" })).toEqual({ type: "noul", instructions: "Is it?", criteria: { true: "yes", false: "no" } });
    expect(JSON.parse(JSON.stringify(parseQuestion("noul", "Is it?", { true: "yes" })))).toEqual({ type: "noul", instructions: "Is it?", criteria: { true: "yes" } });
  });

  it("noul: an unknown field, a non-string wording and a non-object are refused", () => {
    expect(parseQuestion("noul", "Is it?", { true: "yes", maybe: "x" })).toBe(NOUL_MSG);
    expect(parseQuestion("noul", "Is it?", { true: 1 })).toBe(NOUL_MSG);
    expect(parseQuestion("noul", "Is it?", ["yes", "no"])).toBe(NOUL_MSG);
  });

  it("choice: one option and the maximum number of options are accepted", () => {
    expect(parseQuestion("choice", "Pick", { a: "first" })).toEqual({ type: "choice", instructions: "Pick", criteria: { a: "first" } });
    const most = parseQuestion("choice", "Pick", options(MAX_OPTIONS));
    expect(typeof most).toBe("object");
    expect(Object.keys((most as { criteria: object }).criteria)).toHaveLength(MAX_OPTIONS);
  });

  it("choice: no option, one more than the maximum, a blank name, a non-string description and a non-object are refused", () => {
    expect(parseQuestion("choice", "Pick", {})).toBe(CHOICE_MSG);
    expect(parseQuestion("choice", "Pick", options(MAX_OPTIONS + 1))).toBe(CHOICE_MSG);
    expect(parseQuestion("choice", "Pick", { " ": "blank name" })).toBe(CHOICE_MSG);
    expect(parseQuestion("choice", "Pick", { a: 1 })).toBe(CHOICE_MSG);
    expect(parseQuestion("choice", "Pick", undefined)).toBe(CHOICE_MSG);
  });

  it("score: the fewest and the most levels are accepted", () => {
    expect(parseQuestion("score", "Rate", levels(MIN_LEVELS))).toEqual({ type: "score", instructions: "Rate", criteria: levels(MIN_LEVELS) });
    expect(parseQuestion("score", "Rate", levels(MAX_LEVELS))).toEqual({ type: "score", instructions: "Rate", criteria: levels(MAX_LEVELS) });
  });

  it("score: one level too few, one too many, a non-string level and a non-array are refused", () => {
    expect(parseQuestion("score", "Rate", levels(MIN_LEVELS - 1))).toBe(SCORE_MSG);
    expect(parseQuestion("score", "Rate", levels(MAX_LEVELS + 1))).toBe(SCORE_MSG);
    expect(parseQuestion("score", "Rate", ["low", 2])).toBe(SCORE_MSG);
    expect(parseQuestion("score", "Rate", { 0: "low", 1: "high" })).toBe(SCORE_MSG);
  });
});

describe("parseInput", () => {
  const noul = { type: "noul", instructions: "Is it?" };

  it("refuses a missing or blank state before it looks at the questions", () => {
    expect(parseInput({ tool: TOOL, questions: "not even an array" })).toBe("state must be a non-empty string");
    expect(parseInput({ tool: TOOL, state: " ", questions: [noul] })).toBe("state must be a non-empty string");
  });

  it("refuses questions that are missing, not an array or empty", () => {
    for (const questions of [undefined, { q0: noul }, []]) expect(parseInput({ tool: TOOL, state: "text", questions })).toBe("questions must be a non-empty array");
  });

  it("names the index of the first invalid question", () => {
    expect(parseInput({ tool: TOOL, state: "text", questions: [noul, { type: "batch", instructions: "x" }] })).toBe("questions[1]: type must be one of noul, choice, score");
    expect(parseInput({ tool: TOOL, state: "text", questions: [{ type: "score", instructions: "Rate", criteria: ["only one"] }, noul] })).toBe(`questions[0]: ${SCORE_MSG}`);
    expect(parseInput({ tool: TOOL, state: "text", questions: ["noul"] })).toBe("questions[0]: type must be one of noul, choice, score");
  });

  it("returns the state and the questions in input order, without an overflow field when the call names none", () => {
    const r = parseInput({ tool: TOOL, state: "text", questions: [{ type: "choice", instructions: "Pick", criteria: { a: "first" } }, noul] });
    expect(r).toEqual({ state: "text", questions: [{ type: "choice", instructions: "Pick", criteria: { a: "first" } }, { type: "noul", instructions: "Is it?" }] });
    expect("overflow" in (r as object)).toBe(false);
  });

  it("takes a valid overflow mode and refuses any other value", () => {
    expect(parseInput({ tool: TOOL, state: "text", questions: [noul], overflow: "truncate" })).toEqual({ state: "text", questions: [noul], overflow: "truncate" });
    expect(parseInput({ tool: TOOL, state: "text", questions: [noul], overflow: "cut" })).toBe("overflow must be one of error, truncate, haiku");
    expect(parseInput({ tool: TOOL, state: "text", questions: [noul], overflow: null })).toBe("overflow must be one of error, truncate, haiku");
  });
});
