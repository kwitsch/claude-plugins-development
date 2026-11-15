// The policy rules of jevfort (effort estimate, its input check, the next-action question), through the built
// plugin/hooks/register.mjs: `estimate_effort` is called as the model calls it, and the questions Jev gets are read back.
import { expect } from "vitest";
import { byId, claudeBeneath, CWD, DEFAULTS, drain, makeKit, mech, type Runner, scored, step, user } from "./support/kit.ts";

const { test, setup } = makeKit(DEFAULTS);

const ESTIMATE = { tool: "mcp__jevfort__estimate_effort", model: "opus", defaultEffort: "high", minEffort: "low", maxEffort: "xhigh", prompt: "add a retry to the HTTP client" };
/** The criteria of a question as a map from option to description (empty when it has none). */
const criteriaOf = (q: { criteria?: unknown } | undefined): Record<string, string> => (q?.criteria ?? {}) as Record<string, string>;
/**
 * Calls the estimate tool with the given input, over the defaults above.
 *
 * @param $ - The test's `$`.
 * @param input - The fields to change.
 * @returns The tool's result or deny.
 */
const estimate = async ($: Runner, input: Record<string, unknown> = {}) => (await $.tool.call({ ...ESTIMATE, ...input })) as { result?: string; deny?: string };
/**
 * The estimate's result as the tool returns it.
 *
 * @param r - The tool's result.
 * @returns The effort and its source.
 */
const verdict = (r: { result?: string }) => JSON.parse(r.result ?? "null") as { effort: string; source: string };

test("estimateEffort falls back to the default without a usable score, unclamped", async ($, on) => {
  setup(on, { messages: [], jev: () => 401 });
  expect(verdict(await estimate($))).toEqual({ effort: "high", source: "fallback" });
  expect(verdict(await estimate($, { defaultEffort: "max" }))).toEqual({ effort: "max", source: "fallback" });
});

test("estimateEffort ignores a low confidence score, but not a NaN one", async ($, on) => {
  let answer: Record<string, unknown> = scored(0.2, 0.4);
  setup(on, {
    messages: [],
    jev: byId({
      get effort() {
        return answer;
      },
      mechanical: mech(0.1),
    }),
  });
  expect(verdict(await estimate($))).toEqual({ effort: "low", source: "jev" });
  answer = scored(Number.NaN);
  expect(verdict(await estimate($))).toEqual({ effort: "high", source: "fallback" });
});

test("estimateEffort gives a mechanical prompt minEffort, whatever the score", async ($, on) => {
  setup(on, { messages: [], jev: byId({ mechanical: mech(0.95) }) });
  expect(verdict(await estimate($))).toEqual({ effort: "low", source: "mechanical" });
  expect(verdict(await estimate($, { minEffort: "medium" }))).toEqual({ effort: "medium", source: "mechanical" });
});

test("below MECHANICAL_FROM (0.95) the score decides: 0.9 and 0.5 do not count as mechanical", async ($, on) => {
  let mechanical = 0.9;
  setup(on, {
    messages: [],
    jev: byId({
      effort: scored(2),
      get mechanical() {
        return mech(mechanical);
      },
    }),
  });
  expect(verdict(await estimate($))).toEqual({ effort: "high", source: "jev" });
  mechanical = 0.5;
  expect(verdict(await estimate($))).toEqual({ effort: "high", source: "jev" });
});

test("the score's cut points map to the rounded levels, clamped to 0..4", async ($, on) => {
  let score = 0;
  setup(on, {
    messages: [],
    jev: byId({
      get effort() {
        return scored(score);
      },
      mechanical: mech(0.1),
    }),
  });
  const levels: [number, string][] = [
    [-1, "low"],
    [0, "low"],
    [1.05, "medium"],
    [1.9, "high"],
    [2.5, "xhigh"],
    [3.1, "max"],
    [9, "max"],
  ];
  for (const [s, effort] of levels) {
    score = s;
    expect(verdict(await estimate($, { maxEffort: "max" })), `score ${s}`).toEqual({ effort, source: "jev" });
  }
});

test("the same score gives every model the same level", async ($, on) => {
  let score = 1.6;
  setup(on, {
    messages: [],
    jev: byId({
      get effort() {
        return scored(score);
      },
      mechanical: mech(0.1),
    }),
  });
  for (const model of ["haiku", "sonnet", "opus", "fable"] as const) {
    score = 1.6;
    expect(verdict(await estimate($, { model })).effort, model).toBe("medium");
    score = 2.2;
    expect(verdict(await estimate($, { model })).effort, model).toBe("high");
  }
});

test("Jev's estimate stays within minEffort..maxEffort", async ($, on) => {
  let score = 4;
  setup(on, {
    messages: [],
    jev: byId({
      get effort() {
        return scored(score);
      },
      mechanical: mech(0.1),
    }),
  });
  expect(verdict(await estimate($, { model: "haiku" }))).toEqual({ effort: "xhigh", source: "jev" });
  score = 0;
  expect(verdict(await estimate($, { model: "fable", minEffort: "medium" }))).toEqual({ effort: "medium", source: "jev" });
});

test("the estimate tool keeps a valid call and names the first invalid field", async ($, on) => {
  setup(on, { messages: [], jev: byId({ effort: scored(1.6), mechanical: mech(0.1) }) });
  expect((await estimate($, { defaultEffort: "max" })).result).toBeDefined();
  const denied = async (input: Record<string, unknown>) => (await estimate($, input)).deny;
  expect(await denied({ model: "gpt" })).toBe("estimate_effort: model must be one of haiku, sonnet, opus, fable");
  expect(await denied({ model: "claude-opus-5-5" })).toBe("estimate_effort: model must be one of haiku, sonnet, opus, fable");
  expect(await denied({ defaultEffort: "huge" })).toBe("estimate_effort: defaultEffort must be one of low, medium, high, xhigh, max");
  expect(await denied({ minEffort: undefined })).toBe("estimate_effort: minEffort must be one of low, medium, high, xhigh, max");
  expect(await denied({ maxEffort: 3 })).toBe("estimate_effort: maxEffort must be one of low, medium, high, xhigh, max");
  expect(await denied({ minEffort: "high", maxEffort: "low" })).toBe("estimate_effort: minEffort must not be above maxEffort");
  expect(await denied({ prompt: "" })).toBe("estimate_effort: prompt must be a non-empty string");
  expect(await denied({ prompt: "  \n " })).toBe("estimate_effort: prompt must be a non-empty string");
  expect(await denied({ prompt: 42 })).toBe("estimate_effort: prompt must be a non-empty string");
});

test("a turn's next-action question has string instructions and one string criterion per option", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  const { sent } = setup(on, { messages: [user("what does src/app.ts export?")], files: [`${CWD}/src/app.ts`], jev: () => undefined });
  claudeBeneath(on, []);
  await drain($.turn.step(step));
  const q = sent.find((x) => x.id === "next_action");
  expect(q?.type).toBe("choice");
  expect(q?.instructions).toMatch(/^An AI coding assistant is working on the user request in `request`; .* pick claude\.$/);
  expect(Object.keys(q?.criteria as object)).toEqual(["claude", "read src/app.ts"]);
  expect(criteriaOf(q)["read src/app.ts"]).toBe("Read the file src/app.ts");
});
