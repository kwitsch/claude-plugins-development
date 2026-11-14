// Pure tests of the built plugin/hooks/policy.mjs.
import assert from "node:assert/strict";
import { test } from "vitest";
import { bestAction, bounds, effortLevel, estimateEffort, inScratchpad, isEffort, lowerModel, modelFamily, nextActionQuestion, parseEstimateInput, route, shouldContinue } from "../plugin/hooks/policy.mjs";

const ROOTS = ["/tmp"];
const SP = "/tmp/claude-1000/-proj/sid-1/scratchpad";

test("inScratchpad rejects Win32 escapes: a backslash separator and a leading //", () => {
  assert.equal(inScratchpad(`${SP}/..\\..\\x`, "sid-1", ROOTS), false);
  assert.equal(inScratchpad(`/${SP}/x`, "sid-1", ROOTS), false);
  assert.equal(inScratchpad(`${SP}/a\\b`, "sid-1", ROOTS), false);
});

test("inScratchpad accepts a file inside this session's scratchpad", () => {
  assert.equal(inScratchpad(`${SP}/notes.md`, "sid-1", ROOTS), true);
  assert.equal(inScratchpad(`${SP}/a/b/c.txt`, "sid-1", ROOTS), true);
  assert.equal(inScratchpad(`${SP}/./x/y.md`, "sid-1", ROOTS), true);
});

test("inScratchpad rejects other sessions, the directory itself, traversal, relative paths and foreign roots", () => {
  assert.equal(inScratchpad("/tmp/claude-1000/-proj/sid-2/scratchpad/x", "sid-1", ROOTS), false);
  assert.equal(inScratchpad(SP, "sid-1", ROOTS), false);
  assert.equal(inScratchpad(`${SP}/`, "sid-1", ROOTS), false);
  assert.equal(inScratchpad(`${SP}/../../../../etc/x`, "sid-1", ROOTS), false);
  assert.equal(inScratchpad(`${SP}/x/../notes.md`, "sid-1", ROOTS), false);
  assert.equal(inScratchpad("scratchpad/x", "sid-1", ROOTS), false);
  assert.equal(inScratchpad("tmp/claude-1000/-proj/sid-1/scratchpad/x", "sid-1", ROOTS), false);
  assert.equal(inScratchpad("", "sid-1", ROOTS), false);
  assert.equal(inScratchpad("/home/u/claude-1000/-proj/sid-1/scratchpad/x", "sid-1", ROOTS), false);
  assert.equal(inScratchpad("/tmp/claude-abc/-proj/sid-1/scratchpad/x", "sid-1", ROOTS), false);
  assert.equal(inScratchpad("/tmp/claude-1000/-proj/sid-1/other/x", "sid-1", ROOTS), false);
  assert.equal(inScratchpad(`${SP}/x`, "", ROOTS), false);
  assert.equal(inScratchpad(`${SP}/x`, "sid-1", []), false);
});

test("inScratchpad honours a custom root with a trailing slash", () => {
  assert.equal(inScratchpad("/var/folders/T/claude-501/-proj/sid-1/scratchpad/x", "sid-1", ["/var/folders/T/", "/tmp"]), true);
  assert.equal(inScratchpad("/var/folders/T/claude-501/-proj/sid-1/scratchpad/x", "sid-1", ["/tmp"]), false);
});

// The estimate_effort decision rule: mechanical -> minEffort, unsure -> defaultEffort, else the calibrated score level within the bounds (no model bias).
const B = { model: "opus", defaultEffort: "high", minEffort: "low", maxEffort: "xhigh" } as const;
const sc = (score: number, confidence = 0.9) => ({ type: "score" as const, score, probabilities: {}, confidence });

test("estimateEffort falls back to the default without a usable score, unclamped", () => {
  assert.deepEqual(estimateEffort(undefined, undefined, B), { effort: "high", source: "fallback" });
  // The effort score's confidence is not checked: a low-confidence score is used.
  assert.deepEqual(estimateEffort(sc(0.2, 0.4), undefined, B), { effort: "low", source: "jev" });
  assert.deepEqual(estimateEffort(undefined, undefined, { ...B, defaultEffort: "max" }), { effort: "max", source: "fallback" });
  assert.deepEqual(estimateEffort(sc(Number.NaN), undefined, B), { effort: "high", source: "fallback" });
});

