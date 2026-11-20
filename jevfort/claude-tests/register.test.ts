// Runs under `claude plugin test` via development/scripts/plugin-test.ts (`pnpm --filter jevfort test:plugin`), on a temp
// copy of the built plugin/. Imports the engine's own kit, not vitest (development/wiki/decisions/test-layers.md).
// Together the tests fire all events the built register.js registers: session.start, session.end, session.compact,
// turn.complete, turn.step, tool.call (unmatched and { tool: "Agent" }), tool.check, agent.offer and ui.render.
import { expect, mock, test } from "claude-code/testing";
import { NEUTRAL, questionId, REQUEST_TOOL } from "./world.js";

/** The test's `on`, taken from the kit's own types. */
type On = Parameters<typeof mock.clock>[0];
/** One question of a request call as the fake Jev sees it. */
type Asked = { type: string; instructions: string };

/** The session's working directory. */
const CWD = "/proj";
/** The `session.start` input. */
const START = { source: "startup", cwd: CWD, surface: "terminal", isInteractive: true };
/** A main-loop step 0. */
const STEP = { turnId: "t1", index: 0, model: "claude-opus-5-5", effort: "high", messageCount: 1 };
/** The band above the prompt as the terminal raises it. */
const BAND = { plugin: "jevfort", component: "AbovePrompt", props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80 }, surface: "terminal" };

/**
 * Stubs every engine call of the module (a subset of tests/support/kit.ts `setupWith`). One call per test, before the first `$` call.
 *
 * @param on - The test's `on`.
 * @param jev - The fake Jev: the answer of one question, or undefined for the neutral answer.
 * @returns What the stubs beneath the mod saw, and the fake clock.
 */
function world(on: On, jev: (q: Asked) => Record<string, unknown> | undefined = () => undefined) {
  const asked: string[] = [];
  const agentTypes: unknown[] = [];
  const ended: unknown[] = [];
  mock.env(on, {});
  mock.store(on, {});
  const clock = mock.clock(on);
  on("session.messages", () => ({ value: [{ role: "user", text: "what does this project do?", toolUses: [] }] }));
  on("session.cwd", () => ({ value: CWD }));
  on("session.id", () => ({ value: "sid-1" }));
  on("session.usage", () => ({ value: { context: { percent: 0 } } }));
  on("fs.exists", () => ({ value: false }));
  on("fs.stat", () => ({ deny: "ENOENT" }));
  on("fs.read", () => ({ deny: "ENOENT" }));
  on("ui.log", () => ({ value: undefined }));
  on("ui.status", () => ({ value: undefined }));
  on("command.list", () => ({ value: [] }));
  on("model.complete", () => ({ value: { isAnswered: false, reason: "no model in this test" } }));
  on("tool.list", () => ({ value: [{ name: REQUEST_TOOL, description: "Ask Jev several questions", mcp: true }] }));
  on("tool.call", (_$, e) => {
    if (e.tool === "Agent") agentTypes.push(e.subagent_type);
    if (e.tool !== REQUEST_TOOL) return { result: "tool output" };
    const questions = e.questions as Asked[];
    asked.push(...questions.map((q) => questionId(q.instructions) ?? q.instructions));
    return { result: JSON.stringify(questions.map((q) => jev(q) ?? NEUTRAL[q.type])) };
  });
  // the official kit checks every `$.tool.call` (the test's and the mod's) through tool.check: only the tool.check test's call gets "ask"
  on("tool.check", (_$, e) => ({ decision: e.tool_use_id === "toolu_claude" ? "ask" : "allow" }));
  on("agent.offer", () => ({ isOffered: true }));
  on("session.start", async () => ({ cwd: CWD }));
  on("session.end", async () => ({ sessionId: "sid-1" }));
  on("session.compact", async () => ({ messages: [{ role: "user", text: "summary", toolUses: [] }] }));
  on("turn.complete", (_$, e) => {
    ended.push(e.turnId);
    return { text: "" };
  });
  on("turn.step", async function*(_$, e) {
    yield { kind: "text", index: 0, text: "from claude" };
    yield { kind: "stop", stopReason: "end_turn", usage: null };
    return { turnId: e.turnId, index: e.index, answer: "from claude", toolUses: [], stopReason: "end_turn", usage: null };
  });
  return { asked, agentTypes, ended, clock };
}

