// Unit tests of src/hooks/size.ts: the pure part of the size-task mod.
import { describe, expect, it } from "vitest";
import { MAX_SUBSYSTEM_CHARS, MAX_SUBSYSTEMS, MAX_TASK_CHARS, modelPrompt, OPTIONS, parseInput, readAnswer, readModelSize, SIZES, textOf } from "../src/hooks/size.ts";

describe("parseInput", () => {
  it("joins the trimmed task and subsystem lines with newlines", () => {
    expect(parseInput({ task: "  fix it \n", subsystems: [" a - b ", "c - d"] })).toBe("fix it\na - b\nc - d");
    expect(parseInput({ task: "fix it" })).toBe("fix it");
  });

  it.each([
    [{}],
    [{ task: "   " }],
    [{ task: 5 }],
    [{ task: "x".repeat(MAX_TASK_CHARS + 1) }],
    [{ task: "x", subsystems: "a" }],
    [{ task: "x", subsystems: [1] }],
    [{ task: "x", subsystems: [" "] }],
    [{ task: "x", subsystems: Array.from({ length: MAX_SUBSYSTEMS + 1 }, () => "a") }],
  ])("refuses %j", (input) => {
    expect(parseInput(input)).toHaveProperty("error");
  });

  it("cuts an overlong subsystem line instead of refusing", () => {
    expect(parseInput({ task: "x", subsystems: ["y".repeat(MAX_SUBSYSTEM_CHARS + 50)] })).toBe(`x\n${"y".repeat(MAX_SUBSYSTEM_CHARS)}`);
  });

  it("cuts by code point, never inside a surrogate pair", () => {
    const cut = parseInput({ task: "x", subsystems: ["😀".repeat(MAX_SUBSYSTEM_CHARS + 5)] });
    expect(cut).toBe(`x\n${"😀".repeat(MAX_SUBSYSTEM_CHARS)}`);
  });

  it("takes the longest task and the most subsystems", () => {
    expect(parseInput({ task: "x".repeat(MAX_TASK_CHARS), subsystems: Array.from({ length: MAX_SUBSYSTEMS }, () => "a") })).toBeTypeOf("string");
  });
});

describe("readAnswer", () => {
  const answer = (over: Record<string, unknown>) => JSON.stringify([{ type: "choice", choice: "M", confidence: 0.3, probabilities: { S: 0.1, M: 0.6, L: 0.2, XL: 0.1 }, ...over }]);

  it("reads the probability of the choice, not the answer's confidence", () => {
    expect(readAnswer(answer({}))).toEqual({ size: "M", probability: 0.6 });
  });

  it.each([
    ["not json", "nope"],
    ["not an array", JSON.stringify({ type: "choice" })],
    ["empty array", "[]"],
    ["a score answer", answer({ type: "score" })],
    ["an unknown choice", answer({ choice: "XXL" })],
    ["no probabilities", answer({ probabilities: undefined })],
    ["a missing probability", answer({ probabilities: { S: 1 } })],
    ["a non-number probability", answer({ probabilities: { M: "high" } })],
  ])("returns undefined for %s", (_name, text) => {
    expect(readAnswer(text)).toBeUndefined();
  });
});

describe("readModelSize", () => {
  it.each([["S", "S"], [" XL\n", "XL"], ["M (one concern)", "M"], ["L.", "L"]])("reads %j as %s", (text, size) => {
    expect(readModelSize(text)).toBe(size);
  });

  it.each([["Large"], ["The size is M"], [""], ["XXL"]])("does not read %j", (text) => {
    expect(readModelSize(text)).toBeUndefined();
  });
});

describe("textOf", () => {
  it("prefers text, then a string result, then the text parts; refusals and errors have none", () => {
    expect(textOf({ text: "a", result: "b" })).toBe("a");
    expect(textOf({ result: "b" })).toBe("b");
    expect(textOf({ result: [{ type: "text", text: "c" }, { type: "image" }, { type: "text", text: "d" }] })).toBe("c\nd");
    expect(textOf({ result: "" })).toBeUndefined();
    expect(textOf({ result: [{ type: "image" }] })).toBeUndefined();
    expect(textOf({ deny: "no", result: "b" })).toBeUndefined();
    expect(textOf({ isError: true, result: "b" })).toBeUndefined();
  });
});

describe("the calibrated question", () => {
  it("puts the task first and every description in the model prompt", () => {
    const prompt = modelPrompt("the task");
    expect(prompt.startsWith("Task:\nthe task\n")).toBe(true);
    for (const s of SIZES) expect(prompt).toContain(`${s}: ${OPTIONS[s]}`);
  });
});
