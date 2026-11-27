// Runs under `claude plugin test` via development/scripts/plugin-test.ts (`pnpm --filter taskflow test:plugin`), on a temp
// copy of the built plugin/. Imports the engine's own kit, not vitest (development/wiki/decisions/test-layers.md).
// Covers what only the built register.js shows: it loads and passes the static check, session.start registers the tool,
// tool.call answers it through jev-api's tool and through the model. jev-api and the model are stubs.
import { expect, mock, test } from "claude-code/testing";

/** The test's `on`, taken from the kit's own types. */
type On = Parameters<typeof mock.clock>[0];

const SIZE_TASK = "mcp__taskflow__size-task";
const JEV_REQUEST = "mcp__jev-api__request";

/** jev-api's result text for one choice answer. */
const answer = (choice: string, p: number) => JSON.stringify([{ type: "choice", choice, confidence: p / 2, probabilities: { S: 0, M: 0, L: 0, XL: 0, [choice]: p } }]);

/**
 * Stubs every engine call of the module. One call per test, before the first `$` call.
 *
 * @param on - The test's `on`.
 * @param jev - What jev-api's tool answers.
 * @param model - What the plain model answers.
 * @returns The bare names registered and the models asked.
 */
function world(on: On, jev: string, model = "L") {
  const registered: string[] = [];
  const models: string[] = [];
  mock.clock(on);
  on("ui.log", () => ({ value: undefined }));
  on("tool.register", (_$, e) => {
    registered.push(String(e.name));
    return { value: { tool: `mcp__taskflow__${String(e.name)}` } };
  });
  on("model.complete", (_$, e) => {
    models.push(String(e.model));
    return { value: { isAnswered: true, text: model, usage: { input_tokens: 1, output_tokens: 1 } } };
  });
  on("session.start", async () => ({ cwd: "/proj" }));
  on("tool.call", (_$, e) => ({ result: e.tool === JEV_REQUEST ? jev : "tool output" }));
  // allow, not ask: a test's own $.tool.call passes tool.check first, and ask denies it (no user to ask)
  on("tool.check", () => ({ decision: "allow" }));
  return { registered, models };
}

test("the built mod loads and session.start registers the size-task tool (session.start)", async ($, on) => {
  const { registered } = world(on, answer("M", 0.9));
  await $.session.start({ source: "startup", cwd: "/proj" });
  expect(registered).toEqual(["size-task"]);
});

test("a confident jev-api answer is the size, the model is not asked (tool.call)", async ($, on) => {
  const { models } = world(on, answer("XL", 0.9));
  await $.session.start({ source: "startup", cwd: "/proj" });
  const r = (await $.tool.call({ tool: SIZE_TASK, task: "Move every plugin to a new build", subsystems: ["root - config"] })) as { result?: string; deny?: string };
  expect(r.deny).toBeUndefined();
  expect(r.result).toBe("XL (jev-api, probability 0.90)");
  expect(models).toEqual([]);
});

test("an unsure jev-api answer goes to the model (tool.call)", async ($, on) => {
  const { models } = world(on, answer("M", 0.3), "L");
  await $.session.start({ source: "startup", cwd: "/proj" });
  const r = (await $.tool.call({ tool: SIZE_TASK, task: "Port a plugin" })) as { result?: string };
  expect(r.result).toMatch(/^L \(model claude-opus-5-5; jev-api was unsure: M at probability 0.30\)$/);
  expect(models).toEqual(["claude-opus-5-5"]);
});

test("an invalid call is refused (tool.call)", async ($, on) => {
  world(on, answer("S", 0.9));
  await $.session.start({ source: "startup", cwd: "/proj" });
  expect(JSON.stringify(await $.tool.call({ tool: SIZE_TASK, task: " " }))).toContain("size-task: task must be a non-blank string");
});

test("a call of another tool passes through the built mod unchanged (tool.call)", async ($, on) => {
  world(on, answer("S", 0.9));
  await $.session.start({ source: "startup", cwd: "/proj" });
  expect(JSON.stringify(await $.tool.call({ tool: "Bash", command: "ls" }))).toContain("tool output");
});
