// Unit tests of jev-api's small helpers (src/hooks/util.ts): guards, JSON parsing, tool errors, timeouts, question keys, untilAbort.
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TIMEOUT_S, fail, isOptionalString, isOverflow, isRecord, isText, isType, json, MAX_TIMEOUT_S, message, questionId, questionsBody, seconds, untilAbort } from "../src/hooks/util.ts";

describe("guards", () => {
  it("isOverflow takes exactly the three overflow modes", () => {
    expect(["error", "truncate", "haiku"].map(isOverflow)).toEqual([true, true, true]);
    expect(["Error", "", undefined, 1, null].map(isOverflow)).toEqual([false, false, false, false, false]);
  });

  it("isRecord takes plain objects, also one without a prototype, and refuses arrays, null and primitives", () => {
    expect([{}, { a: 1 }, Object.create(null)].map(isRecord)).toEqual([true, true, true]);
    expect([[], null, "x", 3, undefined].map(isRecord)).toEqual([false, false, false, false, false]);
  });

  it("isOptionalString takes a string or undefined only", () => {
    expect([undefined, "", "x"].map(isOptionalString)).toEqual([true, true, true]);
    expect([null, 0, {}].map(isOptionalString)).toEqual([false, false, false]);
  });

  it("isType takes exactly the three question types", () => {
    expect(["noul", "choice", "score"].map(isType)).toEqual([true, true, true]);
    expect(["batch", "", undefined].map(isType)).toEqual([false, false, false]);
  });

  it("isText refuses blank strings and non-strings", () => {
    expect([" a ", "x"].map(isText)).toEqual([true, true]);
    expect(["", "  \n\t", 5, undefined].map(isText)).toEqual([false, false, false, false]);
  });
});

describe("json", () => {
  it("answers undefined for text that is not JSON and the value for valid JSON, null included", () => {
    expect(json("{nope")).toBeUndefined();
    expect(json("")).toBeUndefined();
    expect(json("null")).toBeNull();
    expect(json("{\"a\":[1]}")).toEqual({ a: [1] });
  });

  it("applies the reviver", () => {
    expect(json("{\"a\":1,\"b\":\"x\"}", (_key, value) => (typeof value === "number" ? value + 1 : value))).toEqual({ a: 2, b: "x" });
  });
});

describe("fail", () => {
  it("answers a deny that starts with the tool name", () => {
    expect(fail("boom")).toEqual({ deny: "request: boom" });
  });
});

describe("seconds", () => {
  it("refuses non-numbers, non-finite numbers, zero and negatives", () => {
    expect(["5", Number.NaN, Number.POSITIVE_INFINITY, 0, -1, null, undefined].map(seconds)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
  });

  it("keeps a value up to the maximum", () => {
    expect(seconds(0.5)).toBe(0.5);
    expect(seconds(DEFAULT_TIMEOUT_S)).toBe(DEFAULT_TIMEOUT_S);
    expect(seconds(MAX_TIMEOUT_S)).toBe(MAX_TIMEOUT_S);
  });

  it("caps a value above the maximum", () => {
    expect(seconds(MAX_TIMEOUT_S + 0.001)).toBe(MAX_TIMEOUT_S);
    expect(seconds(1e12)).toBe(MAX_TIMEOUT_S);
  });
});

describe("message", () => {
  it("is an Error's message", () => {
    expect(message(new TypeError("bad input"))).toBe("bad input");
  });

  it("is the text of any other value, and a fixed text when the value cannot be turned into one", () => {
    expect(message("plain")).toBe("plain");
    expect(message(7)).toBe("7");
    expect(message(undefined)).toBe("undefined");
    expect(message(Object.create(null))).toBe("unknown error");
  });
});

describe("question keys", () => {
  it("questionsBody keys the questions q0, q1, ... in input order", () => {
    const a = { type: "noul" as const, instructions: "A?" };
    const b = { type: "score" as const, instructions: "B", criteria: ["low", "high"] };
    const body = questionsBody([a, b]);
    expect(Object.keys(body)).toEqual(["q0", "q1"]);
    expect(body["q0"]).toBe(a);
    expect(body["q1"]).toBe(b);
    expect(questionId(12)).toBe("q12");
  });
});

describe("untilAbort", () => {
  it("settles with the wait when it settles first and removes its abort listener", async () => {
    const ctl = new AbortController();
    const removed = vi.spyOn(ctl.signal, "removeEventListener");
    await untilAbort(Promise.resolve("done"), ctl.signal);
    expect(removed).toHaveBeenCalledTimes(1);
    expect(removed.mock.calls[0]?.[0]).toBe("abort");
  });

  it("ends at the abort although the wait never settles", async () => {
    const ctl = new AbortController();
    const done = untilAbort(new Promise(() => {}), ctl.signal);
    ctl.abort();
    await expect(done).resolves.toBeUndefined();
  });

  it("ends at once for a signal that is already aborted", async () => {
    await expect(untilAbort(new Promise(() => {}), AbortSignal.abort())).resolves.toBeUndefined();
  });

  it("rejects like the wait when the wait rejects first", async () => {
    await expect(untilAbort(Promise.reject(new Error("wait failed")), new AbortController().signal)).rejects.toThrow("wait failed");
  });
});
