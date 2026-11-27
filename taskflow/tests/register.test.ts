// Kit tests for src/hooks/register.ts of taskflow: the size-task tool (jev-api first, then a plain model).
import type { On } from "claude-engine-vitest";
import { expect } from "vitest";
import { FALLBACK_MODEL } from "../src/hooks/size.ts";
import { JEV_REQUEST, jevAnswer, mock, SIZE_TASK, test } from "./support/size-kit.ts";
import type { Runner } from "./support/size-kit.ts";

type Jev = { result: string } | { deny: string };
type Model = { value: { isAnswered: true; text: string; usage: Record<string, number> } } | { value: { isAnswered: false; reason: string } };

const said = (text: string): Model => ({ value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1 } } });
const failed: Model = { value: { isAnswered: false, reason: "boom" } };

/** Stubs every `$` op the module uses; `jev` answers jev-api's tool, `model` the plain model call. Records what was asked. */
function setup(on: On, opts: { jev?: Jev; model?: Model } = {}) {
  const specs: Record<string, unknown>[] = [];
  const jevCalls: Record<string, unknown>[] = [];
  const asked: Record<string, unknown>[] = [];
  mock.clock(on);
  on("tool.register", async (_$, e) => {
    specs.push(e);
    return { value: { tool: SIZE_TASK } };
  });
  on("tool.call", (_$, e) => {
    // The kit resolves a mod's $.tool.call to the stub's `value`; a bare `{ deny }` would reject (the real engine resolves it)
    if (e.tool !== JEV_REQUEST) return { value: { result: "other" } };
    jevCalls.push(e);
    return { value: opts.jev ?? { deny: "request: not installed" } };
  });
  on("tool.check", () => ({ decision: "allow" }));
  on("model.complete", (_$, e) => {
    asked.push(e);
    return opts.model ?? failed;
  });
  on("ui.log", () => ({ value: undefined }));
  on("session.start", async (_$, e) => ({ cwd: e.cwd }));
  return { specs, jevCalls, asked };
}

const size = async ($: Runner, input: Record<string, unknown> = { task: "Fix a typo in the README." }) => (await $.tool.call({ tool: SIZE_TASK, ...input })) as { result?: string; deny?: string };

test("session.start registers size-task deferred, with task required", async ($, on) => {
  const { specs } = setup(on);
  await $.session.start({ cwd: "/proj", surface: "terminal", isInteractive: true });
  expect(specs.map((s) => s.name)).toEqual(["size-task"]);
  expect(specs[0]).toMatchObject({ isDeferred: true, inputSchema: { type: "object", required: ["task"] } });
});

test("a call before session.start registers the tool and answers", async ($, on) => {
  const { specs } = setup(on, { jev: { result: jevAnswer("S", 0.9) } });
  expect((await size($)).result).toMatch(/^S /);
  expect(specs).toHaveLength(1);
});

test("a confident jev-api answer is the size, with its probability, and the model is not asked", async ($, on) => {
  const { jevCalls, asked } = setup(on, { jev: { result: jevAnswer("L", 0.8) } });
  expect((await size($, { task: "Port a plugin", subsystems: ["a - b"] })).result).toBe("L (jev-api, probability 0.80)");
  expect(asked).toHaveLength(0);
  expect(jevCalls[0]).toMatchObject({ state: "Port a plugin\na - b" });
  const q = (jevCalls[0] as { questions: Record<string, unknown>[] }).questions;
  expect(q).toHaveLength(1);
  expect(q[0]).toMatchObject({ type: "choice", criteria: { S: expect.stringContaining("one single edit"), XL: expect.stringContaining("repository-wide") } });
});

test("the threshold: probability 0.5 is taken, just below it goes to the model", async ($, on) => {
  setup(on, { jev: { result: jevAnswer("M", 0.5) }, model: said("L") });
  expect((await size($)).result).toBe("M (jev-api, probability 0.50)");
});

test("a probability below 0.5 goes to the model, whose letter is the size and which sees the task and descriptions", async ($, on) => {
  const { asked } = setup(on, { jev: { result: jevAnswer("M", 0.49) }, model: said("L\n") });
  const r = await size($, { task: "Rework the build" });
  expect(r.result).toBe(`L (model ${FALLBACK_MODEL}; jev-api was unsure: M at probability 0.49)`);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({ model: FALLBACK_MODEL });
  expect(String(asked[0]["prompt"])).toContain("Rework the build");
  expect(String(asked[0]["prompt"])).toContain("XL: repository-wide");
});

for (const [name, jev] of [["a refusal", { deny: "request: HTTP 500" }], ["a result that is no choice answer", { result: "[]" }], ["a result that is not json", { result: "oops" }]] as const) {
  test(`${name} from jev-api goes to the model`, async ($, on) => {
    setup(on, { jev, model: said("XL") });
    expect((await size($)).result).toBe(`XL (model ${FALLBACK_MODEL}; jev-api gave no answer)`);
  });
}

test("when the model fails too, jev-api's unsure answer is still the size", async ($, on) => {
  setup(on, { jev: { result: jevAnswer("M", 0.4) }, model: failed });
  expect((await size($)).result).toBe("M (jev-api, probability 0.40 below 0.5; the model call failed)");
});

test("a model reply that is no size counts as a failure", async ($, on) => {
  setup(on, { jev: { result: jevAnswer("L", 0.3) }, model: said("It depends") });
  expect((await size($)).result).toMatch(/^L \(jev-api, probability 0.30 below/);
});

test("nothing answered: a refusal naming the tool", async ($, on) => {
  setup(on, { model: failed });
  expect((await size($)).deny).toBe("size-task: neither jev-api nor the model gave a size");
});

for (const input of [{}, { task: " " }, { task: "x", subsystems: "a" }]) {
  test(`invalid input ${JSON.stringify(input)} is refused before anything is asked`, async ($, on) => {
    const { jevCalls, asked } = setup(on, { jev: { result: jevAnswer("S", 0.9) } });
    expect((await size($, input)).deny).toMatch(/^size-task: /);
    expect(jevCalls).toHaveLength(0);
    expect(asked).toHaveLength(0);
  });
}

test("another plugin's tool call goes on untouched", async ($, on) => {
  const { jevCalls, asked } = setup(on);
  expect(await $.tool.call({ tool: "mcp__other__tool" })).toMatchObject({ value: { result: "other" } });
  expect(jevCalls).toHaveLength(0);
  expect(asked).toHaveLength(0);
});

test("a refused registration is retried once at once, then backs off instead of retrying on every call", async ($, on) => {
  let attempts = 0;
  mock.clock(on);
  on("tool.register", async () => {
    attempts++;
    throw new Error("session not bound");
  });
  on("tool.call", (_$, e) => (e.tool === JEV_REQUEST ? { value: { deny: "request: not installed" } } : { value: { result: "other" } }));
  on("tool.check", () => ({ decision: "allow" }));
  on("model.complete", () => ({ value: { isAnswered: false, reason: "boom" } }));
  on("ui.log", () => ({ value: undefined }));
  on("session.start", async (_$, e) => ({ cwd: e.cwd }));
  for (let i = 0; i < 4; i++) await size($);
  expect(attempts).toBe(2);
});