test("estimateEffort gives a mechanical prompt minEffort, whatever the score", () => {
  assert.deepEqual(estimateEffort(undefined, 0.95, B), { effort: "low", source: "mechanical" });
  assert.deepEqual(estimateEffort(sc(3.5), 0.95, { ...B, minEffort: "medium" }), { effort: "medium", source: "mechanical" });
  // Below MECHANICAL_FROM (0.95) the score decides: 0.9 and 0.8 no longer count.
  assert.deepEqual(estimateEffort(sc(2), 0.9, B), { effort: "high", source: "jev" });
  assert.deepEqual(estimateEffort(sc(2), 0.5, B), { effort: "high", source: "jev" });
});

test("effortLevel puts the cut points on 0.5 / 1.5 / 2.5 / 3.5 and clamps to 0..4", () => {
  const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  [0, 1.05, 1.9, 2.5, 3.1, 4].forEach((s, i) => close(effortLevel(s), [0, 0.5, 1.5, 2.5, 3.5, 4][i]));
  assert.equal(effortLevel(-1), 0);
  assert.equal(effortLevel(9), 4);
});

test("estimateEffort gives every model the same level for the same score", () => {
  for (const model of ["haiku", "sonnet", "opus", "fable"] as const) {
    assert.equal(estimateEffort(sc(1.6), undefined, { ...B, model }).effort, "medium");
    assert.equal(estimateEffort(sc(1.2), undefined, { ...B, model }).effort, "medium");
    assert.equal(estimateEffort(sc(2.2), undefined, { ...B, model }).effort, "high");
  }
});

test("estimateEffort keeps Jev's estimate within minEffort..maxEffort", () => {
  assert.deepEqual(estimateEffort(sc(4), undefined, { ...B, model: "haiku" }), { effort: "xhigh", source: "jev" });
  assert.deepEqual(estimateEffort(sc(0), undefined, { ...B, model: "fable", minEffort: "medium" }), { effort: "medium", source: "jev" });
});

const INPUT = { model: "sonnet", defaultEffort: "high", minEffort: "low", maxEffort: "xhigh", prompt: "add a retry" };

test("parseEstimateInput keeps only the five fields of a valid call", () => {
  assert.deepEqual(parseEstimateInput({ ...INPUT, tool: "mcp__jevfort__estimate_effort", tool_use_id: "toolu_1" }), INPUT);
  assert.deepEqual(parseEstimateInput({ ...INPUT, defaultEffort: "max" }), { ...INPUT, defaultEffort: "max" });
});

test("parseEstimateInput names the first invalid field", () => {
  assert.equal(parseEstimateInput({ ...INPUT, model: "gpt" }), "model must be one of haiku, sonnet, opus, fable");
  assert.equal(parseEstimateInput({ ...INPUT, model: "claude-opus-5-5" }), "model must be one of haiku, sonnet, opus, fable");
  assert.equal(parseEstimateInput({ ...INPUT, defaultEffort: "huge" }), "defaultEffort must be one of low, medium, high, xhigh, max");
  assert.equal(parseEstimateInput({ ...INPUT, minEffort: undefined }), "minEffort must be one of low, medium, high, xhigh, max");
  assert.equal(parseEstimateInput({ ...INPUT, maxEffort: 3 }), "maxEffort must be one of low, medium, high, xhigh, max");
  assert.equal(parseEstimateInput({ ...INPUT, minEffort: "high", maxEffort: "low" }), "minEffort must not be above maxEffort");
  assert.equal(parseEstimateInput({ ...INPUT, prompt: "" }), "prompt must be a non-empty string");
  assert.equal(parseEstimateInput({ ...INPUT, prompt: "  \n " }), "prompt must be a non-empty string");
  assert.equal(parseEstimateInput({ ...INPUT, prompt: 42 }), "prompt must be a non-empty string");
});