/**
 * Reads a step's stream to its end.
 *
 * @param stream - The stream `$.turn.step` returns.
 * @returns The step's result.
 */
async function drain(stream: AsyncGenerator<unknown, unknown>): Promise<unknown> {
  for (;;) {
    const n = await stream.next();
    if (n.done) return n.value;
  }
}

/**
 * The label of the band's Jevfort button of a fresh mount.
 *
 * @param $ - The test's `$`.
 * @returns The label, or undefined when the effort row is not drawn.
 */
async function autoLabel($: Parameters<Parameters<typeof test>[2]>[0]): Promise<unknown> {
  return (await (await $.ui.mount(BAND)).find({ type: "Button", key: "auto" }))?.props.label;
}

test("the built mod loads; after session.start the band draws the effort row with the Jevfort button (session.start, ui.render)", async ($, on) => {
  world(on);
  await $.session.start(START);
  expect(String(await autoLabel($))).toContain("Jevfort ✔️");
});

test("session.end switches Jevfort back on after it was switched off in the band (session.end)", async ($, on) => {
  const { clock } = world(on);
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);
  await ui.press({ key: "auto" });
  await clock.settle();
  expect(String(await autoLabel($))).toContain("✖️");
  await $.session.end({ reason: "clear" });
  expect(String(await autoLabel($))).toContain("✔️");
});

test("step 0 asks Jev for the turn's effort and the step runs on Claude beneath (turn.step)", async ($, on) => {
  const { asked } = world(on);
  await $.session.start(START);
  const result = (await drain($.turn.step(STEP))) as { answer?: string };
  expect(result.answer).toBe("from claude");
  expect(asked).toContain("effort");
});

test("a turn's end passes through to the hook beneath (turn.complete)", async ($, on) => {
  const { ended } = world(on);
  await $.session.start(START);
  await $.turn.complete({ turnId: "t1", reason: "answer", answer: "Done.", durationMs: 1, isAborted: false });
  expect(ended).toEqual(["t1"]);
});

test("a tool call that is not Jev's own passes through unchanged (tool.call)", async ($, on) => {
  world(on);
  await $.session.start(START);
  expect(JSON.stringify(await $.tool.call({ tool: "Bash", command: "ls", tool_use_id: "toolu_1" }))).toContain("tool output");
});

test("a general-purpose Agent call runs as the offered type Jev picks (agent.offer, tool.call { tool: Agent })", async ($, on) => {
  const { agentTypes } = world(on, (q) => (q.type === "choice" ? { type: "choice", choice: "Explore", probabilities: { Explore: 0.92, "general-purpose": 0.08 }, confidence: 0.85 } : undefined));
  await $.session.start(START);
  await $.agent.offer({ agent: "general-purpose", description: "General tasks", source: "built-in" });
  await $.agent.offer({ agent: "Explore", description: "Read-only codebase search", source: "built-in" });
  await $.tool.call({ tool: "Agent", description: "find usages", prompt: "Find every caller of addTodo", tool_use_id: "a1" });
  expect(agentTypes).toEqual(["Explore"]);
});

test("a permission verdict for a call that is not Jev's own stays Claude Code's (tool.check)", async ($, on) => {
  world(on);
  await $.session.start(START);
  const r = (await $.tool.check({ tool: "Bash", input: { command: "npm test" }, tool_use_id: "toolu_claude" })) as { decision?: string };
  expect(r.decision).toBe("ask");
});

test("a compaction falls through to Claude Code's own when Haiku does not answer (session.compact)", async ($, on) => {
  world(on);
  await $.session.start(START);
  const r = (await $.session.compact({ trigger: "manual", messages: [{ role: "user", text: "fix the date bug", toolUses: [] }, { role: "assistant", text: "on it", toolUses: [] }], instructions: "" })) as { messages?: { text: string }[] };
  expect(r.messages?.[0]?.text).toBe("summary");
});
