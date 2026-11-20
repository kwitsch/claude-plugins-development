// The policy rules of jevfort (the effort estimate, the next-action question), through
// src/hooks/register.ts: step 0 runs as Claude Code runs it, its debug effort line and the questions Jev gets are read back.
import { expect } from "vitest";
import { byId, claudeBeneath, CWD, DEFAULTS, drain, effortOf, makeKit, mech, scored, sessionStubs, START, step, user } from "./support/kit.ts";

const { test, setup } = makeKit(DEFAULTS);

/** The messages of every estimate: step 0 asks nothing without a user message. */
const PROMPT = [user("add a retry to the HTTP client")];
/** The criteria of a question as a map from option to description (empty when it has none). */
const criteriaOf = (q: { criteria?: unknown } | undefined): Record<string, string> => (q?.criteria ?? {}) as Record<string, string>;

// Step 0 cannot reach the "fallback" source: a NaN score fails the request's answer check (jev unavailable), which keeps the session effort.
test("without a usable score the session effort stays, unclamped", async ($, on) => {
  setup(on, { messages: PROMPT, jev: byId({ effort: scored(Number.NaN), mechanical: mech(0.1) }) });
  const run = effortOf(on);
  expect((await run($)).effort).toBe("unchanged");
  // Above maxEffort (xhigh): the session effort is kept, not clamped.
  expect((await run($, { effort: "max" })).effort).toBe("unchanged");
});

test("a low confidence score still counts, a NaN score does not", async ($, on) => {
  let answer: Record<string, unknown> = scored(0.2, 0.4);
  setup(on, {
    messages: PROMPT,
    jev: byId({
      get effort() {
        return answer;
      },
      mechanical: mech(0.1),
    }),
  });
  const run = effortOf(on);
  expect(await run($)).toEqual({ effort: "low", source: "jev" });
  answer = scored(Number.NaN);
  expect((await run($)).effort).toBe("unchanged");
});

test("estimateEffort gives a mechanical prompt minEffort, whatever the score", async ($, on) => {
  setup(on, { messages: PROMPT, jev: byId({ mechanical: mech(0.95) }) });
  expect(await effortOf(on)($)).toEqual({ effort: "low", source: "mechanical" });
});

test("estimateEffort gives a mechanical prompt a raised minEffort", { options: { minEffort: "medium" } }, async ($, on) => {
  setup(on, { messages: PROMPT, jev: byId({ mechanical: mech(0.95) }) });
  expect(await effortOf(on)($)).toEqual({ effort: "medium", source: "mechanical" });
});

test("below MECHANICAL_FROM (0.95) the score decides: 0.9 and 0.5 do not count as mechanical", async ($, on) => {
  let mechanical = 0.9;
  setup(on, {
    messages: PROMPT,
    jev: byId({
      effort: scored(2),
      get mechanical() {
        return mech(mechanical);
      },
    }),
  });
  const run = effortOf(on);
  expect(await run($)).toEqual({ effort: "high", source: "jev" });
  mechanical = 0.5;
  expect(await run($)).toEqual({ effort: "high", source: "jev" });
});

test("the score's cut points map to the rounded levels, clamped to 0..4", { options: { maxEffort: "max" } }, async ($, on) => {
  let score = 0;
  setup(on, {
    messages: PROMPT,
    jev: byId({
      get effort() {
        return scored(score);
      },
      mechanical: mech(0.1),
    }),
  });
  const run = effortOf(on);
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
    expect(await run($), `score ${s}`).toEqual({ effort, source: "jev" });
  }
});

test("the same score gives every model the same level", async ($, on) => {
  let score = 1.6;
  setup(on, {
    messages: PROMPT,
    jev: byId({
      get effort() {
        return scored(score);
      },
      mechanical: mech(0.1),
    }),
  });
  sessionStubs(on);
  const run = effortOf(on);
  for (const model of ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5"]) {
    // A new session clears the first-turn hold, so Haiku/Fable estimate again.
    await $.session.start(START);
    score = 1.6;
    expect((await run($, { model })).effort, model).toBe("medium");
    await $.session.start(START);
    score = 2.2;
    expect((await run($, { model })).effort, model).toBe("high");
  }
});

test("Jev's estimate stays within maxEffort", async ($, on) => {
  setup(on, { messages: PROMPT, jev: byId({ effort: scored(4), mechanical: mech(0.1) }) });
  expect(await effortOf(on)($, { model: "claude-haiku-5-5" })).toEqual({ effort: "xhigh", source: "jev" });
});

test("Jev's estimate stays within a raised minEffort", { options: { minEffort: "medium" } }, async ($, on) => {
  setup(on, { messages: PROMPT, jev: byId({ effort: scored(0), mechanical: mech(0.1) }) });
  expect(await effortOf(on)($, { model: "claude-fable-5" })).toEqual({ effort: "medium", source: "jev" });
});

// The estimate tool's input check ("keeps a valid call and names the first invalid field") is gone with the tool: step 0's
// bounds come from the plugin options and the engine's step, which no model input can make invalid.

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

test("pickCandidate takes at exactly the threshold, not below it, and not without a probability", async () => {
  const { pickCandidate } = await import("../src/hooks/policy.ts");
  const cands = [{ key: "read a", label: "a" }] as never;
  const ans = (probabilities: Record<string, number>) => ({ type: "choice", choice: "read a", probabilities, confidence: 0.9 }) as never;
  expect(pickCandidate(ans({ "read a": 0.85 }), cands, 0.85)).toBeDefined();
  expect(pickCandidate(ans({ "read a": 0.84 }), cands, 0.85)).toBeUndefined();
  expect(pickCandidate(ans({}), cands, 0.85)).toBeUndefined();
  expect(pickCandidate(ans({}), cands, 0)).toBeDefined();
});

test("compactInstructions keeps at 2.2 and drops below 0.8, with an unanswered item neither", async () => {
  const { compactInstructions } = await import("../src/hooks/compact.ts");
  const items = ["a", "b", "c", "d", "e", "f"].map((label) => ({ id: label, label, result: "" })) as never;
  const text = compactInstructions(items, [2.2, 2.19, 0.8, 0.79, undefined, 0]) as string;
  expect(text).toContain("from: a.");
  expect(text).toContain("dropped: d; f.");
  expect(compactInstructions(items, [2.19, 0.8, undefined, 1, 1.5, 2])).toBeUndefined();
});

test("SWITCH_AT is 0.85", async () => {
  const { SWITCH_AT } = await import("../src/hooks/agents.ts");
  expect(SWITCH_AT).toBe(0.85);
});