test("bounds, modelFamily and isEffort", () => {
  assert.deepEqual(bounds("low", "xhigh"), { minEffort: "low", maxEffort: "xhigh" });
  assert.deepEqual(bounds("high", "high"), { minEffort: "high", maxEffort: "high" });
  assert.equal(bounds("high", "low"), undefined);
  assert.equal(bounds("huge", "max"), undefined);
  assert.equal(bounds(undefined, "max"), undefined);
  assert.equal(modelFamily("claude-opus-5-5"), "opus");
  assert.equal(modelFamily("claude-fable-5"), "fable");
  assert.equal(modelFamily("claude-haiku-5-5"), "haiku");
  assert.equal(modelFamily("sonnet"), "sonnet");
  assert.equal(modelFamily("x"), undefined);
  assert.equal(isEffort("xhigh"), true);
  assert.equal(isEffort("extra"), false);
  assert.equal(isEffort(undefined), false);
});

// The jev-api tools take `instructions` as one string and choice criteria as option -> description strings.
test("nextActionQuestion has string instructions and one string criterion per option", () => {
  const q = nextActionQuestion([{ key: "read a.ts", description: "Read the file a.ts", tool: "Read", input: { file_path: "/proj/a.ts" } }]);
  assert.equal(q.type, "choice");
  assert.equal(typeof q.instructions, "string");
  assert.match(q.instructions, /^An AI coding assistant is working on the user request in `request`; .* pick claude\.$/);
  assert.deepEqual(Object.keys(q.criteria), ["claude", "read a.ts"]);
  assert.equal(q.criteria["read a.ts"], "Read the file a.ts");
});

test("lowerModel only lowers the model: a cheaper tier passes, an equal, higher, unknown or missing one does not", () => {
  assert.equal(lowerModel("claude-opus-5-5", "claude-haiku-5-5"), "claude-haiku-5-5");
  assert.equal(lowerModel("claude-opus-5-5", "claude-sonnet-5-5"), "claude-sonnet-5-5");
  assert.equal(lowerModel("claude-fable-5", "claude-sonnet-5-5"), "claude-sonnet-5-5");
  assert.equal(lowerModel("claude-fable-5", "claude-opus-5-5"), undefined);
  assert.equal(lowerModel("claude-haiku-5-5", "claude-sonnet-5-5"), undefined);
  assert.equal(lowerModel("claude-sonnet-5-5", "claude-sonnet-5-5"), undefined);
  assert.equal(lowerModel("some-model", "claude-haiku-5-5"), undefined);
  assert.equal(lowerModel("claude-opus-5-5", undefined), undefined);
});

test("bestAction: most likely non-claude option, undefined when only claude or no answer", () => {
  assert.deepEqual(bestAction({ type: "choice", choice: "claude", probabilities: { claude: 0.7, "read a": 0.1, "run:npm test": 0.2 }, confidence: 0.9 }), { key: "run:npm test", p: 0.2 });
  assert.equal(bestAction({ type: "choice", choice: "claude", probabilities: { claude: 1 }, confidence: 1 }), undefined);
  assert.equal(bestAction(undefined), undefined);
});

test("route and shouldContinue cut points: HIGH_FROM and MIN_CONFIDENCE are inclusive, LOW_BELOW and the done threshold exclusive", () => {
  const rated = (score: number, confidence = 0.9) => ({ type: "score" as const, score, probabilities: {}, confidence });
  assert.deepEqual(route(rated(1.8, 0.5), "model"), { level: 1.8 });
  assert.deepEqual(route(rated(1.0), "model"), { level: 1, model: "claude-sonnet-5-5" });
  assert.equal(route(rated(0.99), "model")?.model, "claude-haiku-5-5");
  assert.equal(route(rated(1.8, 0.49), "model"), undefined);
  assert.equal(shouldContinue(0.15, 0.15), false);
  assert.equal(shouldContinue(0.149, 0.15), true);
  assert.equal(shouldContinue(undefined), false);
});
