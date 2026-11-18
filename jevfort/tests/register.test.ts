// Hook-wiring tests for the built plugin/hooks/register.mjs: a port of upstream jev-pilot's tests/pilot.test.ts onto
// claude-engine-vitest (types dropped, `expect` from vitest, `test`/`mock` from createKit). Upstream's "shadow mode
// logs a take but lets Claude act" is gone with the mode; its shadow compare test runs on the measure path instead.
// Jev is the jev-api plugin's request tool: a fake `tool.call` answers `mcp__jev-api__request` question by question.
import type { On } from "claude-engine-vitest";
import { expect } from "vitest";
/** jev-api's request tool, the name jevfort asks Jev through. */
const JEV_BATCH = "mcp__jev-api__request";
import { answered, type Asked, autoLabel, BAND, BENEATH, byId, claudeBeneath, CWD, decision, DEFAULTS, drain, easy, followUps, ids, inOrder, JEV_TOOLS, levelProps, makeKit, mech, Msg, Runner, scored, sessionStubs, SetupOpts, setupWith, SID, SINGLE_TOOLS, START, stateOf, step, toolId, user } from "./support/kit.ts";

const { test, mock } = makeKit(DEFAULTS);
/** `setup` of this file: the kit's mock bound to the test's `on`. */
const setup = (on: On, opts: SetupOpts) => setupWith(mock, on, opts);

test("Jev takes a confident Read step without asking Claude", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  const seen: unknown[] = [];
  setup(on, {
    messages: [user("what does src/app.ts export?")],
    files: [`${CWD}/src/app.ts`],
    jev: byId({
      next_action: { type: "choice", choice: "read src/app.ts", probabilities: { "read src/app.ts": 0.95, claude: 0.05 }, confidence: 0.9 },
    }),
  });
  claudeBeneath(on, seen);

  const { chunks } = await drain($.turn.step(step));
  expect(seen).toHaveLength(0);
  expect(chunks).toContainEqual(expect.objectContaining({ kind: "tool", name: "Read" }));
  expect(chunks).toContainEqual({ kind: "input", index: 0, json: JSON.stringify({ file_path: `${CWD}/src/app.ts` }) });
});

test("An unsure Jev hands the step to Claude, with effort lowered for an easy turn", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  const seen: unknown[] = [];
  setup(on, {
    messages: [user("what does src/app.ts export?")],
    files: [`${CWD}/src/app.ts`],
    jev: byId({
      next_action: { type: "choice", choice: "read src/app.ts", probabilities: { "read src/app.ts": 0.6, claude: 0.4 }, confidence: 0.3 },
      effort: easy,
    }),
  });
  claudeBeneath(on, seen);

  await drain($.turn.step(step));
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ effort: "low", model: "claude-opus-5-5" });
});

test("takeSteps: false never offers Jev a next action, so a confident Read goes to Claude", { options: { takeOnlyForBypass: false, takeSteps: false } }, async ($, on) => {
  const seen: unknown[] = [];
  const { sent } = setup(on, {
    messages: [user("what does src/app.ts export?")],
    files: [`${CWD}/src/app.ts`],
    jev: byId({ next_action: { type: "choice", choice: "read src/app.ts", probabilities: { "read src/app.ts": 0.95, claude: 0.05 }, confidence: 0.9 } }),
  });
  claudeBeneath(on, seen);

  const { chunks } = await drain($.turn.step(step));
  expect(ids(sent)).not.toContain("next_action");
  expect(seen).toHaveLength(1);
  expect(toolId(chunks)).toBe("");
});

test("subagents: false leaves a subagent step to Claude without asking Jev", { options: { subagents: false } }, async ($, on) => {
  const seen: unknown[] = [];
  const { calls } = setup(on, { messages: [user("what does this project do?")], jev: byId({ effort: easy }) });
  claudeBeneath(on, seen);

  await drain($.turn.step({ ...step, agentId: "a1" }));
  expect(calls()).toBe(0);
  expect(seen[0]).toMatchObject({ effort: "high", model: "claude-opus-5-5" });
});

test("When Jev is unreachable the step goes to Claude unchanged", async ($, on) => {
  const seen: unknown[] = [];
  setup(on, { messages: [user("what does src/app.ts export?")], files: [`${CWD}/src/app.ts`], jev: () => 401 });
  claudeBeneath(on, seen);

  const { chunks } = await drain($.turn.step(step));
  expect(seen[0]).toMatchObject({ effort: "high", model: "claude-opus-5-5" });
  expect(chunks).toContainEqual({ kind: "text", index: 0, text: "from claude" });
});

// askJev: all questions of a decision go out in one jev-api request call; `state` travels as JSON text.
test("A turn-start decision sends its questions in one jev-api request call", async ($, on) => {
  const { sent, calls } = setup(on, { messages: [user("what does src/app.ts export?")], files: [`${CWD}/src/app.ts`], jev: () => undefined, env: { TYPESAFE_API_KEY: "k" } });
  claudeBeneath(on, []);

  await drain($.turn.step(step));
  expect(calls()).toBe(1);
  // Every interactive jev-api call gives jev-api an HTTP timeout equal to the 4 s askJev budget (14 s while Haiku answers because no Jev variable is set).
  expect(sent.every((q) => q.timeout === 4)).toBe(true);
  expect(sent.map((q) => [q.id, q.type])).toEqual([
    ["next_action", "choice"],
    ["effort", "score"],
    ["mechanical", "noul"],
    ["single_action", "noul"],
  ]);
  for (let i = 0; i < sent.length; i++) expect(stateOf(sent, i).request).toBe("what does src/app.ts export?");
  expect(sent[0].instructions.startsWith("An AI coding assistant is working on the user request in `request`")).toBe(true);
  expect(Object.keys(sent[0].criteria as object)).toEqual(["claude", "read src/app.ts"]);
  expect((sent[1].criteria as string[]).map((c) => c.split(":")[0])).toEqual(["Low", "Medium", "High", "Extra high", "Max"]);
});

test("A jev-api deny leaves the step to Claude and is logged with its text", async ($, on) => {
  const seen: unknown[] = [];
  setup(on, { messages: [user("what does this project do?")], jev: () => 503 });
  claudeBeneath(on, seen);

  await drain($.turn.step(step));
  expect(seen[0]).toMatchObject({ effort: "high", model: "claude-opus-5-5" });
});

test("jevfort writes no status line: a failed decision, an estimate and a take say nothing in `$.ui.status`", async ($, on) => {
  const said: unknown[] = [];
  // Ahead of setup's stub, so it sees every call.
  on("ui.status", (_$, e) => (said.push(e.text), { value: undefined }));
  setup(on, { messages: [user("what does this project do?")], jev: () => 503 });
  claudeBeneath(on, []);
  await drain($.turn.step(step));
  expect(said).toEqual([]);
});

test("One wrong answer discards the other answers of the same decision", async ($, on) => {
  const seen: unknown[] = [];
  // The easy effort score alone would lower the turn to low; the score answered for `mechanical` voids it.
  setup(on, { messages: [user("what does this project do?")], jev: (q) => (q.id === "mechanical" ? easy : scored(0.2)) });
  claudeBeneath(on, seen);

  await drain($.turn.step(step));
  expect(seen[0]).toMatchObject({ effort: "high" });
});

// One malformed answer per case, every other answer valid, so only the field under test can fail the decision.
const choiceOk = { type: "choice", choice: "claude", probabilities: { claude: 1 }, confidence: 0.9 };
for (
  const [name, id, answer, _error] of [
    ["a choice without probabilities", "next_action", { type: "choice", choice: "claude", confidence: 0.9 }, "no valid choice answer for questions[0]"],
    ["a choice with a non-finite probability", "next_action", { ...choiceOk, probabilities: { claude: "1" } }, "no valid choice answer for questions[0]"],
    ["a choice without confidence", "next_action", { type: "choice", choice: "claude", probabilities: { claude: 1 } }, "no valid choice answer for questions[0]"],
    ["a choice whose choice is not text", "next_action", { ...choiceOk, choice: 5 }, "no valid choice answer for questions[0]"],
    ["a score whose score is not a number", "effort", { type: "score", score: "x", probabilities: {}, confidence: 0.9 }, "no valid score answer for questions[1]"],
    ["a noul given as text", "mechanical", { type: "noul", noul: "1" }, "no valid noul answer for questions[2]"],
  ] as const
) {
  test(`An answer with ${name} fails the decision instead of crashing a hook`, async ($, on) => {
    const seen: unknown[] = [];
    // Each would throw inside the hooks (pickCandidate) or read "1" as >= 0.95.
    // A readable file makes step 0 ask next_action (questions[0]) ahead of effort and mechanical.
    setup(on, { messages: [user("what does src/app.ts export?")], files: [`${CWD}/src/app.ts`], jev: (q) => (q.id === id ? answer : q.id === "effort" ? scored(0.2) : undefined) });
    claudeBeneath(on, seen);

    await drain($.turn.step(step));
    expect(seen[0]).toMatchObject({ effort: "high" });
  });
}

test("Core's error result for the request call fails the decision with a request: prefix", async ($, on) => {
  const seen: unknown[] = [];
  // Ahead of setup's fake: what core answers when jev-api's hook was skipped and no hook answered its tool.
  const error = "Error: jev-api registered the tool request but no tool.call hook answered this call";
  on("tool.call", (_$, e, next) => (e.tool === JEV_BATCH ? { value: { isError: true, result: error, text: error } } : next(e)));
  setup(on, { messages: [user("what does this project do?")], jev: () => undefined });
  claudeBeneath(on, seen);

  await drain($.turn.step(step));
  expect(seen[0]).toMatchObject({ effort: "high" });
});

for (const [name, answer, _error] of [["of another type", mech(0.5), "request: no valid score answer for questions[0]"], ["that is not JSON", "<html>", "request: result is not JSON"], ["with too few answers", "[]", "request: expected 2 answers"]] as const) {
  test(`A jev-api result ${name} fails the decision`, async ($, on) => {
    const seen: unknown[] = [];
    setup(on, { messages: [user("what does this project do?")], jev: (q) => (q.id === "effort" ? answer : undefined) });
    claudeBeneath(on, seen);

    await drain($.turn.step(step));
    expect(seen[0]).toMatchObject({ effort: "high" });
  });
}

test("An answered Jev call leaves no budget timer pending", async ($, on) => {
  let started = 0;
  let cancelled = 0;
  on("clock.after", (_$, e, next) => {
    started++;
    next.signal.addEventListener("abort", () => cancelled++, { once: true });
    return next(e);
  });
  const { clock } = setup(on, { messages: [user("what does this project do?")], jev: () => undefined, env: { TYPESAFE_API_KEY: "k" } });
  claudeBeneath(on, []);

  await drain($.turn.step(step));
  await clock.advance(0);
  expect(started).toBeGreaterThan(0);
  expect(cancelled).toBe(started);
});

test("Jev calls that do not answer within 4000 ms time out and Claude takes the step", async ($, on) => {
  const seen: unknown[] = [];
  const { sent, clock } = setup(on, { messages: [user("what does this project do?")], jev: () => new Promise<never>(() => {}), env: { JEV_URL: "https://jev.example/x" } });
  claudeBeneath(on, seen);

  const run = drain($.turn.step(step));
  // The module loads by dynamic import (file I/O), which one settle does not wait for: flush until both questions are out.
  while (sent.length < 2) await clock.advance(0);
  await clock.advance(3999);
  expect(seen).toHaveLength(0);
  await clock.advance(1);
  await run;
  expect(ids(sent)).toEqual(["effort", "mechanical"]);
  expect(seen[0]).toMatchObject({ effort: "high", model: "claude-opus-5-5" });
});

test("After a timeout Jev is not asked again for 30 s, then once more", async ($, on) => {
  const seen: unknown[] = [];
  const { clock, calls } = setup(on, { messages: [user("what does this project do?")], jev: () => new Promise<never>(() => {}), env: { JEV_URL: "https://jev.example/x" } });
  claudeBeneath(on, seen);
  let run = drain($.turn.step(step));
  while (calls() < 1) await clock.advance(0);
  await clock.advance(4000);
  await run;
  expect(calls()).toBe(1);
  // Within the pause nothing is sent.
  await drain($.turn.step(step));
  expect(calls()).toBe(1);
  // After it, one probe goes out.
  await clock.advance(30_000);
  run = drain($.turn.step(step));
  while (calls() < 2) await clock.advance(0);
  await clock.advance(4000);
  await run;
  expect(calls()).toBe(2);
});

test("A second timeout doubles the pause to 60 s and a success resets it", async ($, on) => {
  let hang = true;
  const { clock, calls } = setup(on, { messages: [], jev: () => (hang ? new Promise<never>(() => {}) : undefined), env: { JEV_URL: "https://jev.example/x" } });
  const timeoutAt = async (n: number) => {
    const p = $.tool.call({ ...ESTIMATE });
    while (calls() < n) await clock.advance(0);
    await clock.advance(4000);
    await p;
  };
  const sentAfter = async (wait: number) => {
    const before = calls();
    await clock.advance(wait);
    const p = $.tool.call({ ...ESTIMATE });
    for (let i = 0; i < 20; i++) await clock.advance(0);
    const sent = calls() > before;
    if (sent && hang) await clock.advance(4000);
    await p;
    return sent;
  };
  await timeoutAt(1); // pause 30 s
  await clock.advance(30_000);
  await timeoutAt(2); // the probe times out too: the pause doubles to 60 s
  expect(await sentAfter(31_000)).toBe(false);
  hang = false;
  expect(await sentAfter(30_000)).toBe(true); // 61 s after: sent, answered, resets the pause
  hang = true;
  await timeoutAt(4); // the first timeout after a success pauses 30 s again
  expect(await sentAfter(31_000)).toBe(true);
});

test("Further timeouts double the pause up to 10 min and no further", async ($, on) => {
  const { clock, calls } = setup(on, { messages: [], jev: () => new Promise<never>(() => {}), env: { JEV_URL: "https://jev.example/x" } });
  const timeoutAt = async (n: number) => {
    const p = $.tool.call({ ...ESTIMATE });
    // The first call waits out the module's dynamic import (file I/O), which no settle count bounds.
    for (let i = 0; n === 1 ? calls() < n : i < 1000 && calls() < n; i++) await clock.advance(0);
    expect(calls()).toBe(n);
    await clock.advance(4000);
    await p;
  };
  // Pauses 30, 60, 120, 240, 480 s, then capped at 600 s twice.
  await timeoutAt(1);
  for (const [n, pause] of [[2, 30_000], [3, 60_000], [4, 120_000], [5, 240_000], [6, 480_000], [7, 600_000]] as const) {
    await clock.advance(pause - 1000);
    await $.tool.call({ ...ESTIMATE });
    expect(calls()).toBe(n - 1); // still paused 1 s before the end
    await clock.advance(1000);
    await timeoutAt(n);
  }
  await clock.advance(599_000);
  await $.tool.call({ ...ESTIMATE });
  expect(calls()).toBe(7);
  await clock.advance(1000);
  await timeoutAt(8);
  expect(calls()).toBe(8);
});

test("Parallel calls that time out in one outage lengthen the pause once", async ($, on) => {
  const { clock, calls } = setup(on, { messages: [], jev: () => new Promise<never>(() => {}), env: { JEV_URL: "https://jev.example/x" } });
  const estimates = [$.tool.call({ ...ESTIMATE }), $.tool.call({ ...ESTIMATE })];
  while (calls() < 2) await clock.advance(0);
  await clock.advance(4000);
  await Promise.all(estimates);
  // One 30 s pause, not 30 s doubled by the second timeout: 31 s later a call goes out again.
  await clock.advance(31_000);
  const again = $.tool.call({ ...ESTIMATE });
  while (calls() < 3) await clock.advance(0);
  await clock.advance(4000);
  await again;
  expect(calls()).toBe(3);
});

test("A clock that reads earlier than the last timeout ends the pause (a new session)", async ($, on) => {
  const back = { at: -1 };
  on("clock.now", (_$, e, next) => (back.at < 0 ? next(e) : { value: back.at }));
  let hang = true;
  const { clock, calls } = setup(on, { messages: [], jev: () => (hang ? new Promise<never>(() => {}) : undefined), env: { JEV_URL: "https://jev.example/x" } });
  await clock.advance(100_000);
  const p = $.tool.call({ ...ESTIMATE });
  while (calls() < 1) await clock.advance(0);
  await clock.advance(4000);
  await p;
  // The 30 s pause would still hold; the clock now reads 5 s, before the timeout at 100 s.
  back.at = 5000;
  hang = false;
  await $.tool.call({ ...ESTIMATE });
  expect(calls()).toBe(2);
});

for (const [name, deny, env] of [["a jev-api timeout answered before jevfort's own", "request: timeout after 4000ms", { JEV_URL: "https://jev.example/x" }], ["a Haiku timeout (14 s, before the 15 s budget)", "request: fallback: timeout after 14000ms", {}]] as const) {
  test(`${name} pauses Jev like the local timeout`, async ($, on) => {
    const seen: unknown[] = [];
    const { calls } = setup(on, { messages: [user("what does this project do?")], jev: () => ({ __deny: deny }), env });
    claudeBeneath(on, seen);
    await drain($.turn.step(step));
    expect(calls()).toBe(1);
    // Within the pause nothing is sent.
    await drain($.turn.step(step));
    expect(calls()).toBe(1);
  });
}

test("a fast failure that is no timeout pauses nothing", async ($, on) => {
  const seen: unknown[] = [];
  const { calls } = setup(on, { messages: [user("what does this project do?")], jev: () => ({ __deny: "request: HTTP 503" }), env: { JEV_URL: "https://jev.example/x" } });
  claudeBeneath(on, seen);
  await drain($.turn.step(step));
  await drain($.turn.step(step));
  expect(calls()).toBe(2);
});

test("without any Jev variable (Haiku answers in jev-api) the budget is 15000 ms", async ($, on) => {
  const seen: unknown[] = [];
  const { sent, clock } = setup(on, { messages: [user("what does this project do?")], jev: () => new Promise<never>(() => {}) });
  claudeBeneath(on, seen);

  const run = drain($.turn.step(step));
  while (sent.length < 2) await clock.advance(0);
  await clock.advance(14_999);
  expect(seen).toHaveLength(0);
  await clock.advance(1);
  await run;
  expect(seen).toHaveLength(1);
});

const userSubmit = ($: Runner, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: "composer" } });

test("A submitted prompt is not classified: no Jev request, the prompt goes on unchanged", async ($, on) => {
  const { sent, calls } = setup(on, { messages: [], jev: () => undefined });
  const seen: string[] = [];
  on("prompt.submit", (_$, e) => (seen.push(String(e.text)), { value: {} }));
  await userSubmit($, "rewrite the storage layer to use IndexedDB");
  expect(sent).toEqual([]);
  expect(calls()).toBe(0);
  expect(seen).toEqual(["rewrite the storage layer to use IndexedDB"]);
});

// Jev's own calls skip auto mode's classifier: the mod approves them itself, but a settings deny rule beneath still wins.
for (const [beneath, expected] of [["ask", "allow"], ["deny", "deny"]] as const) {
  test(`A call Jev made itself is approved over "${beneath}" → ${expected}`, { options: { takeOnlyForBypass: false } }, async ($, on) => {
    setup(on, {
      messages: [user("run the tests please")],
      packageJson: { scripts: { test: "node --test" } },
      jev: byId({
        next_action: { type: "choice", choice: "run npm test", probabilities: { "run npm test": 0.97, claude: 0.03 }, confidence: 0.95 },
      }),
    });
    claudeBeneath(on, []);
    on("tool.check", () => ({ decision: beneath }));

    const { chunks } = await drain($.turn.step(step));
    const id = toolId(chunks);
    expect(id).not.toBe("");

    expect(await decision($, { tool: "Bash", input: { command: "npm test" }, tool_use_id: id })).toBe(expected);

    // Claude's own call to the same tool is left to the engine.
    expect(await decision($, { tool: "Bash", input: { command: "npm test" }, tool_use_id: "toolu_claude" })).toBe(beneath);
  });
}

// Claude Code allows in-project reads itself, so its ask on a Read means the path resolves outside the working directories (a symlink).
test("A Read Jev made itself keeps Claude Code's ask", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  setup(on, {
    messages: [user("what does src/app.ts export?")],
    jev: byId({ next_action: { type: "choice", choice: "read src/app.ts", probabilities: { "read src/app.ts": 0.97, claude: 0.03 }, confidence: 0.95 } }),
    files: [`${CWD}/src/app.ts`],
  });
  claudeBeneath(on, []);
  on("tool.check", () => ({ decision: "ask", reason: "/proj/src/app.ts resolves through a symlink to /etc/x, which is outside the allowed working directories." }));
  const id = toolId((await drain($.turn.step(step))).chunks);
  expect(id).not.toBe("");
  expect(await decision($, { tool: "Read", input: { file_path: `${CWD}/src/app.ts` }, tool_use_id: id })).toBe("ask");
});

test("A symlinked file is never offered as a Read candidate", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  setup(on, {
    messages: [user("what is in notes.txt?")],
    jev: byId({ next_action: { type: "choice", choice: "read notes.txt", probabilities: { "read notes.txt": 0.97, claude: 0.03 }, confidence: 0.95 } }),
    links: [`${CWD}/notes.txt`],
  });
  claudeBeneath(on, []);
  expect(toolId((await drain($.turn.step(step))).chunks)).toBe("");
});

// The 2 MB cap: a file of exactly 2,000,000 bytes is still offered, a larger one is not, even with a confident pick.
for (const [size, offered] of [[2_000_000, true], [2_000_001, false], [5_000_000, false]] as const) {
  test(`A ${size}-byte file is ${offered ? "" : "never "}offered as a Read candidate`, { options: { takeOnlyForBypass: false } }, async ($, on) => {
    setup(on, {
      messages: [user("what is in big.log?")],
      jev: byId({ next_action: { type: "choice", choice: "read big.log", probabilities: { "read big.log": 0.97, claude: 0.03 }, confidence: 0.95 } }),
      files: [`${CWD}/big.log`],
      sizes: { [`${CWD}/big.log`]: size },
    });
    claudeBeneath(on, []);
    expect(toolId((await drain($.turn.step(step))).chunks) !== "").toBe(offered);
  });
}

// An allow that a settings rule already gave stays as it is: rewording it makes the security plugin warn the user.
test("A call Jev made itself keeps a settings allow verdict untouched", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  setup(on, {
    messages: [user("what does src/app.ts export?")],
    jev: byId({ next_action: { type: "choice", choice: "read src/app.ts", probabilities: { "read src/app.ts": 0.97, claude: 0.03 }, confidence: 0.95 } }),
    files: [`${CWD}/src/app.ts`],
  });
  claudeBeneath(on, []);
  const base = { decision: "allow", rule: "Read(/proj/**)", reason: "settings rule" };
  on("tool.check", () => base);
  const id = toolId((await drain($.turn.step(step))).chunks);
  expect(await $.tool.check({ tool: "Read", input: { file_path: `${CWD}/src/app.ts` }, tool_use_id: id })).toEqual(base);
});

test("A settings ask rule beats the allow for a call Jev made itself", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  setup(on, {
    messages: [user("what does src/app.ts export?")],
    jev: byId({ next_action: { type: "choice", choice: "read src/app.ts", probabilities: { "read src/app.ts": 0.97, claude: 0.03 }, confidence: 0.95 } }),
    files: [`${CWD}/src/app.ts`],
  });
  claudeBeneath(on, []);
  on("tool.check", () => ({ decision: "ask", rule: "Read(/proj/src/**)" }));
  const id = toolId((await drain($.turn.step(step))).chunks);
  expect(await decision($, { tool: "Read", input: { file_path: `${CWD}/src/app.ts` }, tool_use_id: id })).toBe("ask");
});

// A slash command's skill text is not in the transcript: Jev must not take a step or bypass the turn on the bare command.
test("A turn started by a slash command is left to Claude (no take, no bypass)", async ($, on) => {
  const seen: unknown[] = [];
  const command = "<command-message>read-file</command-message>\n<command-name>/read-file</command-name>\n<command-args>src/app.ts</command-args>";
  setup(on, {
    messages: [user("Thanks!"), { role: "assistant", text: "ok", toolUses: [] }, user(command)],
    jev: byId({ next_action: { type: "choice", choice: "read src/app.ts", probabilities: { "read src/app.ts": 0.97, claude: 0.03 }, confidence: 0.95 }, single_action: mech(0.95) }),
    files: [`${CWD}/src/app.ts`],
  });
  claudeBeneath(on, seen);
  const { chunks } = await drain($.turn.step(step));
  expect(toolId(chunks)).toBe("");
  expect(seen).toHaveLength(1);
});

test("Jev can pick a skill on the first step of a turn", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  setup(on, {
    messages: [user("write the release notes for this version")],
    jev: byId({
      next_action: { type: "choice", choice: "skill write-release-notes", probabilities: { "skill write-release-notes": 0.93, claude: 0.07 }, confidence: 0.9 },
    }),
  });
  on("command.list", () => ({
    value: [
      { name: "write-release-notes", description: "Write release notes from the git log", source: "user" },
      { name: "help", description: "Show help", source: "builtin" },
    ],
  }));
  claudeBeneath(on, []);

  const { chunks } = await drain($.turn.step(step));
  expect(chunks).toContainEqual(expect.objectContaining({ kind: "tool", name: "Skill" }));
  expect(chunks).toContainEqual({ kind: "input", index: 0, json: JSON.stringify({ skill: "write-release-notes" }) });
});

test("An MCP server that connects after session.start is offered at the first step 0", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  const offered: string[] = [];
  const opts = {
    messages: [user("what is the weather like today")],
    tools: [...JEV_TOOLS],
    jev: (q: Asked) => {
      if (q.id === "next_action") offered.push(...Object.keys(q.criteria as object));
      return undefined;
    },
  };
  setup(on, opts);
  sessionStubs(on);
  on("command.list", () => ({ value: [] }));
  claudeBeneath(on, []);
  await $.session.start(START);
  // A new array: the baseline listing must not see the server through a shared reference.
  opts.tools = [...JEV_TOOLS, { name: "mcp__weather__ask", description: "Ask a question about the weather", mcp: true }];
  await drain($.turn.step(step));
  expect(offered).toContain("load mcp__weather__ask");
});

test("The jev-api tools are never offered to Jev as tools to load", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  const offered: string[] = [];
  setup(on, {
    messages: [user("ask jev a noul question about the score of this choice")],
    tools: [...JEV_TOOLS, { name: "mcp__weather__ask", description: "Ask a question about the weather", mcp: true }],
    jev: (q) => {
      if (q.id === "next_action") offered.push(...Object.keys(q.criteria as object));
      return undefined;
    },
  });
  on("command.list", () => ({ value: [] }));
  claudeBeneath(on, []);

  await drain($.turn.step(step));
  expect(offered).toContain("load mcp__weather__ask");
  expect(offered.filter((k) => k.includes("jev-api"))).toEqual([]);
});

test("Bash commands and edits are not gated", async ($, on) => {
  const { sent } = setup(on, { messages: [user("fix the typo in README.md")], jev: () => undefined });
  on("tool.check", () => ({ decision: "allow" }));

  expect(await decision($, { tool: "Edit", input: { file_path: "/proj/other.ts", new_string: "x" }, tool_use_id: "toolu_6" })).toBe("allow");
  expect(await decision($, { tool: "Bash", input: { command: "rm -rf ~/" }, tool_use_id: "toolu_7" })).toBe("allow");
  expect(sent).toHaveLength(0);
});

// Writes into this session's scratchpad are allowed in every permission mode; a settings deny still wins.
const SP = "/tmp/claude-1000/-proj/sid-1/scratchpad";
const scratch: { name: string; tool: string; key: string; path: string; beneath: string; expected: string; env?: Record<string, string> }[] = [
  { name: "Write into the scratchpad", tool: "Write", key: "file_path", path: `${SP}/notes.md`, beneath: "ask", expected: "allow" },
  { name: "Edit over a settings deny", tool: "Edit", key: "file_path", path: `${SP}/notes.md`, beneath: "deny", expected: "deny" },
  { name: "NotebookEdit into the scratchpad", tool: "NotebookEdit", key: "notebook_path", path: `${SP}/a.ipynb`, beneath: "ask", expected: "allow" },
  { name: "Write into another session's scratchpad", tool: "Write", key: "file_path", path: "/tmp/claude-1000/-proj/sid-2/scratchpad/x", beneath: "ask", expected: "ask" },
  { name: "Write escaping the scratchpad with ..", tool: "Write", key: "file_path", path: `${SP}/../../../../etc/x`, beneath: "ask", expected: "ask" },
  { name: "Write below a non-tmp root", tool: "Write", key: "file_path", path: "/home/u/claude-1000/-proj/sid-1/scratchpad/x", beneath: "ask", expected: "ask" },
  { name: "Write to the scratchpad directory itself", tool: "Write", key: "file_path", path: SP, beneath: "ask", expected: "ask" },
  { name: "a non-write tool with a scratchpad file_path", tool: "mcp__x__upload", key: "file_path", path: `${SP}/notes.md`, beneath: "ask", expected: "ask" },
  { name: "Write below TMPDIR", tool: "Write", key: "file_path", path: "/var/folders/T/claude-501/-proj/sid-1/scratchpad/x", beneath: "ask", expected: "allow", env: { TMPDIR: "/var/folders/T/" } },
  { name: "Write below a root that is not TMPDIR or /tmp", tool: "Write", key: "file_path", path: "/var/folders/T/claude-501/-proj/sid-1/scratchpad/x", beneath: "ask", expected: "ask" },
  { name: "Win32 backslash separator in the scratchpad path", tool: "Write", key: "file_path", path: `${SP}/..\\..\\x`, beneath: "ask", expected: "ask" },
  { name: "backslash in a scratchpad file name", tool: "Write", key: "file_path", path: `${SP}/a\\b`, beneath: "ask", expected: "ask" },
  { name: "leading // before the scratchpad", tool: "Write", key: "file_path", path: `/${SP}/x`, beneath: "ask", expected: "ask" },
  { name: "a relative scratchpad path", tool: "Write", key: "file_path", path: "scratchpad/x", beneath: "ask", expected: "ask" },
  { name: "a relative tmp path", tool: "Write", key: "file_path", path: "tmp/claude-1000/-proj/sid-1/scratchpad/x", beneath: "ask", expected: "ask" },
  { name: "an empty file path", tool: "Write", key: "file_path", path: "", beneath: "ask", expected: "ask" },
  { name: "a scratchpad with another uid's root", tool: "Write", key: "file_path", path: "/tmp/claude-abc/-proj/sid-1/scratchpad/x", beneath: "ask", expected: "ask" },
  { name: "a path beside the scratchpad, not in it", tool: "Write", key: "file_path", path: "/tmp/claude-1000/-proj/sid-1/other/x", beneath: "ask", expected: "ask" },
  { name: "a scratchpad file with a nested path", tool: "Write", key: "file_path", path: `${SP}/a/b/c.txt`, beneath: "ask", expected: "allow" },
  { name: "a scratchpad file with a ./ segment", tool: "Write", key: "file_path", path: `${SP}/./x/y.md`, beneath: "ask", expected: "allow" },
  { name: "a scratchpad file with a .. segment in the middle", tool: "Write", key: "file_path", path: `${SP}/x/../notes.md`, beneath: "ask", expected: "ask" },
];
for (const c of scratch) {
  test(`Scratchpad writes are always allowed: ${c.name} over "${c.beneath}" -> ${c.expected}`, async ($, on) => {
    setup(on, { messages: [user("anything")], jev: () => undefined, env: c.env });
    on("tool.check", () => ({ decision: c.beneath }));

    expect(await decision($, { tool: c.tool, input: { [c.key]: c.path }, tool_use_id: "toolu_sp" })).toBe(c.expected);
  });
}

// The path field is chosen by tool: a decoy in the other field must not decide the verdict.
const decoys: { name: string; tool: string; input: Record<string, string>; expected: string }[] = [
  { name: "NotebookEdit with a scratchpad decoy file_path", tool: "NotebookEdit", input: { notebook_path: "/home/u/real.ipynb", file_path: `${SP}/x` }, expected: "ask" },
  { name: "Write with a notebook_path decoy in the scratchpad", tool: "Write", input: { file_path: "/home/u/real.md", notebook_path: `${SP}/x` }, expected: "ask" },
  { name: "Edit with a notebook_path decoy in the scratchpad", tool: "Edit", input: { file_path: "/home/u/real.md", notebook_path: `${SP}/x` }, expected: "ask" },
];
for (const c of decoys) {
  test(`Scratchpad decoy field is ignored: ${c.name} -> ${c.expected}`, async ($, on) => {
    setup(on, { messages: [user("anything")], jev: () => undefined });
    on("tool.check", () => ({ decision: "ask" }));

    expect(await decision($, { tool: c.tool, input: c.input, tool_use_id: "toolu_sp" })).toBe(c.expected);
  });
}

test("A settings ask rule beats the scratchpad allow", async ($, on) => {
  setup(on, { messages: [user("anything")], jev: () => undefined });
  on("tool.check", () => ({ decision: "ask", rule: "Write(/tmp/**)" }));
  expect(await decision($, { tool: "Write", input: { file_path: `${SP}/x` }, tool_use_id: "toolu_sp4" })).toBe("ask");
});

test("After /clear (session.end and a new session id) the new scratchpad is allowed and the old one is not", async ($, on) => {
  let sid = SID;
  on("session.id", () => ({ value: sid })); // before setup's: the first stub answers
  setup(on, { messages: [user("anything")], jev: () => undefined });
  on("tool.check", () => ({ decision: "ask" }));
  on("session.end", () => ({}));
  expect(await decision($, { tool: "Write", input: { file_path: `${SP}/x` }, tool_use_id: "toolu_sp5" })).toBe("allow");
  await $.session.end({ reason: "clear", sessionId: SID, resume: { id: SID } });
  sid = "sid-2";
  expect(await decision($, { tool: "Write", input: { file_path: "/tmp/claude-1000/-proj/sid-2/scratchpad/x" }, tool_use_id: "toolu_sp6" })).toBe("allow");
  expect(await decision($, { tool: "Write", input: { file_path: `${SP}/x` }, tool_use_id: "toolu_sp7" })).toBe("ask");
});

// Phase 3: a simple request is answered by Jev's action plus a small-model summary.
for (const [single, expectBypass] of [[0.95, true], [0.3, false]] as const) {
  test(`Whole-turn bypass ${expectBypass ? "answers" : "does not answer"} when single_action=${single}`, async ($, on) => {
    const messages: Msg[] = [user("run the tests")];
    const seen: unknown[] = [];
    setup(on, {
      messages,
      packageJson: { scripts: { test: "node --test" } },
      jev: byId({
        next_action: { type: "choice", choice: "run npm test", probabilities: { "run npm test": 0.95, claude: 0.05 }, confidence: 0.9 },
        single_action: { type: "noul", noul: single },
      }),
    });
    const asked: string[] = [];
    on("model.complete", (_$, e) => {
      asked.push(String(e.prompt));
      return {
        value: {
          isAnswered: true,
          text: "All 3 tests passed.",
          usage: { input_tokens: 120, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      };
    });
    claudeBeneath(on, seen);

    // Step 0: Jev runs the tests itself, but only when the whole turn can be bypassed.
    const first = await drain($.turn.step(step));
    const id = toolId(first.chunks);
    if (!expectBypass) {
      expect(id).toBe("");
      expect(seen).toHaveLength(1);
      return;
    }
    expect(id).not.toBe("");

    // The tool ran; step 1 sees its result.
    messages.push({ role: "assistant", text: "", toolUses: [{ tool_use_id: id, tool: "Bash", input: { command: "npm test" }, text: "# tests 3\n# pass 3\n# fail 0" }] });
    messages.push({ role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: id, text: "# pass 3", isError: false }] });
    const second = await drain($.turn.step({ ...step, index: 1, messageCount: 3 }));

    expect(seen).toHaveLength(0);
    expect(second.chunks).toContainEqual({ kind: "text", index: 0, text: "All 3 tests passed." });
    expect(asked[0]).toContain("# pass 3");
  });
}

test("Jevfort off (the band button) takes no step and asks no take question", async ($, on) => {
  const seen: unknown[] = [];
  const { sent, clock } = setup(on, {
    messages: [user("run the tests")],
    packageJson: { scripts: { test: "node --test" } },
    jev: byId({
      next_action: { type: "choice", choice: "run npm test", probabilities: { "run npm test": 0.95, claude: 0.05 }, confidence: 0.9 },
      single_action: { type: "noul", noul: 0.95 },
    }),
  });
  claudeBeneath(on, seen);
  sessionStubs(on);
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);
  await ui.press({ key: "auto" });
  await clock.settle();
  const { chunks } = await drain($.turn.step(step));
  expect(toolId(chunks)).toBe("");
  expect(seen).toHaveLength(1);
  expect(ids(sent)).not.toContain("next_action");
  await ui.unmount();
});

test("bypass: false asks no single_action question and leaves a one-action request to Claude", { options: { bypass: false } }, async ($, on) => {
  const seen: unknown[] = [];
  const { sent } = setup(on, {
    messages: [user("run the tests")],
    packageJson: { scripts: { test: "node --test" } },
    jev: byId({
      next_action: { type: "choice", choice: "run npm test", probabilities: { "run npm test": 0.95, claude: 0.05 }, confidence: 0.9 },
      single_action: { type: "noul", noul: 0.95 },
    }),
  });
  claudeBeneath(on, seen);

  const { chunks } = await drain($.turn.step(step));
  expect(ids(sent)).not.toContain("single_action");
  expect(toolId(chunks)).toBe("");
  expect(seen).toHaveLength(1);
});

// A bypass take the user rejected (or a rule/hook denied) is Claude's to answer: the feedback must reach it.
for (
  const refusal of [
    "The user doesn't want to proceed with this tool use. The tool use was rejected. To tell you how to proceed, the user said: run only the unit tests with pnpm test:unit",
    "Permission for this tool use was denied. Try a different approach or report the limitation to complete your task",
  ]
) {
  test(`Whole-turn bypass leaves a refused take to Claude: ${refusal.slice(0, 40)}`, async ($, on) => {
    const messages: Msg[] = [user("run the tests")];
    const seen: unknown[] = [];
    setup(on, {
      messages,
      packageJson: { scripts: { test: "node --test" } },
      jev: byId({
        next_action: { type: "choice", choice: "run npm test", probabilities: { "run npm test": 0.95, claude: 0.05 }, confidence: 0.9 },
        single_action: { type: "noul", noul: 0.95 },
      }),
    });
    const asked: string[] = [];
    on("model.complete", (_$, e) => {
      asked.push(String(e.prompt));
      return { value: { isAnswered: true, text: "The test run was rejected.", usage: { input_tokens: 1, output_tokens: 1 } } };
    });
    claudeBeneath(on, seen);

    const id = toolId((await drain($.turn.step(step))).chunks);
    expect(id).not.toBe("");
    messages.push({ role: "assistant", text: "", toolUses: [{ tool_use_id: id, tool: "Bash", input: { command: "npm test" }, text: refusal, isError: true }] });
    messages.push({ role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: id, text: refusal, isError: true }] });
    await drain($.turn.step({ ...step, index: 1, messageCount: 3 }));

    expect(seen).toHaveLength(1);
    expect(asked).toHaveLength(0);
  });
}

test("Built-in commands are never offered as skills, and a skill that fails is blocklisted", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  const offered: string[][] = [];
  setup(on, {
    messages: [user("summarize the recent changes")],
    jev: (q) => {
      if (q.id !== "next_action") return undefined;
      offered.push(Object.keys(q.criteria as object));
      return { type: "choice", choice: "skill changelog", probabilities: { "skill changelog": 0.95, claude: 0.05 }, confidence: 0.9 };
    },
  });
  on("command.list", () => ({
    value: [
      // All share the prompt's words, so only the name/source filters can drop the first two.
      { name: "diff", description: "Summarize recent changes", source: "user" },
      { name: "recap", description: "Summarize recent changes", source: "mcp" },
      { name: "changelog", description: "Summarize recent changes", source: "plugin" },
    ],
  }));
  on("tool.call", () => ({ result: undefined, isError: true, text: "changelog is not a skill" }));
  claudeBeneath(on, []);

  const { chunks } = await drain($.turn.step(step));
  expect(offered[0]).not.toContain("skill diff");
  expect(offered[0]).not.toContain("skill recap");
  expect(offered[0]).toContain("skill changelog");
  await $.tool.call({ tool: "Skill", skill: "changelog", tool_use_id: toolId(chunks) });

  await drain($.turn.step({ ...step, turnId: "t2" }));
  expect(offered[1] ?? []).not.toContain("skill changelog");
});

test("A skill listed only after turn 1 is offered at turn 2's step 0 (the skill list is dropped at turn end)", async ($, on) => {
  const offered: string[][] = [];
  setup(on, {
    messages: [user("summarize the recent changes")],
    jev: (q) => {
      if (q.id === "next_action") offered.push(Object.keys(q.criteria as object));
      return undefined;
    },
  });
  let skills: { name: string; description: string; source: string }[] = [];
  on("command.list", () => ({ value: skills }));
  claudeBeneath(on, []);
  followUps(on);

  await drain($.turn.step(step));
  expect(offered[0] ?? []).not.toContain("skill changelog");
  await $.turn.complete(answered("t1", "Nothing changed."));
  skills = [{ name: "changelog", description: "Summarize recent changes", source: "plugin" }];

  const before = offered.length;
  await drain($.turn.step({ ...step, turnId: "t2" }));
  expect(offered[before] ?? []).toContain("skill changelog");
});

// F13: a prompt that says "skill" offered every listed skill at step 0 (255 options with 300 skills, a timeout).
test("A prompt that says \"skill\" offers at most 8 related skills at step 0", async ($, on) => {
  const offered: string[][] = [];
  setup(on, {
    messages: [user("update the release notes skill")],
    jev: (q) => {
      if (q.id === "next_action") offered.push(Object.keys(q.criteria as object));
      return undefined;
    },
  });
  on("command.list", () => ({ value: Array.from({ length: 300 }, (_, i) => ({ name: `notes-${i}`, description: "Write release notes", source: "plugin" })) }));
  claudeBeneath(on, []);

  await drain($.turn.step(step));
  const skills = (offered[0] ?? []).filter((k) => k.startsWith("skill "));
  expect(skills.length).toBeGreaterThan(0);
  expect(skills.length).toBeLessThanOrEqual(8);
});

for (
  const [name, answer, blocked] of [
    ["succeeds", { result: "ok" }, false],
    ["is denied", { deny: "Skill: changelog is not a skill" }, true],
  ] as const
) {
  test(`A skill Jev ran itself that ${name} is ${blocked ? "" : "not "}blocklisted`, { options: { takeOnlyForBypass: false } }, async ($, on) => {
    const offered: string[][] = [];
    setup(on, {
      messages: [user("summarize the recent changes")],
      jev: (q) => {
        if (q.id !== "next_action") return undefined;
        offered.push(Object.keys(q.criteria as object));
        return { type: "choice", choice: "skill changelog", probabilities: { "skill changelog": 0.95, claude: 0.05 }, confidence: 0.9 };
      },
    });
    on("command.list", () => ({ value: [{ name: "changelog", description: "Summarize recent changes", source: "plugin" }] }));
    on("tool.call", () => answer);
    claudeBeneath(on, []);

    const { chunks } = await drain($.turn.step(step));
    expect(offered[0]).toContain("skill changelog");
    await $.tool.call({ tool: "Skill", skill: "changelog", tool_use_id: toolId(chunks) }).catch(() => undefined);

    await drain($.turn.step({ ...step, turnId: "t2" }));
    if (blocked) expect(offered[1] ?? []).not.toContain("skill changelog");
    else expect(offered[1]).toContain("skill changelog");
  });
}

test("By default Jev takes no steps inside a longer turn", async ($, on) => {
  const seen: unknown[] = [];
  const { sent } = setup(on, {
    messages: [user("add a priority field, then run the tests")],
    packageJson: { scripts: { test: "node --test" } },
    jev: byId({
      next_action: { type: "choice", choice: "run npm test", probabilities: { "run npm test": 0.97, claude: 0.03 }, confidence: 0.95 },
      single_action: { type: "noul", noul: 0.95 },
    }),
  });
  claudeBeneath(on, seen);
  // A later step of the turn: Jev is not asked at all.
  const { chunks } = await drain($.turn.step({ ...step, index: 4 }));
  expect(toolId(chunks)).toBe("");
  expect(seen).toHaveLength(1);
  expect(ids(sent)).toEqual([]);
});

test("Effort lowered at step 0 holds for the later steps of the turn", async ($, on) => {
  const seen: { effort?: string }[] = [];
  setup(on, { messages: [user("what does this project do?")], jev: byId({ effort: easy }) });
  claudeBeneath(on, seen);
  await drain($.turn.step(step));
  await drain($.turn.step({ ...step, index: 1 }));
  expect(seen.map((s) => s.effort)).toEqual(["low", "low"]);
});

test("Effort routing sees the reply a short follow-up answers", async ($, on) => {
  const { sent } = setup(on, {
    messages: [user("add a sync layer"), { role: "assistant", text: "Here is the plan: 1. … Want me to build it?", toolUses: [] }, user("yes")],
    jev: byId({}),
  });
  claudeBeneath(on, []);
  await drain($.turn.step(step));
  const state = stateOf(sent, 0);
  expect(state.request).toBe("yes");
  expect(state.previous_reply).toBe("Here is the plan: 1. … Want me to build it?");
});

test("A long previous reply cut at an emoji stays well-formed", async ($, on) => {
  const { sent } = setup(on, {
    messages: [user("add a sync layer"), { role: "assistant", text: "🚀" + "x".repeat(799), toolUses: [] }, user("yes")],
    jev: byId({}),
  });
  claudeBeneath(on, []);
  await drain($.turn.step(step));
  const reply = String(stateOf(sent, 0).previous_reply);
  expect(reply).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  expect(reply).toBe(`…${"x".repeat(799)}`);
});

test("A big job asked at medium effort runs at xhigh, on an older Opus id too", async ($, on) => {
  const seen: { effort?: string }[] = [];
  const hard = { type: "score", score: 2.9, probabilities: {}, confidence: 0.95 };
  setup(on, { messages: [user("migrate the whole app to TypeScript")], jev: byId({ effort: hard }) });
  claudeBeneath(on, seen);
  await drain($.turn.step({ ...step, effort: "medium" }));
  await drain($.turn.step({ ...step, turnId: "t2", model: "claude-opus-5", effort: "medium" }));
  expect(seen.map((s) => s.effort)).toEqual(["xhigh", "xhigh"]);
});

test("There is no mode: a stored legacy mode is ignored", async ($, on) => {
  const seen: unknown[] = [];
  const { sent } = setup(on, { messages: [user("what does this project do?")], jev: byId({}), store: { mode: "off" } });
  claudeBeneath(on, seen);
  await drain($.turn.step(step));
  // One decision: its two questions went to jev-api.
  expect(ids(sent)).toEqual(["effort", "mechanical"]);
  expect(seen).toHaveLength(1);
});

// The estimate_effort tool: registered at session.start, answered by the unmatched tool.call hook on every call.
test("session.start registers estimate_effort", async ($, on) => {
  setup(on, { messages: [], jev: () => undefined });
  const registered: Record<string, unknown>[] = [];
  on("tool.register", async (_$, e) => {
    registered.push(e);
    return { value: { tool: "mcp__jevfort__estimate_effort" } };
  });
  on("session.start", async () => ({}));
  await $.session.start({ cwd: CWD, surface: "terminal", isInteractive: true });
  expect(registered).toHaveLength(1);
  expect(registered[0]).toMatchObject({
    name: "estimate_effort",
    inputSchema: { properties: { model: { enum: ["haiku", "sonnet", "opus", "fable"] } }, required: ["model", "defaultEffort", "minEffort", "maxEffort", "prompt"] },
  });
});

test("Effort routing does not ask Jev the difficulty question", async ($, on) => {
  const { sent } = setup(on, { messages: [user("what does this project do?")], jev: byId({ effort: scored(1.6) }) });
  claudeBeneath(on, []);
  await drain($.turn.step(step));
  expect(ids(sent)).toEqual(["effort", "mechanical"]);
});

// The debug log (`$.ui.log`) names the effort chosen for a turn: the only line jevfort logs.
test("The chosen effort is written to the debug log, with its source and score", async ($, on) => {
  const logged: string[] = [];
  const to: unknown[] = [];
  on("ui.log", (_$, e) => (logged.push(String(e.text)), to.push(e.to), { value: undefined }));
  setup(on, { messages: [user("migrate the whole app to TypeScript")], jev: byId({ effort: scored(2.9), mechanical: mech(0.1) }) });
  claudeBeneath(on, []);
  await drain($.turn.step({ ...step, effort: "medium" }));
  expect(logged).toEqual(["effort claude-opus-5-5: session medium → xhigh · jev (score 2.90)"]);
  // `to` defaults to "transcript", a visible system row on every estimated turn.
  expect(to).toEqual(["debug"]);
});

// $.ui.log returns undefined in the real engine (and the kit): a `.catch` on it threw and skipped the whole step hook.
test("Writing the debug line does not cost the step its routed effort", async ($, on) => {
  const seen: { effort?: string }[] = [];
  setup(on, { messages: [user("migrate the whole app to TypeScript")], jev: byId({ effort: scored(2.9), mechanical: mech(0.1) }) });
  claudeBeneath(on, seen);
  await drain($.turn.step({ ...step, effort: "medium" }));
  expect(seen.map((e) => e.effort)).toEqual(["xhigh"]);
});

test("The debug log says when Jev gave no effort", async ($, on) => {
  const logged: string[] = [];
  on("ui.log", (_$, e) => (logged.push(String(e.text)), { value: undefined }));
  setup(on, { messages: [user("what does this project do?")], jev: () => 503 });
  claudeBeneath(on, []);
  await drain($.turn.step(step));
  expect(logged).toEqual(["effort claude-opus-5-5: session high → unchanged · jev unavailable (request: HTTP 503)"]);
});

test("The debug log names a held Haiku effort and a subagent's step", async ($, on) => {
  const logged: string[] = [];
  on("ui.log", (_$, e) => (logged.push(String(e.text)), { value: undefined }));
  setup(on, { messages: [user("what does this project do?")], jev: inOrder({ effort: scored(1.6) }, { effort: scored(2.9) }) });
  claudeBeneath(on, []);
  await drain($.turn.step({ turnId: "t1", index: 0, model: "claude-haiku-5-5", effort: "high", messageCount: 1 }));
  await drain($.turn.step({ turnId: "t2", index: 0, model: "claude-haiku-5-5", effort: "high", messageCount: 1 }));
  await drain($.turn.step({ ...step, agentId: "a1" }));
  expect(logged).toEqual([
    "effort claude-haiku-5-5: session high → medium · jev (score 1.60)",
    "effort claude-haiku-5-5: session high → medium · held",
    "effort (agent a1) claude-opus-5-5: session high → xhigh · jev (score 2.90)",
  ]);
});

test("routing: false writes no effort line to the debug log", { options: { routing: false } }, async ($, on) => {
  const logged: string[] = [];
  on("ui.log", (_$, e) => (logged.push(String(e.text)), { value: undefined }));
  setup(on, { messages: [user("migrate the whole app to TypeScript")], jev: byId({ effort: scored(2.9), mechanical: mech(0.1) }) });
  claudeBeneath(on, []);
  await drain($.turn.step(step));
  expect(logged).toEqual([]);
});

// The failed-ask branch: a take ask (next_action) still goes out with routing off, and its failure logs nothing.
test("routing: false writes no 'jev unavailable' line when a take ask fails", { options: { routing: false } }, async ($, on) => {
  const logged: string[] = [];
  on("ui.log", (_$, e) => (logged.push(String(e.text)), { value: undefined }));
  const { sent } = setup(on, { messages: [user("what does src/app.ts export?")], files: [`${CWD}/src/app.ts`], jev: () => 503 });
  claudeBeneath(on, []);
  await drain($.turn.step(step));
  expect(ids(sent)).toContain("next_action");
  expect(logged).toEqual([]);
});

const ESTIMATE = { tool: "mcp__jevfort__estimate_effort", model: "opus", defaultEffort: "high", minEffort: "low", maxEffort: "xhigh", prompt: "add a retry to the HTTP client" };
const estimateCall = async ($: Runner, input: Record<string, unknown> = {}) => (await $.tool.call({ ...ESTIMATE, ...input })) as { result?: string; isError?: boolean; deny?: string };

test("estimate_effort returns Jev's estimate", async ($, on) => {
  const { sent } = setup(on, { messages: [], jev: byId({ effort: scored(1.6), mechanical: mech(0.1) }) });
  expect(await estimateCall($)).toEqual({ result: JSON.stringify({ effort: "medium", source: "jev" }) });
  expect(sent.map((q) => [q.id, q.type])).toEqual([["effort", "score"], ["mechanical", "noul"]]);
  expect(stateOf(sent, 0).request).toBe(ESTIMATE.prompt);
});

// Rewording a settings allow makes cc-plugin-sec-default warn the user.
test("estimate_effort keeps a settings allow verdict untouched", async ($, on) => {
  setup(on, { messages: [], jev: () => undefined });
  const base = { decision: "allow", rule: "mcp__jevfort__estimate_effort", reason: "settings rule" };
  on("tool.check", () => base);
  expect(await $.tool.check({ tool: ESTIMATE.tool, input: {}, tool_use_id: "toolu_1" })).toEqual(base);
});

test("A settings ask rule beats the estimate_effort allow", async ($, on) => {
  setup(on, { messages: [], jev: () => undefined });
  on("tool.check", () => ({ decision: "ask", rule: "mcp__jevfort__estimate_effort" }));
  expect(await decision($, { tool: ESTIMATE.tool, input: {}, tool_use_id: "toolu_1" })).toBe("ask");
});

test("A refused fs.exists probe does not stop the turn's routing", async ($, on) => {
  const seen: unknown[] = [];
  setup(on, { messages: [user("run the tests please")], packageJson: { scripts: { test: "node --test" } }, existsDenied: true, jev: byId({ effort: easy }) });
  claudeBeneath(on, seen);

  await drain($.turn.step(step));
  expect(seen[0]).toMatchObject({ effort: "low" });
});

test("estimate_effort falls back to defaultEffort when Jev is unreachable", async ($, on) => {
  setup(on, { messages: [], jev: () => 401 });
  expect(await estimateCall($)).toEqual({ result: JSON.stringify({ effort: "high", source: "fallback" }) });
});

test("A null script in the project's package.json does not stop the turn's routing", async ($, on) => {
  const seen: unknown[] = [];
  setup(on, { messages: [user("run the tests please")], packageJson: { scripts: { test: null } }, jev: byId({ effort: easy }) });
  claudeBeneath(on, seen);

  await drain($.turn.step(step));
  expect(seen[0]).toMatchObject({ effort: "low" });
});

test("A package.json saved with a UTF-8 BOM still offers its scripts", async ($, on) => {
  const { sent } = setup(on, { messages: [user("run the tests")], packageJson: `\uFEFF${JSON.stringify({ scripts: { test: "vitest run" } })}`, jev: () => undefined });
  claudeBeneath(on, []);
  await drain($.turn.step(step));
  expect(Object.keys(sent.find((q) => q.id === "next_action")?.criteria ?? {})).toContain("run npm test");
});

// `bun test` would start Bun's own test runner instead of the package script, so bun goes through `run`.
for (const [lock, command] of [["pnpm-lock.yaml", "pnpm test"], ["yarn.lock", "yarn test"], ["bun.lockb", "bun run test"], ["bun.lock", "bun run test"], [undefined, "npm test"]] as const) {
  test(`${lock ?? "No lock file"} offers the test script as ${command}`, async ($, on) => {
    const { sent } = setup(on, { messages: [user("run the tests")], packageJson: { scripts: { test: "vitest" } }, locks: lock ? [lock] : [], jev: () => undefined });
    claudeBeneath(on, []);
    await drain($.turn.step(step));
    expect(Object.keys(sent.find((q) => q.id === "next_action")?.criteria ?? {})).toContain(`run ${command}`);
  });
}

test("A failing store does not fail estimate_effort or a turn step", async ($, on) => {
  on("store.set", () => ({ deny: "store over 4 MiB of JSON text" }));
  const seen: unknown[] = [];
  setup(on, { messages: [user("what does this project do?")], jev: byId({ effort: scored(1.6), mechanical: mech(0.1) }) });
  claudeBeneath(on, seen);
  expect(await estimateCall($)).toEqual({ result: JSON.stringify({ effort: "medium", source: "jev" }) });
  await drain($.turn.step(step));
  expect(seen).toHaveLength(1);
});

test("With takeOnlyForBypass a confident skill pick is not taken by Jev (the skill would never run)", async ($, on) => {
  const seen: unknown[] = [];
  setup(on, {
    messages: [user("write the release notes for this version")],
    jev: byId({
      next_action: { type: "choice", choice: "skill write-release-notes", probabilities: { "skill write-release-notes": 0.93, claude: 0.07 }, confidence: 0.9 },
      single_action: mech(0.9),
    }),
  });
  on("command.list", () => ({ value: [{ name: "write-release-notes", description: "Write release notes from the git log", source: "user" }] }));
  claudeBeneath(on, seen);
  await drain($.turn.step(step));
  expect(seen).toHaveLength(1);
});

test("A refused clock read fails neither estimate_effort nor a turn step", async ($, on) => {
  on("clock.now", () => ({ deny: "clock refused" }));
  const seen: unknown[] = [];
  setup(on, { messages: [user("what does this project do?")], jev: byId({ effort: scored(1.6), mechanical: mech(0.1) }) });
  claudeBeneath(on, seen);
  expect(await estimateCall($)).toEqual({ result: JSON.stringify({ effort: "medium", source: "jev" }) });
  await drain($.turn.step(step));
  expect(seen).toHaveLength(1);
});

test("A turn's mentioned paths are statted at most 16 per step and each once per turn", async ($, on) => {
  const missing = Array.from({ length: 100 }, (_, i) => `src/gone${i}.ts`);
  const { statted } = setup(on, { messages: [user(`fix the build, tsc says: ${missing.join(" ")}`)], jev: () => undefined });
  claudeBeneath(on, []);
  await drain($.turn.step(step));
  const first = statted.length;
  expect(first).toBeLessThanOrEqual(16);
  await drain($.turn.step({ ...step, index: 1 }));
  expect(statted.length - first).toBeLessThanOrEqual(16);
  expect(new Set(statted).size).toBe(statted.length);
});

test("turn.complete drops the turn's state: a path statted in the turn is statted again by a later turn with the same id", async ($, on) => {
  const { statted } = setup(on, { messages: [user("fix src/gone.ts")], jev: () => undefined });
  claudeBeneath(on, []);
  followUps(on);
  await drain($.turn.step(step));
  await $.turn.complete(answered("t1", "Done."));
  await drain($.turn.step(step));
  expect(statted.filter((p) => p === `${CWD}/src/gone.ts`)).toHaveLength(2);
});

test("A file statted by an earlier step is still offered after 16 new paths used up the stat budget", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  const missing = Array.from({ length: 20 }, (_, i) => `src/gone${i}.ts`);
  const messages: Msg[] = [user("fix src/a.ts")];
  const { sent } = setup(on, { messages, files: [`${CWD}/src/a.ts`], jev: () => undefined });
  claudeBeneath(on, []);
  await drain($.turn.step({ ...step, index: 1 }));
  const before = sent.length;
  // A mid-turn compaction starts a new scan but keeps the turn's stat results: the new paths now come first.
  messages.splice(0, messages.length, user(`This session is being continued from a previous conversation that ran out of context. Summary: tsc says ${missing.join(" ")}, fix src/a.ts`));
  await drain($.turn.step({ ...step, index: 2 }));
  const last = sent.slice(before).filter((q) => q.id === "next_action").at(-1);
  expect(Object.keys(last?.criteria ?? {})).toContain("read src/a.ts");
});

test("After a mid-turn compaction the path scan starts over and offers a newly named file", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  const bash = (id: string, out: string): Msg[] => [
    { role: "assistant", text: "", toolUses: [{ tool_use_id: id, tool: "Bash", input: { command: "true" }, text: out }] },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: id, text: out, isError: false }] },
  ];
  const messages: Msg[] = [user("fix the build"), ...bash("c1", "nothing"), ...bash("c2", "nothing"), ...bash("c3", "nothing")];
  const { sent } = setup(on, { messages, files: [`${CWD}/src/new.ts`], jev: () => undefined });
  claudeBeneath(on, []);
  await drain($.turn.step({ ...step, index: 3 }));
  // Auto-compaction between two steps of the same turn: the transcript now starts with the summary row.
  messages.splice(0, messages.length, user("This session is being continued from a previous conversation that ran out of context. Summary: fix the build."), ...bash("c4", "error TS2304 in src/new.ts"));
  await drain($.turn.step({ ...step, index: 4 }));
  const last = sent.filter((q) => q.id === "next_action").at(-1);
  expect(Object.keys(last?.criteria ?? {})).toContain("read src/new.ts");
});

test("The path scan starts over when the transcript has fewer steps under the same request row", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  const said = (text: string): Msg => ({ role: "assistant", text, toolUses: [] });
  const messages: Msg[] = [user("tidy up the helpers"), said("one"), said("two"), said("three")];
  const { sent } = setup(on, { messages, files: [`${CWD}/src/new.ts`], jev: () => undefined });
  claudeBeneath(on, []);
  await drain($.turn.step({ ...step, index: 1 }));
  // Same request row, but the step rows were replaced by fewer ones naming a new file.
  messages.splice(1, messages.length, said("look at src/new.ts"));
  await drain($.turn.step({ ...step, index: 2 }));
  const last = sent.filter((q) => q.id === "next_action").at(-1);
  expect(Object.keys(last?.criteria ?? {})).toContain("read src/new.ts");
});

test("The path scan starts over on a message delivered mid-turn without fewer steps", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  const messages: Msg[] = [user("hello there")];
  const { sent } = setup(on, { messages, files: [`${CWD}/src/late.ts`], jev: () => undefined });
  claudeBeneath(on, []);
  await drain($.turn.step(step));
  // A new request row with no step rows after it: the step count does not shrink.
  messages.push(user("also check src/late.ts"));
  await drain($.turn.step({ ...step, index: 1 }));
  const last = sent.filter((q) => q.id === "next_action").at(-1);
  expect(Object.keys(last?.criteria ?? {})).toContain("read src/late.ts");
});

test("A mid-turn cd moves a later step's Read candidate to the new cwd", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  let cwd = CWD;
  const messages: Msg[] = [user("check the sub project")];
  const k = "read src/b.ts";
  setup(on, { messages, cwd: () => cwd, files: [`${CWD}/sub/src/b.ts`, `${CWD}/src/b.ts`], jev: byId({ next_action: { type: "choice", choice: k, probabilities: { [k]: 0.95, claude: 0.05 }, confidence: 0.9 } }) });
  claudeBeneath(on, []);
  await drain($.turn.step(step));
  // Claude's step 0 ran `cd sub` (carried over), its output names src/b.ts.
  cwd = `${CWD}/sub`;
  messages.push(
    { role: "assistant", text: "", toolUses: [{ tool_use_id: "u1", tool: "Bash", input: { command: "cd sub && ls src" }, text: "src/b.ts" }] },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "u1", text: "src/b.ts", isError: false }] },
  );
  const { chunks } = await drain($.turn.step({ ...step, index: 1, messageCount: 3 }));
  expect(chunks).toContainEqual({ kind: "input", index: 0, json: JSON.stringify({ file_path: `${CWD}/sub/src/b.ts` }) });
});

test("A mid-turn cd away from the package.json drops its scripts", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  let cwd = CWD;
  const { sent } = setup(on, { messages: [user("run the tests")], cwd: () => cwd, packageJson: { scripts: { test: "vitest run" } }, jev: () => undefined });
  claudeBeneath(on, []);
  await drain($.turn.step(step));
  expect(Object.keys(sent.filter((q) => q.id === "next_action").at(-1)?.criteria ?? {})).toContain("run npm test");
  // A carried-over `cd sub` moves the cwd to a directory without a package.json.
  cwd = `${CWD}/sub`;
  const before = sent.length;
  await drain($.turn.step({ ...step, index: 1 }));
  // Without candidates step 1 asks no next_action at all; with the stale scripts it would offer `run npm test`.
  const offered = sent.slice(before).filter((q) => q.id === "next_action").flatMap((q) => Object.keys(q.criteria ?? {}));
  expect(offered).not.toContain("run npm test");
});

test("A call's result that arrives a step later is still scanned for file paths", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  const call: { tool_use_id: string; tool: string; input: Record<string, unknown>; text?: string } = { tool_use_id: "c1", tool: "Bash", input: { command: "tsc" } };
  const messages: Msg[] = [user("fix the build"), { role: "assistant", text: "", toolUses: [call] }];
  const { sent } = setup(on, { messages, files: [`${CWD}/src/x.ts`], jev: () => undefined });
  claudeBeneath(on, []);
  await drain($.turn.step({ ...step, index: 1 }));
  // The result lands on the call already seen without text; no new row names the file.
  call.text = "error TS2304 in src/x.ts";
  await drain($.turn.step({ ...step, index: 2 }));
  const last = sent.filter((q) => q.id === "next_action").at(-1);
  expect(Object.keys(last?.criteria ?? {})).toContain("read src/x.ts");
});

test("One file under several spellings is one Read candidate", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  const out = "./src/app.ts:3:export const useAuth = 1\n/proj/src/app.ts:4: x";
  const messages: Msg[] = [
    user("where is useAuth used? start with src/app.ts"),
    { role: "assistant", text: "", toolUses: [{ tool_use_id: "c1", tool: "Bash", input: { command: "grep -rn useAuth ." }, text: out }] },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "c1", text: out, isError: false }] },
  ];
  const { sent } = setup(on, { messages, files: [`${CWD}/src/app.ts`], jev: () => undefined });
  claudeBeneath(on, []);
  await drain($.turn.step({ ...step, index: 1, messageCount: 3 }));
  const last = sent.filter((q) => q.id === "next_action").at(-1);
  expect(Object.keys(last?.criteria ?? {}).filter((k) => k.startsWith("read "))).toEqual(["read src/app.ts"]);
});

test("A file the turn already read is not offered again under another spelling", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  const messages: Msg[] = [
    user("check src/./app.ts"),
    { role: "assistant", text: "", toolUses: [{ tool_use_id: "r1", tool: "Read", input: { file_path: "src/app.ts" }, text: "1\texport const a = 1" }] },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "r1", text: "1\texport const a = 1", isError: false }] },
    // A later call, so the Read is not the step's last call and only the already-read filter can drop it.
    { role: "assistant", text: "", toolUses: [{ tool_use_id: "b1", tool: "Bash", input: { command: "git status" }, text: "clean" }] },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "b1", text: "clean", isError: false }] },
  ];
  const { sent } = setup(on, { messages, files: [`${CWD}/src/./app.ts`, `${CWD}/src/app.ts`], jev: () => undefined });
  claudeBeneath(on, []);
  await drain($.turn.step({ ...step, index: 2, messageCount: 5 }));
  const last = sent.filter((q) => q.id === "next_action").at(-1);
  expect(Object.keys(last?.criteria ?? {}).filter((k) => k.startsWith("read "))).toEqual([]);
});

test("estimate_effort rejects invalid input without asking Jev", async ($, on) => {
  const { sent } = setup(on, { messages: [], jev: byId({ effort: scored(1.6) }) });
  expect(await estimateCall($, { model: "gpt" })).toEqual({ deny: "estimate_effort: model must be one of haiku, sonnet, opus, fable" });
  expect(await estimateCall($, { minEffort: "high", maxEffort: "low" })).toEqual({ deny: "estimate_effort: minEffort must not be above maxEffort" });
  expect(sent).toHaveLength(0);
});

test("estimate_effort estimates on every call, also for haiku", async ($, on) => {
  const { sent } = setup(on, { messages: [], jev: inOrder({ effort: scored(1.6) }, { effort: scored(3), mechanical: mech(0.97) }) });
  expect(await estimateCall($, { model: "haiku" })).toEqual({ result: JSON.stringify({ effort: "medium", source: "jev" }) });
  expect(await estimateCall($, { model: "haiku" })).toEqual({ result: JSON.stringify({ effort: "low", source: "mechanical" }) });
  expect(ids(sent)).toEqual(["effort", "mechanical", "effort", "mechanical"]);
});

// Turn-start effort estimate: Jev's effort score within minEffort..maxEffort.
test("A mechanical turn runs at minEffort even on a hard score", async ($, on) => {
  const seen: { effort?: string }[] = [];
  setup(on, { messages: [user("rename foo to bar in src/a.ts")], jev: byId({ effort: scored(2.9), mechanical: mech(0.97) }) });
  claudeBeneath(on, seen);
  await drain($.turn.step(step));
  expect(seen.map((s) => s.effort)).toEqual(["low"]);
});

test("maxEffort caps a confident hard estimate", { options: { maxEffort: "medium" } }, async ($, on) => {
  const seen: { effort?: string }[] = [];
  setup(on, { messages: [user("migrate the whole app to TypeScript")], jev: byId({ effort: scored(2.9) }) });
  claudeBeneath(on, seen);
  await drain($.turn.step(step));
  expect(seen.map((s) => s.effort)).toEqual(["medium"]);
});

test("minEffort raises a confident easy estimate", { options: { minEffort: "medium" } }, async ($, on) => {
  const seen: { effort?: string }[] = [];
  setup(on, { messages: [user("what does this project do?")], jev: byId({ effort: scored(0.2) }) });
  claudeBeneath(on, seen);
  await drain($.turn.step(step));
  expect(seen.map((s) => s.effort)).toEqual(["medium"]);
});

test("An inverted minEffort/maxEffort config falls back to low..xhigh", { options: { minEffort: "max", maxEffort: "low" } }, async ($, on) => {
  const seen: { effort?: string }[] = [];
  setup(on, { messages: [user("migrate the whole app to TypeScript")], jev: byId({ effort: scored(2.9) }) });
  claudeBeneath(on, seen);
  await drain($.turn.step(step));
  expect(seen.map((s) => s.effort)).toEqual(["xhigh"]);
});

// Cadence (USER DECISION U1): Opus/Sonnet every turn; Haiku/Fable only on the loop's first turn, then held.
const turnStep = (turnId: string, model: string, effort: string) => ({ turnId, index: 0, model, effort, messageCount: 1 });

for (const model of ["claude-opus-5-5", "claude-sonnet-5-5"]) {
  test(`On ${model} every turn is estimated`, async ($, on) => {
    const seen: { effort?: string }[] = [];
    const { sent } = setup(on, { messages: [user("what does this project do?")], jev: inOrder({ effort: scored(0.2) }, { effort: scored(2.9) }) });
    claudeBeneath(on, seen);
    await drain($.turn.step(turnStep("t1", model, "high")));
    await drain($.turn.step(turnStep("t2", model, "high")));
    expect(ids(sent)).toEqual(["effort", "mechanical", "effort", "mechanical"]);
    expect(seen.map((s) => s.effort)).toEqual(["low", "xhigh"]);
  });
}

for (const model of ["claude-haiku-5-5", "claude-fable-5"]) {
  const estimated = "medium";
  test(`On ${model} only the first turn is estimated and later turns hold it`, async ($, on) => {
    const seen: { effort?: string }[] = [];
    const { sent } = setup(on, { messages: [user("what does this project do?")], jev: inOrder({ effort: scored(1.6) }, { effort: scored(2.9) }) });
    claudeBeneath(on, seen);
    await drain($.turn.step(turnStep("t1", model, "high")));
    await drain($.turn.step(turnStep("t2", model, "high")));
    // A held turn in effort routing has nothing to ask Jev at step 0.
    expect(ids(sent)).toEqual(["effort", "mechanical"]);
    expect(seen.map((s) => s.effort)).toEqual([estimated, estimated]);
  });
}

for (const row of ["", "[Request interrupted by user]"]) {
  test(`A held Haiku effort also applies to a turn without a request (${JSON.stringify(row)})`, async ($, on) => {
    const seen: { effort?: string }[] = [];
    const messages = [user("what does this project do?")];
    const { sent } = setup(on, { messages, jev: inOrder({ effort: scored(1.6) }, { effort: scored(2.9) }) });
    claudeBeneath(on, seen);
    await drain($.turn.step(turnStep("t1", "claude-haiku-5-5", "high")));
    messages.push({ role: "assistant", text: "done", toolUses: [] }, user(row));
    await drain($.turn.step(turnStep("t2", "claude-haiku-5-5", "high")));
    await drain($.turn.step({ ...turnStep("t2", "claude-haiku-5-5", "high"), index: 1 }));
    expect(ids(sent)).toEqual(["effort", "mechanical"]);
    expect(seen.map((s) => s.effort)).toEqual(["medium", "medium", "medium"]);
  });
}

test("A held Haiku effort still applies when Jev fails on a later turn", async ($, on) => {
  const seen: { effort?: string }[] = [];
  // A named file gives the held t2 a step-0 question, so its 401 reaches the failure branch.
  const { sent } = setup(on, { messages: [user("explain src/app.ts")], files: [`${CWD}/src/app.ts`], jev: inOrder({ effort: scored(1.6) }, 401) });
  claudeBeneath(on, seen);
  await drain($.turn.step(turnStep("t1", "claude-haiku-5-5", "high")));
  await drain($.turn.step(turnStep("t2", "claude-haiku-5-5", "high")));
  expect(new Set(sent.map((q) => q.call))).toEqual(new Set([0, 1]));
  expect(seen.map((s) => s.effort)).toEqual(["medium", "medium"]);
});

test("A changed session effort ends the Haiku hold", async ($, on) => {
  const seen: { effort?: string }[] = [];
  const { sent } = setup(on, { messages: [user("what does this project do?")], jev: inOrder({ effort: scored(2.5) }, { effort: scored(0.2) }) });
  claudeBeneath(on, seen);
  await drain($.turn.step(turnStep("t1", "claude-haiku-5-5", "high")));
  await drain($.turn.step(turnStep("t2", "claude-haiku-5-5", "medium")));
  expect(ids(sent)).toEqual(["effort", "mechanical"]);
  expect(seen.map((s) => s.effort)).toEqual(["xhigh", "medium"]);
});

test("A failed first Haiku turn is not re-asked and later turns keep the session effort", async ($, on) => {
  const seen: { effort?: string }[] = [];
  const { sent } = setup(on, { messages: [user("what does this project do?")], jev: inOrder(401, { effort: scored(0.2) }) });
  claudeBeneath(on, seen);
  await drain($.turn.step(turnStep("t1", "claude-haiku-5-5", "high")));
  await drain($.turn.step(turnStep("t2", "claude-haiku-5-5", "high")));
  expect(ids(sent)).toEqual(["effort", "mechanical"]);
  expect(seen.map((s) => s.effort)).toEqual(["high", "high"]);
});

test("A switch from Opus to Haiku starts a new first turn with its own estimate", async ($, on) => {
  const seen: { effort?: string }[] = [];
  const { sent } = setup(on, { messages: [user("what does this project do?")], jev: inOrder({ effort: scored(0.2) }, { effort: scored(1.6) }) });
  claudeBeneath(on, seen);
  await drain($.turn.step(turnStep("t1", "claude-opus-5-5", "high")));
  await drain($.turn.step(turnStep("t2", "claude-haiku-5-5", "high")));
  await drain($.turn.step(turnStep("t3", "claude-haiku-5-5", "high")));
  expect(ids(sent)).toEqual(["effort", "mechanical", "effort", "mechanical"]);
  expect(seen.map((s) => s.effort)).toEqual(["low", "medium", "medium"]);
});

test("A /clear (session.end) starts a new Haiku first turn with its own estimate", async ($, on) => {
  const seen: { effort?: string }[] = [];
  const { sent } = setup(on, { messages: [user("what does this project do?")], jev: inOrder({ effort: scored(1.6) }, { effort: scored(2.9) }) });
  on("session.end", () => ({}));
  claudeBeneath(on, seen);
  await drain($.turn.step(turnStep("t1", "claude-haiku-5-5", "high")));
  await $.session.end({ reason: "clear", sessionId: "s1", resume: { id: "s1" } });
  await drain($.turn.step(turnStep("t2", "claude-haiku-5-5", "high")));
  expect(ids(sent)).toEqual(["effort", "mechanical", "effort", "mechanical"]);
  expect(seen.map((s) => s.effort)).toEqual(["medium", "xhigh"]);
});

// Per-step effort (stepEffort): an Opus/Sonnet step k > 0 that goes to the model asks step_effort on the steps since
// Jev's last effort answer of the turn; fallback is the turn's step-0 effort, else the session effort.
/**
 * An assistant transcript row with text only.
 *
 * @param text - The row's text.
 * @returns The row.
 */
const assistantSays = (text: string): Msg => ({ role: "assistant", text, toolUses: [] });
/**
 * Step `index` of main-loop turn t1.
 *
 * @param index - The step index.
 * @param model - The session model.
 * @param effort - The session effort.
 * @returns The step event.
 */
const stepAt = (index: number, model = "claude-opus-5-5", effort = "high") => ({ ...turnStep("t1", model, effort), index });

test("Without stepEffort later steps ask Jev nothing about effort", async ($, on) => {
  const seen: { effort?: string }[] = [];
  const messages: Msg[] = [user("what does this project do?")];
  const { sent } = setup(on, { messages, jev: inOrder({ effort: scored(2.9) }, { step_effort: scored(0.2) }) });
  claudeBeneath(on, seen);
  await drain($.turn.step(stepAt(0)));
  messages.push(assistantSays("looking at the files"));
  await drain($.turn.step(stepAt(1)));
  messages.push(assistantSays("reading the README"));
  await drain($.turn.step(stepAt(2)));
  expect(ids(sent)).toEqual(["effort", "mechanical"]);
  expect(seen.map((s) => s.effort)).toEqual(["xhigh", "xhigh", "xhigh"]);
});

for (const model of ["claude-opus-5-5", "claude-sonnet-5-5"]) {
  test(`stepEffort on ${model}: a later step asks step_effort alone on the new steps and runs at its answer`, { options: { stepEffort: true } }, async ($, on) => {
    const seen: { effort?: string }[] = [];
    const messages: Msg[] = [user("what does this project do?")];
    const { sent } = setup(on, { messages, jev: inOrder({ effort: scored(2.9) }, { step_effort: scored(0.2) }) });
    claudeBeneath(on, seen);
    await drain($.turn.step(stepAt(0, model)));
    const before = sent.length;
    messages.push(assistantSays("looking at the files"));
    await drain($.turn.step(stepAt(1, model)));
    expect(ids(sent.slice(before))).toEqual(["step_effort"]);
    const state = stateOf(sent, before);
    expect(state.request).toBe("what does this project do?");
    expect(state.effort).toBe("xhigh");
    expect(state.delta).toEqual([{ assistant: "looking at the files" }]);
    expect(seen.map((s) => s.effort)).toEqual(["xhigh", "low"]);
  });
}

test("stepEffort: each delta starts after Jev's last effort answer", { options: { stepEffort: true } }, async ($, on) => {
  const messages: Msg[] = [user("what does this project do?")];
  const { sent } = setup(on, { messages, jev: inOrder({ effort: scored(2.2) }, { step_effort: scored(0.2) }, { step_effort: scored(0.2) }, { step_effort: scored(0.2) }) });
  claudeBeneath(on, []);
  await drain($.turn.step(stepAt(0)));
  const deltas: unknown[] = [];
  for (const [k, text] of [[1, "one"], [2, "two"], [3, "three"]] as const) {
    messages.push(assistantSays(text));
    const before = sent.length;
    await drain($.turn.step(stepAt(k)));
    expect(ids(sent.slice(before))).toEqual(["step_effort"]);
    deltas.push(stateOf(sent, before).delta);
  }
  expect(deltas).toEqual([[{ assistant: "one" }], [{ assistant: "two" }], [{ assistant: "three" }]]);
});

test("stepEffort: a failed Jev request turns the scoring off for the rest of the turn, the steps run at the session effort", { options: { stepEffort: true } }, async ($, on) => {
  const seen: { effort?: string }[] = [];
  const messages: Msg[] = [user("what does this project do?")];
  const { sent } = setup(on, { messages, jev: inOrder({ effort: scored(2.2) }, { step_effort: scored(0.2) }, 503) });
  claudeBeneath(on, seen);
  const asked: string[][] = [];
  for (const k of [0, 1, 2, 3, 4]) {
    if (k) messages.push(assistantSays(`step ${k}`));
    const before = sent.length;
    await drain($.turn.step(stepAt(k, "claude-opus-5-5", "medium")));
    asked.push(ids(sent.slice(before)));
  }
  // Step 0 high (2.2), step 1 low, step 2 fails: from there on nothing is asked and the session effort (medium) runs.
  expect(asked).toEqual([["effort", "mechanical"], ["step_effort"], ["step_effort"], [], []]);
  expect(seen.map((s) => s.effort)).toEqual(["high", "low", "medium", "medium", "medium"]);
});

test("stepEffort rides the take batch at a step Jev takes (answer unused), and the next model step's delta holds the taken call", { options: { stepEffort: true, takeOnlyForBypass: false } }, async ($, on) => {
  const seen: { effort?: string }[] = [];
  const messages: Msg[] = [user("compare src/app.ts and src/lib.ts")];
  const take = { type: "choice", choice: "read src/app.ts", probabilities: { "read src/app.ts": 0.95, claude: 0.05 }, confidence: 0.9 };
  const { sent } = setup(on, {
    messages,
    files: [`${CWD}/src/app.ts`, `${CWD}/src/lib.ts`],
    // Step 0 (call 0) leaves the step to Claude; step 1's take batch (call 1) takes the Read; later calls leave it to Claude.
    jev: (q: Asked) => (q.id === "effort" ? scored(2.2) : q.id === "step_effort" ? scored(0.2) : q.id === "next_action" && q.call === 1 ? take : undefined),
  });
  claudeBeneath(on, seen);
  await drain($.turn.step(stepAt(0)));
  messages.push(assistantSays("let me look"));
  const before1 = sent.length;
  const taken = await drain($.turn.step(stepAt(1)));
  const id = toolId(taken.chunks);
  expect(id).not.toBe("");
  // The step question rides in the take batch; the taken step never goes to the model, so its answer is unused and `seen` stays.
  expect(ids(sent.slice(before1))).toEqual(["next_action", "step_effort"]);
  messages.push({ role: "assistant", text: "", toolUses: [{ tool_use_id: id, tool: "Read", input: { file_path: `${CWD}/src/app.ts` }, text: "export const app = 1;" }] });
  messages.push({ role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: id, text: "export const app = 1;", isError: false }] });
  const before2 = sent.length;
  await drain($.turn.step(stepAt(2)));
  // One Jev round trip: the step question shares the take batch's call.
  expect(ids(sent.slice(before2))).toEqual(["next_action", "step_effort"]);
  const stepAsk = sent.findIndex((q, i) => i >= before2 && q.id === "step_effort");
  expect(sent[stepAsk].call).toBe(sent[before2].call);
  expect(stateOf(sent, stepAsk).delta).toEqual([
    { assistant: "let me look" },
    { tool: "Read", input: JSON.stringify({ file_path: `${CWD}/src/app.ts` }), result: "export const app = 1;" },
  ]);
  expect(seen.map((s) => s.effort)).toEqual(["high", "low"]);
});

test("stepEffort asks nothing at a step the whole-turn bypass answers", { options: { stepEffort: true } }, async ($, on) => {
  const messages: Msg[] = [user("run the tests")];
  const seen: unknown[] = [];
  const { sent } = setup(on, {
    messages,
    packageJson: { scripts: { test: "node --test" } },
    jev: byId({
      next_action: { type: "choice", choice: "run npm test", probabilities: { "run npm test": 0.95, claude: 0.05 }, confidence: 0.9 },
      single_action: { type: "noul", noul: 0.95 },
      step_effort: scored(0.2),
    }),
  });
  on("model.complete", () => ({ value: { isAnswered: true, text: "All 3 tests passed.", usage: { input_tokens: 120, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }));
  claudeBeneath(on, seen);
  const first = await drain($.turn.step(step));
  const id = toolId(first.chunks);
  expect(id).not.toBe("");
  messages.push({ role: "assistant", text: "", toolUses: [{ tool_use_id: id, tool: "Bash", input: { command: "npm test" }, text: "# tests 3\n# pass 3\n# fail 0" }] });
  messages.push({ role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: id, text: "# pass 3", isError: false }] });
  const before = sent.length;
  const second = await drain($.turn.step({ ...step, index: 1, messageCount: 3 }));
  expect(second.chunks).toContainEqual({ kind: "text", index: 0, text: "All 3 tests passed." });
  expect(sent.slice(before)).toEqual([]);
  expect(seen).toHaveLength(0);
});

test("stepEffort: a step score that is no number fails the request like an outage: the session effort runs", { options: { stepEffort: true } }, async ($, on) => {
  const seen: { effort?: string }[] = [];
  const messages: Msg[] = [user("what does this project do?")];
  const badScore = { type: "score", score: "x", probabilities: {}, confidence: 0.9 };
  setup(on, { messages, jev: inOrder({ effort: scored(2.2) }, { step_effort: scored(2.9) }, { step_effort: badScore }) });
  claudeBeneath(on, seen);
  for (const k of [0, 1, 2]) {
    if (k) messages.push(assistantSays(`step ${k}`));
    await drain($.turn.step(stepAt(k, "claude-opus-5-5", "medium")));
  }
  // Step 0 high (2.2), step 1 xhigh, then the score that is no number (isAnswer fails the whole batch) runs the session effort.
  expect(seen.map((s) => s.effort)).toEqual(["high", "xhigh", "medium"]);
});

// The step cuts (STEP_EFFORT_CUTS, calibrated with scripts/step-calibrate.mts) sit below the request question's: a delta
// score of 0.5 is medium, 1.3 high, 2.0 xhigh, and 0.4 stays low; the edges are 0.45, 1.2 and 1.95.
for (const [score, effort] of [[0.4, "low"], [0.5, "medium"], [1.1, "medium"], [1.3, "high"], [1.9, "high"], [2.0, "xhigh"], [2.9, "xhigh"]] as const) {
  test(`stepEffort: a step score of ${score} runs at ${effort}`, { options: { stepEffort: true } }, async ($, on) => {
    const seen: { effort?: string }[] = [];
    const messages: Msg[] = [user("what does this project do?")];
    setup(on, { messages, jev: inOrder({ effort: scored(0.1) }, { step_effort: scored(score) }) });
    claudeBeneath(on, seen);
    await drain($.turn.step(stepAt(0, "claude-opus-5-5", "medium")));
    messages.push(assistantSays("one"));
    await drain($.turn.step(stepAt(1, "claude-opus-5-5", "medium")));
    expect(seen[1].effort).toBe(effort);
  });
}

test("stepEffort without a step-0 estimate falls back to the session effort", { options: { stepEffort: true } }, async ($, on) => {
  const seen: { effort?: string }[] = [];
  const messages: Msg[] = [user("what does this project do?")];
  const { sent, clock } = setup(on, { messages, jev: inOrder({ step_effort: scored(2.9) }, 503) });
  claudeBeneath(on, seen);
  sessionStubs(on);
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);
  // Auto off at step 0: no step-0 estimate; on again before step 1.
  await ui.press({ key: "auto" });
  await clock.settle();
  await drain($.turn.step(stepAt(0, "claude-opus-5-5", "medium")));
  expect(sent).toHaveLength(0);
  await ui.press({ key: "auto" });
  await clock.settle();
  messages.push(assistantSays("one"), assistantSays("two"));
  await drain($.turn.step(stepAt(1, "claude-opus-5-5", "medium")));
  expect(ids(sent)).toEqual(["step_effort"]);
  expect(stateOf(sent, 0)).toMatchObject({ effort: "medium", delta: [{ assistant: "one" }, { assistant: "two" }] });
  messages.push(assistantSays("three"));
  await drain($.turn.step(stepAt(2, "claude-opus-5-5", "medium")));
  expect(seen.map((s) => s.effort)).toEqual(["medium", "xhigh", "medium"]);
  await ui.unmount();
});

for (const model of ["claude-haiku-5-5", "claude-fable-5"]) {
  test(`stepEffort leaves ${model} at one effort per turn`, { options: { stepEffort: true } }, async ($, on) => {
    const seen: { effort?: string }[] = [];
    const messages: Msg[] = [user("what does this project do?")];
    const { sent } = setup(on, { messages, jev: inOrder({ effort: scored(1.6) }, { step_effort: scored(2.9) }) });
    claudeBeneath(on, seen);
    await drain($.turn.step(stepAt(0, model)));
    messages.push(assistantSays("one"));
    await drain($.turn.step(stepAt(1, model)));
    expect(ids(sent)).toEqual(["effort", "mechanical"]);
    expect(seen.map((s) => s.effort)).toEqual(["medium", "medium"]);
  });
}

test("routing: false with stepEffort asks no effort question at any step", { options: { routing: false, stepEffort: true } }, async ($, on) => {
  const seen: { effort?: string }[] = [];
  const messages: Msg[] = [user("what does this project do?")];
  const { sent } = setup(on, { messages, jev: byId({ effort: scored(2.9), step_effort: scored(0.2) }) });
  claudeBeneath(on, seen);
  await drain($.turn.step(stepAt(0)));
  messages.push(assistantSays("one"));
  await drain($.turn.step(stepAt(1)));
  expect(ids(sent)).toEqual([]);
  expect(seen.map((s) => s.effort)).toEqual(["high", "high"]);
});

test("Jev auto off with stepEffort asks no step_effort", { options: { stepEffort: true } }, async ($, on) => {
  const seen: { effort?: string }[] = [];
  const messages: Msg[] = [user("what does this project do?")];
  const { sent, clock } = setup(on, { messages, jev: byId({ effort: scored(2.9), step_effort: scored(0.2) }) });
  claudeBeneath(on, seen);
  sessionStubs(on);
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);
  await ui.press({ key: "auto" });
  await clock.settle();
  await drain($.turn.step(stepAt(0)));
  messages.push(assistantSays("one"));
  await drain($.turn.step(stepAt(1)));
  expect(ids(sent)).toEqual([]);
  expect(seen.map((s) => s.effort)).toEqual(["high", "high"]);
  await ui.unmount();
});

test("stepEffort writes a step line to the debug log", { options: { stepEffort: true } }, async ($, on) => {
  const logged: string[] = [];
  on("ui.log", (_$, e) => (logged.push(String(e.text)), { value: undefined }));
  const messages: Msg[] = [user("what does this project do?")];
  setup(on, { messages, jev: inOrder({ effort: scored(2.9) }, { step_effort: scored(0.2) }, 503) });
  claudeBeneath(on, []);
  await drain($.turn.step(stepAt(0)));
  messages.push(assistantSays("one"));
  await drain($.turn.step(stepAt(1)));
  messages.push(assistantSays("two"));
  await drain($.turn.step(stepAt(2)));
  expect(logged).toEqual([
    "effort claude-opus-5-5: session high → xhigh · jev (score 2.90)",
    "effort claude-opus-5-5: session high → low · step 1 · jev (score 0.20)",
    "effort claude-opus-5-5: session high → high · step 2 · jev unavailable (request: HTTP 503) · scoring off for this turn",
  ]);
});

test("stepEffort draws a main-loop step's effort blue and leaves the band alone at a subagent step", { options: { stepEffort: true } }, async ($, on) => {
  const messages: Msg[] = [user("what does this project do?")];
  const { clock } = setup(on, { messages, jev: inOrder({ effort: scored(2.9) }, { step_effort: scored(0.2) }, { effort: scored(2.2) }, { step_effort: scored(1.6) }) });
  claudeBeneath(on, []);
  sessionStubs(on);
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);
  await drain($.turn.step(stepAt(0)));
  await clock.settle();
  expect(await levelProps(ui, "xhigh")).toEqual({ color: "blue" });
  messages.push(assistantSays("one"));
  await drain($.turn.step(stepAt(1)));
  await clock.settle();
  expect(await levelProps(ui, "low")).toEqual({ color: "blue" });
  expect(await levelProps(ui, "xhigh")).toEqual({ dimColor: true });
  // A subagent's steps 0 and 1 (its own estimate and step estimate) keep the main loop's choice.
  await drain($.turn.step({ ...step, turnId: "a-t1", agentId: "a1" }));
  messages.push(assistantSays("two"));
  await drain($.turn.step({ ...step, turnId: "a-t1", agentId: "a1", index: 1 }));
  await clock.settle();
  expect(await levelProps(ui, "low")).toEqual({ color: "blue" });
  expect(await levelProps(ui, "high")).toEqual({ bold: true });
  for (const level of ["medium", "xhigh"]) expect(await levelProps(ui, level)).toEqual({ dimColor: true });
  await ui.unmount();
});

// Self-disable: without jev-api's request tool in the listing (here jev-api 0.1's three tools), every hook but /jev passes through untouched.
test("Without a jev-api tool jevfort is inactive: every hook passes through", async ($, on) => {
  const seen: unknown[] = [];
  const { sent } = setup(on, {
    messages: [user("what does src/app.ts export?")],
    files: [`${CWD}/src/app.ts`],
    tools: SINGLE_TOOLS,
    jev: byId({}),
  });
  claudeBeneath(on, seen);
  const submitted = followUps(on);
  const registered: unknown[] = [];
  on("tool.register", async (_$, e) => {
    registered.push(e);
    return { value: { tool: "mcp__jevfort__estimate_effort" } };
  });
  on("session.start", async () => ({}));
  on("tool.check", () => ({ decision: "ask" }));
  on("tool.call", () => ({ result: "beneath" }));
  on("agent.offer", () => ({ isOffered: true }));
  on("session.compact", () => ({ skip: "test" }));

  // session.start registers no estimate_effort and logs why.
  await $.session.start({ cwd: CWD, surface: "terminal", isInteractive: true });
  expect(registered).toHaveLength(0);

  // The step goes to Claude unchanged, the scratchpad write keeps Claude Code's verdict, the turn's end is not checked
  // and a prompt is not classified. An estimate_effort call is still answered (its defaultEffort: Jev is unreachable) and approved.
  await drain($.turn.step(step));
  expect(seen).toEqual([step]);
  expect(await decision($, { tool: "Write", input: { file_path: `${SP}/notes.md` }, tool_use_id: "toolu_sp" })).toBe("ask");
  await $.turn.complete(answered("t1", "I renamed it in one file. Want me to do the rest?"));
  await userSubmit($, "rewrite the storage layer to use IndexedDB");
  expect(await estimateCall($)).toEqual({ result: JSON.stringify({ effort: "high", source: "fallback" }) });
  expect(await decision($, { tool: "mcp__jevfort__estimate_effort", tool_use_id: "toolu_est" })).toBe("allow");
  expect(submitted).toEqual(["rewrite the storage layer to use IndexedDB"]);
  // Offered agent types are not collected, an Agent call is not routed and a compaction gets no ranking.
  await $.agent.offer({ agent: "general-purpose", description: "General tasks", source: "built-in" });
  await $.agent.offer({ agent: "Explore", description: "Read-only codebase search", source: "built-in" });
  expect(await $.tool.call({ tool: "Agent", description: "find usages", prompt: "Find every caller of addTodo", tool_use_id: "a1" })).toEqual({ result: "beneath" });
  await $.session.compact({ trigger: "manual", messages: [user("fix the failing date test"), { role: "assistant", text: "", toolUses: ["a", "b", "c"].map((x, i) => ({ tool_use_id: `t${i}`, tool: "Bash", input: { command: `step ${x}` }, text: x })) }] });
  expect(sent).toHaveLength(0);
});

test("A tool listing that fails counts as all jev-api tools missing", async ($, on) => {
  const seen: unknown[] = [];
  const { sent } = setup(on, { messages: [user("what does this project do?")], tools: null, jev: () => undefined });
  claudeBeneath(on, seen);

  await drain($.turn.step(step));
  expect(seen).toEqual([step]);
  expect(sent).toHaveLength(0);
});

test("jev-api registering request inside session.start's next(e) makes jevfort active, also after a lookup in between", async ($, on) => {
  const tools: typeof JEV_TOOLS = [];
  const { sent } = setup(on, { messages: [user("what does this project do?")], tools, jev: byId({ effort: easy }) });
  claudeBeneath(on, []);
  const registered: unknown[] = [];
  on("tool.register", async (_$, e) => {
    registered.push(e.name);
    return { value: { tool: "mcp__jevfort__estimate_effort" } };
  });
  on("tool.call", (_$, e, next) => (e.tool === "Read" ? { deny: "not here" } : next(e)));
  // Beneath jevfort, as in the engine's dependency order: another plugin's session.start makes a tool call, which
  // jevfort's tool.call hook sees while request is not listed yet; then jev-api registers request.
  on("session.start", async ($2) => {
    await $2.tool.call({ tool: "Read", file_path: `${CWD}/README.md` }).catch(() => undefined);
    tools.push(...JEV_TOOLS);
    return {};
  });

  await $.session.start({ cwd: CWD, surface: "terminal", isInteractive: true });
  expect(registered).toEqual(["estimate_effort"]);
  await drain($.turn.step(step));
  expect(ids(sent)).toEqual(["effort", "mechanical"]);
  // The listing raised beneath next(e) (before jev-api registered) applied nothing: no inactive error was logged.
});

test("The jev-api lookup is repeated after each turn", async ($, on) => {
  const seen: { effort?: string }[] = [];
  const tools: typeof JEV_TOOLS = [];
  const { sent } = setup(on, { messages: [user("what does this project do?")], tools, jev: byId({ effort: easy }) });
  claudeBeneath(on, seen);
  followUps(on);
  const registered = sessionStubs(on);

  await $.session.start(START);
  await drain($.turn.step(step));
  // jev-api appears inside a turn: the turn's listing stands until the turn ends.
  tools.push(...JEV_TOOLS);
  await drain($.turn.step({ ...step, index: 1 }));
  expect(sent).toHaveLength(0);
  expect(registered).toHaveLength(0);

  // From the next turn on jevfort is active and estimate_effort is registered, once.
  await $.turn.complete(answered("t1", "It is a todo app."));
  await drain($.turn.step({ ...step, turnId: "t2" }));
  expect(ids(sent)).toEqual(["effort", "mechanical"]);
  expect(registered).toEqual(["estimate_effort"]);

  // jev-api goes away: from the next turn jevfort is inactive again and logs it once more.
  tools.length = 0;
  await $.turn.complete(answered("t2", "It is a todo app."));
  await drain($.turn.step({ ...step, turnId: "t3" }));
  expect(sent).toHaveLength(2);
  expect(registered).toEqual(["estimate_effort"]);
  expect(seen.map((s) => s.effort)).toEqual(["high", "high", "low", "high"]);
  // Two inactive errors: one at session start, one at the change.
});

test("estimate_effort is not registered again when jev-api goes away and comes back", async ($, on) => {
  const tools: typeof JEV_TOOLS = [...JEV_TOOLS];
  setup(on, { messages: [user("what does this project do?")], tools, jev: byId({ effort: easy }) });
  claudeBeneath(on, []);
  followUps(on);
  const registered = sessionStubs(on);
  await $.session.start(START);
  expect(registered).toEqual(["estimate_effort"]);
  tools.length = 0;
  await $.turn.complete(answered("t1", "It is a todo app."));
  await drain($.turn.step({ ...step, turnId: "t2" }));
  // There is no unregister: back to ready keeps the one registration.
  tools.push(...JEV_TOOLS);
  await $.turn.complete(answered("t2", "It is a todo app."));
  await drain($.turn.step({ ...step, turnId: "t3" }));
  expect(registered).toEqual(["estimate_effort"]);
});

test("/jev between turns does not carry its listing into the next turn", async ($, on) => {
  const tools: typeof JEV_TOOLS = [];
  const { sent } = setup(on, { messages: [user("what does this project do?")], tools, jev: byId({ effort: easy }) });
  claudeBeneath(on, []);
  followUps(on);
  const registered = sessionStubs(on);

  await $.session.start(START);
  await drain($.turn.step(step));
  await $.turn.complete(answered("t1", "It is a todo app."));
  // The user runs /jev, reads "it looks again at the next turn" and enables jev-api.
  tools.push(...JEV_TOOLS);
  await drain($.turn.step({ ...step, turnId: "t2" }));
  expect(ids(sent)).toEqual(["effort", "mechanical"]);
  expect(registered).toEqual(["estimate_effort"]);
});

test("A failed estimate_effort registration is retried by the next turn's listing, then not repeated", async ($, on) => {
  setup(on, { messages: [user("what does this project do?")], jev: byId({ effort: easy }) });
  claudeBeneath(on, []);
  followUps(on);
  const attempts: unknown[] = [];
  on("tool.register", async (_$, e) => {
    attempts.push(e.name);
    if (attempts.length === 1) throw new Error("transient");
    return { value: { tool: "mcp__jevfort__estimate_effort" } };
  });
  on("session.start", async () => ({}));

  await $.session.start(START);
  expect(attempts).toHaveLength(1);
  await $.turn.complete(answered("t1", "It is a todo app."));
  await drain($.turn.step({ ...step, turnId: "t2" }));
  expect(attempts).toHaveLength(2);
  await $.turn.complete(answered("t2", "It is a todo app."));
  await drain($.turn.step({ ...step, turnId: "t3" }));
  expect(attempts).toHaveLength(2);
});

test("A subagent's turn.complete does not drop the jev-api listing", async ($, on) => {
  const tools: typeof JEV_TOOLS = [];
  const { sent } = setup(on, { messages: [user("what does this project do?")], tools, jev: byId({ effort: easy }) });
  claudeBeneath(on, []);
  followUps(on);
  sessionStubs(on);

  await $.session.start(START);
  tools.push(...JEV_TOOLS);
  await drain($.turn.step({ ...step, turnId: "t2" }));
  await $.turn.complete(answered("s1", "Found it.", { agentId: "a1" }));
  // Another subagent of the same main-loop turn still sees the turn's listing (no jev-api): it asks nothing.
  await drain($.turn.step({ ...step, turnId: "s2", agentId: "a2" }));
  expect(sent).toHaveLength(0);
  await $.turn.complete(answered("t2", "It is a todo app."));
  await drain($.turn.step({ ...step, turnId: "t3" }));
  expect(ids(sent)).toEqual(["effort", "mechanical"]);
});

test("A subagent's turn.complete with jev-api listed keeps the turn's listing for the next main-loop step", async ($, on) => {
  const tools = [...JEV_TOOLS];
  setup(on, { messages: [user("what does this project do?")], tools, jev: byId({ effort: easy }) });
  claudeBeneath(on, []);
  followUps(on);
  sessionStubs(on);
  on("session.end", async () => ({}));

  await $.session.start(START);
  await drain($.turn.step({ ...step, turnId: "t2" }));
  await $.turn.complete(answered("s1", "Found it.", { agentId: "a1" }));
  // jev-api goes away mid-turn: the subagent's end must not have dropped the turn's listing, so the next step still asks Jev.
  tools.length = 0;
  await drain($.turn.step({ ...step, turnId: "t2b" }));
  // A relisting would find jev-api missing and hide the band's effort row.
  const ui = await $.ui.mount(BAND);
  expect(await levelProps(ui, "low")).toBeDefined();
});

test("The band shows the session effort bold and Jev's choice blue", async ($, on) => {
  const { clock } = setup(on, { messages: [user("what does this project do?")], jev: byId({ effort: easy }) });
  claudeBeneath(on, []);
  sessionStubs(on);
  on("session.end", async () => ({}));
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);
  // Before the first turn every level is dim and only the button is live.
  for (const level of ["low", "medium", "high", "xhigh"]) expect(await levelProps(ui, level)).toEqual({ dimColor: true });
  // `max` lies above the default maxEffort (xhigh): not drawn.
  expect(await levelProps(ui, "max")).toBeUndefined();
  expect(await autoLabel(ui)).toBe("Jevfort ✔️");

  await drain($.turn.step(step));
  await clock.settle();
  expect(await levelProps(ui, "high")).toEqual({ bold: true });
  expect(await levelProps(ui, "low")).toEqual({ color: "blue" });
  for (const level of ["medium", "xhigh"]) expect(await levelProps(ui, level)).toEqual({ dimColor: true });

  // /clear (session.end) drops the previous chat's efforts from the band.
  await $.session.end({ reason: "clear", sessionId: SID, resume: { id: SID } });
  await clock.settle();
  for (const level of ["low", "medium", "high", "xhigh"]) expect(await levelProps(ui, level)).toEqual({ dimColor: true });
  await ui.unmount();
});

test("The band draws a held Haiku effort blue on a later turn", async ($, on) => {
  const { clock } = setup(on, { messages: [user("what does this project do?")], jev: inOrder({ effort: scored(1.6) }, { effort: scored(2.9) }) });
  claudeBeneath(on, []);
  sessionStubs(on);
  on("turn.complete", () => ({ text: "" }));
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);
  await drain($.turn.step(turnStep("t1", "claude-haiku-5-5", "high")));
  await $.turn.complete(answered("t1", "It is a todo app."));
  await drain($.turn.step(turnStep("t2", "claude-haiku-5-5", "high")));
  await clock.settle();
  expect(await levelProps(ui, "high")).toEqual({ bold: true });
  expect(await levelProps(ui, "medium")).toEqual({ color: "blue" });
  await ui.unmount();
});

// A subagent's step 0 (estimated, or a held Haiku turn) leaves the main loop's bold and blue levels alone.
for (const model of ["claude-opus-5-5", "claude-haiku-5-5"]) {
  test(`A subagent's step 0 leaves the main loop's band (${model})`, async ($, on) => {
    const { clock } = setup(on, { messages: [user("what does this project do?")], jev: inOrder({ effort: easy }, { effort: scored(2.9) }) });
    claudeBeneath(on, []);
    sessionStubs(on);
    await $.session.start(START);
    const ui = await $.ui.mount(BAND);
    await drain($.turn.step(step));
    await drain($.turn.step({ ...step, turnId: "a-t1", agentId: "a1", model, effort: "medium" }));
    // On Haiku the subagent's second turn holds its first estimate (xhigh).
    await drain($.turn.step({ ...step, turnId: "a-t2", agentId: "a1", model, effort: "medium" }));
    await clock.settle();
    expect(await levelProps(ui, "low")).toEqual({ color: "blue" });
    expect(await levelProps(ui, "high")).toEqual({ bold: true });
    for (const level of ["medium", "xhigh"]) expect(await levelProps(ui, level)).toEqual({ dimColor: true });
    await ui.unmount();
  });
}

test("A main-loop turn without a request clears the last turn's choice from the band", async ($, on) => {
  const messages = [user("what does this project do?")];
  const { clock } = setup(on, { messages, jev: byId({ effort: easy }) });
  claudeBeneath(on, []);
  sessionStubs(on);
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);
  await drain($.turn.step(step));
  await clock.settle();
  expect(await levelProps(ui, "low")).toEqual({ color: "blue" });

  // An image-only prompt: an empty user row, no request; the session effort changed to medium.
  messages.push({ role: "assistant", text: "done", toolUses: [] }, user(""));
  await drain($.turn.step({ ...step, turnId: "t2", effort: "medium" }));
  await clock.settle();
  expect(await levelProps(ui, "low")).toEqual({ dimColor: true });
  expect(await levelProps(ui, "high")).toEqual({ dimColor: true });
  expect(await levelProps(ui, "medium")).toEqual({ bold: true });
  await ui.unmount();
});

test("The band shows only the configured range plus a session effort outside it", { options: { minEffort: "medium", maxEffort: "high" } }, async ($, on) => {
  const { clock } = setup(on, { messages: [user("what does this project do?")], jev: byId({ effort: easy }) });
  claudeBeneath(on, []);
  sessionStubs(on);
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);
  for (const level of ["low", "xhigh", "max"]) expect(await levelProps(ui, level)).toBeUndefined();
  for (const level of ["medium", "high"]) expect(await levelProps(ui, level)).toEqual({ dimColor: true });

  await drain($.turn.step(turnStep("t1", "claude-opus-5-5", "max")));
  await clock.settle();
  expect(await levelProps(ui, "max")).toEqual({ bold: true });
  expect(await levelProps(ui, "xhigh")).toBeUndefined();
  await ui.unmount();
});

test("The Auto button turns the effort choice off until pressed again", async ($, on) => {
  const seen: { effort?: string }[] = [];
  const { sent, clock } = setup(on, { messages: [user("what does this project do?")], jev: byId({ effort: easy }) });
  claudeBeneath(on, seen);
  sessionStubs(on);
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);

  await ui.press({ key: "auto" });
  await clock.settle();
  expect(await autoLabel(ui)).toBe("Jevfort ✖️");
  await drain($.turn.step(turnStep("t1", "claude-opus-5-5", "high")));
  await clock.settle();
  // No estimate: the turn runs at the session effort, shown bold with no blue choice.
  expect(sent).toHaveLength(0);
  expect(seen.map((s) => s.effort)).toEqual(["high"]);
  expect(await levelProps(ui, "high")).toEqual({ bold: true });
  expect(await levelProps(ui, "low")).toEqual({ dimColor: true });

  await ui.press({ key: "auto" });
  await clock.settle();
  expect(await autoLabel(ui)).toBe("Jevfort ✔️");
  await drain($.turn.step(turnStep("t2", "claude-opus-5-5", "high")));
  expect(ids(sent)).toEqual(["effort", "mechanical"]);
  expect(seen.map((s) => s.effort)).toEqual(["high", "low"]);

  // A new session turns Auto back on.
  await ui.press({ key: "auto" });
  await clock.settle();
  expect(await autoLabel(ui)).toBe("Jevfort ✖️");
  await $.session.start(START);
  await clock.settle();
  expect(await autoLabel(ui)).toBe("Jevfort ✔️");
  await ui.unmount();
});

test("Auto pressed off while step 0 waits for Jev keeps the session effort", async ($, on) => {
  const seen: { effort?: string }[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { sent, clock } = setup(on, { messages: [user("what does this project do?")], jev: (async (q: Asked) => (await gate, q.id === "effort" ? easy : undefined)) as never });
  claudeBeneath(on, seen);
  sessionStubs(on);
  const logged: string[] = [];
  on("ui.log", (_$, e) => (logged.push(String(e.text)), { value: undefined }));
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);

  const run = drain($.turn.step(turnStep("t1", "claude-opus-5-5", "high")));
  for (let i = 0; i < 50 && sent.length === 0; i++) await clock.settle();
  expect(ids(sent)).toEqual(["effort", "mechanical"]);
  await ui.press({ key: "auto" });
  release();
  await run;
  await clock.settle();
  expect(seen.map((s) => s.effort)).toEqual(["high"]);
  expect(logged).toEqual(["effort claude-opus-5-5: session high → unchanged · jev (score 0.20) · auto off"]);
  expect(await levelProps(ui, "low")).toEqual({ dimColor: true });
  expect(await autoLabel(ui)).toBe("Jevfort ✖️");
  await ui.unmount();
});

test("Auto pressed off while a held Haiku turn waits for Jev drops the held effort", async ($, on) => {
  const seen: { effort?: string }[] = [];
  let waiting = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const jev = (async (q: Asked) => {
    if (waiting) await gate;
    return q.id === "effort" ? scored(1.6) : undefined;
  }) as never;
  // A named file gives the held t2 a step-0 question, so it waits for Jev.
  const { sent, clock } = setup(on, { messages: [user("explain src/app.ts")], files: [`${CWD}/src/app.ts`], jev });
  claudeBeneath(on, seen);
  sessionStubs(on);
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);
  await drain($.turn.step(turnStep("t1", "claude-haiku-5-5", "high")));
  waiting = true;
  const before = sent.length;
  const run = drain($.turn.step(turnStep("t2", "claude-haiku-5-5", "high")));
  for (let i = 0; i < 50 && sent.length === before; i++) await clock.settle();
  await ui.press({ key: "auto" });
  release();
  await run;
  await clock.settle();
  expect(seen.map((s) => s.effort)).toEqual(["medium", "high"]);
  expect(await levelProps(ui, "medium")).toEqual({ dimColor: true });
  await ui.unmount();
});

test("The band passes before the session baseline and while jevfort is inactive", async ($, on) => {
  const { clock } = setup(on, { messages: [], tools: SINGLE_TOOLS, jev: () => undefined });
  sessionStubs(on);
  on("ui.render", () => BENEATH);
  const ui = await $.ui.mount(BAND);
  expect(await ui.find({ type: "Text", text: "beneath" })).toBeDefined();
  expect(await autoLabel(ui)).toBeUndefined();
  await $.session.start(START);
  await clock.settle();
  expect(await ui.find({ type: "Text", text: "beneath" })).toBeDefined();
  expect(await autoLabel(ui)).toBeUndefined();
  await ui.unmount();
});

test("The band passes while a survey holds it", async ($, on) => {
  setup(on, { messages: [], jev: () => undefined });
  sessionStubs(on);
  on("ui.render", () => BENEATH);
  await $.session.start(START);
  const survey = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true } });
  expect(await survey.find({ type: "Text", text: "beneath" })).toBeDefined();
  expect(await autoLabel(survey)).toBeUndefined();
  await survey.unmount();
  const ui = await $.ui.mount(BAND);
  expect(await autoLabel(ui)).toBe("Jevfort ✔️");
  await ui.unmount();
});

test("With routing off the band passes", { options: { routing: false } }, async ($, on) => {
  setup(on, { messages: [], jev: () => undefined });
  sessionStubs(on);
  on("ui.render", () => BENEATH);
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);
  expect(await ui.find({ type: "Text", text: "beneath" })).toBeDefined();
  expect(await autoLabel(ui)).toBeUndefined();
  await ui.unmount();
});

test("With routing off step 0 asks no effort questions and keeps Claude's effort", { options: { routing: false } }, async ($, on) => {
  const seen: { effort?: string }[] = [];
  const { sent } = setup(on, { messages: [user("migrate the whole app to TypeScript")], jev: byId({ effort: scored(2.9), mechanical: mech(0.1) }) });
  claudeBeneath(on, seen);
  await drain($.turn.step(step));
  expect(ids(sent).filter((id) => ["effort", "mechanical"].includes(id))).toEqual([]);
  expect(seen.map((s) => s.effort)).toEqual(["high"]);
});

// routing is a boolean: only an explicit false turns effort routing off, every other value is the default (on).
for (const value of ["model", "off", "effort", "false", "", 0, null]) {
  test(`routing ${JSON.stringify(value)} is not false: step 0 estimates the effort`, { options: { routing: value } }, async ($, on) => {
    const seen: { effort?: string }[] = [];
    const { sent } = setup(on, { messages: [user("migrate the whole app to TypeScript")], jev: byId({ effort: scored(2.9), mechanical: mech(0.1) }) });
    claudeBeneath(on, seen);
    await drain($.turn.step({ ...step, effort: "medium" }));
    expect(ids(sent).filter((id) => ["effort", "mechanical"].includes(id))).toEqual(["effort", "mechanical"]);
    expect(seen.map((x) => x.effort)).toEqual(["xhigh"]);
  });
}

test("routing: false still answers estimate_effort", { options: { routing: false } }, async ($, on) => {
  setup(on, { messages: [], jev: byId({ effort: scored(2.9), mechanical: mech(0.1) }) });
  sessionStubs(on);
  await $.session.start(START);
  expect(await estimateCall($)).toEqual({ result: JSON.stringify({ effort: "xhigh", source: "jev" }) });
});

test("There is no done check: an unfinished-looking answer asks Jev nothing and submits no follow-up", async ($, on) => {
  const { sent, calls } = setup(on, { messages: [user("rename foo to bar in all files")], jev: byId({ done: { type: "noul", noul: 0.01 } }) });
  const submitted = followUps(on);
  on("session.usage", () => ({ value: { context: { percent: 10 } } }));
  await $.turn.complete(answered("t1", "I renamed it in one file. Want me to do the rest?"));
  expect(sent).toEqual([]);
  expect(calls()).toBe(0);
  expect(submitted).toEqual([]);
});

test("a blank Jev variable counts as unset, as in jev-api: Haiku budget and timeout 14", async ($, on) => {
  const seen: unknown[] = [];
  const { sent } = setup(on, { messages: [user("what does this project do?")], jev: () => undefined, env: { TYPESAFE_API_KEY: "  ", JEV_URL: " " } });
  claudeBeneath(on, seen);
  await drain($.turn.step(step));
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.every((q) => q.timeout === 14)).toBe(true);
});

test("an estimate_effort call between session.start and the first turn: its env read is dropped, the first turn counts the new JEV_URL", async ($, on) => {
  const env: Record<string, string> = {};
  const { sent } = setup(on, { messages: [user("what does this project do?")], jev: byId({ effort: scored(1.6), mechanical: mech(0.1) }), env });
  claudeBeneath(on, []);
  sessionStubs(on);
  await $.session.start(START);
  await estimateCall($);
  expect(sent.at(-1)?.timeout).toBe(14);
  env.JEV_URL = "https://jev.example/x";
  const before = sent.length;
  await drain($.turn.step(step));
  expect(ids(sent.slice(before))).toEqual(["effort", "mechanical"]);
  expect(sent.slice(before).every((q) => q.timeout === 4)).toBe(true);
});

test("a settings env change between turns counts from the next turn, also after the task-end check read the env", async ($, on) => {
  const env: Record<string, string> = {};
  const { sent } = setup(on, { messages: [user("what does this project do?"), { role: "assistant", text: "It does X.", toolUses: [] }], jev: () => undefined, env });
  on("command.list", () => ({ value: [] }));
  on("session.usage", () => ({ value: { context: { percent: 85 } } }));
  on("turn.complete", () => ({}));
  claudeBeneath(on, []);
  await $.turn.complete(answered("t1", "It does X."));
  expect(sent.at(-1)?.timeout).toBe(14);
  env.JEV_URL = "https://jev.example/x";
  // The next turn's step 0, not another turn end: every main-loop turn end re-reads the env itself.
  await drain($.turn.step({ ...step, turnId: "t2" }));
  expect(sent.at(-1)?.timeout).toBe(4);
});

test("a /compact between turns drops its env read and listing: a later settings env change counts from the next turn", async ($, on) => {
  const env: Record<string, string> = {};
  const { sent } = setup(on, { messages: [user("what does this project do?"), { role: "assistant", text: "It does X.", toolUses: [] }], jev: () => undefined, env });
  on("command.list", () => ({ value: [] }));
  on("turn.complete", () => ({}));
  on("model.complete", () => ({ value: { isAnswered: false, reason: "down" } }));
  on("session.compact", () => ({}));
  claudeBeneath(on, []);
  await $.turn.complete(answered("t1", "It does X."));
  const before = sent.length;
  const row = (id: string) => ({ role: "assistant" as const, text: "", toolUses: [{ tool_use_id: id, tool: "Bash", input: { command: `ls ${id}` }, text: `out ${id}` }] });
  await $.session.compact({ trigger: "manual", messages: [user("fix the date bug"), row("a"), row("b"), row("c"), { role: "assistant", text: "done", toolUses: [] }] });
  // The ranking ran on the Haiku path (no Jev variable set yet).
  expect(sent.slice(before).length).toBeGreaterThan(0);
  expect(sent.at(-1)?.timeout).toBe(14);
  env.JEV_URL = "https://jev.example/x";
  const ranked = sent.length;
  await drain($.turn.step({ ...step, turnId: "t2" }));
  expect(sent.length).toBeGreaterThan(ranked);
  expect(sent.at(-1)?.timeout).toBe(4);
});

test("the task-end check's tool listing is dropped too: the next turn lists again and sees jev-api gone", async ($, on) => {
  const tools = [...JEV_TOOLS];
  let lists = 0;
  on("tool.list", (_$, e, next) => {
    lists++;
    return next(e);
  });
  const { calls } = setup(on, { messages: [user("what does this project do?"), { role: "assistant", text: "It does X.", toolUses: [] }], jev: () => undefined, tools });
  on("command.list", () => ({ value: [] }));
  on("session.usage", () => ({ value: { context: { percent: 85 } } }));
  on("turn.complete", () => ({}));
  claudeBeneath(on, []);
  await $.turn.complete(answered("t1", "It does X."));
  const before = { lists, calls: calls() };
  expect(before.calls).toBe(1);
  // Between turns jev-api goes away: the next turn's step 0 must list again and ask nothing.
  tools.length = 0;
  await drain($.turn.step({ ...step, turnId: "t2" }));
  expect(lists).toBeGreaterThan(before.lists);
  expect(calls()).toBe(before.calls);
});

test("a background subagent's tool.check between turns lists the tools; the next turn lists again and asks nothing", async ($, on) => {
  const tools = [...JEV_TOOLS];
  let lists = 0;
  on("tool.list", (_$, e, next) => {
    lists++;
    return next(e);
  });
  const { calls } = setup(on, { messages: [user("what does this project do?"), { role: "assistant", text: "It does X.", toolUses: [] }], jev: () => undefined, tools });
  on("command.list", () => ({ value: [] }));
  on("turn.complete", () => ({}));
  on("tool.check", () => ({ decision: "ask" }));
  claudeBeneath(on, []);
  await $.turn.complete(answered("t1", "It does X."));
  const before = calls();
  await $.tool.check({ tool: "Read", input: { file_path: `${CWD}/a.ts` }, tool_use_id: "bg1", agentId: "bg" });
  const listed = lists;
  expect(listed).toBeGreaterThan(0);
  tools.length = 0;
  await drain($.turn.step({ ...step, turnId: "t2" }));
  expect(lists).toBeGreaterThan(listed);
  expect(calls()).toBe(before);
});

// Context-fill compaction: from taskCompactPercent the first judged task end compacts, from forceCompactPercent any turn end does.
const finished = byId({ end: { type: "noul", noul: 0.9 } });
const intermediate = byId({ end: { type: "noul", noul: 0.1 } });

/** Stubs `/compact` and the context fill (`state.percent`, writable); returns the `/compact` run count. `pending`: `/compact` stays queued (never runs). */
function compactStubs(on: On, percent: number, pending = false) {
  const state = { compacts: 0, percent };
  on("session.usage", () => ({ value: { context: { tokens: 1, window: 100, percent: state.percent } } }));
  on("command.run", (_$, e, next) => {
    if (e.command !== "compact") return next(e);
    state.compacts++;
    return pending ? new Promise<never>(() => {}) : { value: undefined };
  });
  return state;
}

for (const [percent, jev, runs, label] of [[85, finished, 1, "a task end"], [85, intermediate, 0, "an intermediate result"], [70, finished, 0, "a task end below 80%"], [96, intermediate, 1, "an intermediate result at 95%"]] as const) {
  test(`Context at ${percent}% after ${label}: /compact runs ${runs}x`, async ($, on) => {
    setup(on, { messages: [user("rename foo to bar")], jev });
    followUps(on);
    const state = compactStubs(on, percent);
    await $.turn.complete(answered("t1", "Done."));
    expect(state.compacts).toBe(runs);
  });
}

// `0` turns either threshold off; a custom value is used and compacts from (>=) that fill.
for (
  const [options, percent, jev, runs] of [
    [{ forceCompactPercent: 0 }, 99, intermediate, 0],
    [{ taskCompactPercent: 0 }, 85, finished, 0],
    [{ taskCompactPercent: 50 }, 50, finished, 1],
    [{ forceCompactPercent: 90 }, 90, intermediate, 1],
  ] as const
) {
  test(`Context at ${percent}% with ${JSON.stringify(options)}: /compact runs ${runs}x`, { options: { ...options } }, async ($, on) => {
    setup(on, { messages: [user("rename foo to bar")], jev });
    followUps(on);
    const state = compactStubs(on, percent);
    await $.turn.complete(answered("t1", "Done."));
    expect(state.compacts).toBe(runs);
  });
}

// The task-end judgement is its own request with one transcript read, and only from the task-end fill.
for (const [percent, ids] of [[85, ["end"]], [30, []]] as const) {
  test(`Turn end at ${percent}% fill: ${ids.length} batch call(s), ${ids.length} transcript read(s)`, async ($, on) => {
    const { sent, calls, reads } = setup(on, { messages: [user("rename foo to bar")], jev: finished });
    followUps(on);
    compactStubs(on, percent);
    await $.turn.complete(answered("t1", "Done."));
    expect(sent.map((q) => q.id)).toEqual(ids);
    expect(calls()).toBe(ids.length);
    expect(reads()).toBe(ids.length);
  });
}

test("A failed task-end call at 85% fill sends no second request and queues no compaction", async ($, on) => {
  const { calls } = setup(on, { messages: [user("rename foo to bar")], jev: () => ({ __deny: "request: HTTP 503" }) });
  followUps(on);
  const state = compactStubs(on, 85);
  await $.turn.complete(answered("t1", "Done."));
  expect(calls()).toBe(1);
  expect(state.compacts).toBe(0);
});

test("Turn end at 96% fill asks no question and still compacts", async ($, on) => {
  const { sent } = setup(on, { messages: [user("rename foo to bar")], jev: intermediate });
  followUps(on);
  const state = compactStubs(on, 96);
  await $.turn.complete(answered("t1", "Done."));
  expect(sent.map((q) => q.id)).toEqual([]);
  expect(state.compacts).toBe(1);
});

test("A subagent's turn end at 96% fill runs no /compact", async ($, on) => {
  setup(on, { messages: [user("rename foo to bar")], jev: intermediate });
  followUps(on);
  const state = compactStubs(on, 96);
  await $.turn.complete(answered("s1", "Done.", { agentId: "a1" }));
  expect(state.compacts).toBe(0);
});

test("An aborted main-loop turn at 85% fill asks no end question and runs no /compact", async ($, on) => {
  const { sent } = setup(on, { messages: [user("rename foo to bar")], jev: finished });
  followUps(on);
  const state = compactStubs(on, 85);
  await $.turn.complete(answered("t1", "Done.", { reason: "aborted", isAborted: true }));
  expect(sent.map((q) => q.id)).not.toContain("end");
  expect(state.compacts).toBe(0);
});

test("Two concurrent turn ends at 96% fill queue /compact once", async ($, on) => {
  setup(on, { messages: [user("rename foo to bar")], jev: intermediate });
  followUps(on);
  const state = compactStubs(on, 96, true);
  await Promise.all([$.turn.complete(answered("t1", "Done.")), $.turn.complete(answered("t2", "Done."))]);
  expect(state.compacts).toBe(1);
});

// F07: facts that do not change within a turn are read from the engine once per turn.
test("A turn reads the project, env and lists once, the cwd once at step 0 and the transcript once per hook", async ($, on) => {
  const ops: Record<string, number> = {};
  for (const ev of ["env.get", "fs.exists", "fs.read", "session.cwd", "session.messages", "command.list", "tool.list", "store.get"]) {
    on(ev, (_$, e, next) => {
      const key = ev === "store.get" ? `store.get ${String(e.key)}` : ev;
      ops[key] = (ops[key] ?? 0) + 1;
      return next(e);
    });
  }
  setup(on, { messages: [user("what does src/app.ts export?")], files: [`${CWD}/src/app.ts`], packageJson: { scripts: { test: "vitest" } }, jev: () => undefined, env: { TYPESAFE_API_KEY: "k" } });
  on("command.list", () => ({ value: [{ name: "export-check", description: "Check what a module exports", source: "user" }] }));
  claudeBeneath(on, []);
  const perHook: Record<string, number>[] = [];
  let before = { ...ops };
  for (const index of [0, 1, 2]) {
    await drain($.turn.step({ ...step, index }));
    perHook.push(Object.fromEntries(Object.entries(ops).map(([k, v]) => [k, v - (before[k] ?? 0)])));
    before = { ...ops };
  }
  // Step 0 reads the transcript once (no second read for the previous reply).
  expect(perHook[0]["session.messages"]).toBe(1);
  // Later steps ask Jev nothing by default: they probe no project file and read no cwd.
  for (const k of [1, 2]) for (const ev of ["fs.exists", "fs.read"]) expect(perHook[k][ev] ?? 0).toBe(0);
  for (const k of [1, 2]) expect(perHook[k]["session.cwd"] ?? 0).toBe(0);
  // Once per turn: the three env values, the command list, the skill blocklist, the tool listing; the cwd once, at step 0.
  expect(ops["env.get"]).toBe(3);
  expect(ops["command.list"]).toBe(1);
  expect(ops["store.get skillBlocklist"]).toBe(1);
  expect(ops["tool.list"]).toBe(1);
  expect(ops["session.cwd"]).toBe(1);
});

test("Context compaction is queued once while it waits to run", async ($, on) => {
  setup(on, { messages: [user("rename foo to bar")], jev: finished });
  followUps(on);
  const state = compactStubs(on, 85, true);
  await $.turn.complete(answered("t1", "Done."));
  await $.turn.complete(answered("t2", "Done."));
  expect(state.compacts).toBe(1);
});

// The live engine (2.1.325) bypasses jevfort's session.compact hook: the ran /compact itself must re-arm the next one.
test("A /compact that ran without the session.compact hook lets a later high fill compact again", async ($, on) => {
  const { clock } = setup(on, { messages: [user("rename foo to bar")], jev: intermediate });
  followUps(on);
  const state = compactStubs(on, 96);
  await $.turn.complete(answered("t1", "Done."));
  await clock.advance(0);
  state.percent = 10;
  await $.turn.complete(answered("t2", "Done."));
  state.percent = 97;
  await $.turn.complete(answered("t3", "Done."));
  expect(state.compacts).toBe(2);
});

test("A refused /compact lets a later high fill compact again", async ($, on) => {
  const { clock } = setup(on, { messages: [user("rename foo to bar")], jev: intermediate });
  followUps(on);
  let compacts = 0;
  on("session.usage", () => ({ value: { context: { tokens: 1, window: 100, percent: 96 } } }));
  on("command.run", (_$, e, next) => {
    if (e.command !== "compact") return next(e);
    compacts++;
    throw new Error("compaction disabled");
  });
  await $.turn.complete(answered("t1", "Done."));
  await clock.advance(0);
  await $.turn.complete(answered("t2", "Done."));
  expect(compacts).toBe(2);
});

test("A background subagent that completes between turns drops its env read before the next main turn", async ($, on) => {
  const env: Record<string, string> = {};
  const { sent } = setup(on, { messages: [user("what does this project do?"), { role: "assistant", text: "It does X.", toolUses: [] }], jev: () => undefined, env });
  on("command.list", () => ({ value: [] }));
  on("turn.complete", () => ({}));
  claudeBeneath(on, []);
  await $.turn.complete(answered("t1", "It does X."));
  // No Jev variable: the subagent asks on the Haiku path.
  await drain($.turn.step({ ...step, turnId: "bg-t1", agentId: "bg" }));
  expect(sent.at(-1)?.timeout).toBe(14);
  await $.turn.complete(answered("bg-t1", "Found it.", { agentId: "bg" }));
  env.JEV_URL = "https://jev.example/x";
  const before = sent.length;
  await drain($.turn.step({ ...step, turnId: "t2" }));
  expect(sent.length).toBeGreaterThan(before);
  expect(sent.at(-1)?.timeout).toBe(4);
});

test("A background subagent's step between turns does not carry its env read into the next main turn", async ($, on) => {
  const env: Record<string, string> = {};
  const { sent } = setup(on, { messages: [user("what does this project do?"), { role: "assistant", text: "It does X.", toolUses: [] }], jev: () => undefined, env });
  on("command.list", () => ({ value: [] }));
  on("turn.complete", () => ({}));
  claudeBeneath(on, []);
  await drain($.turn.step({ ...step, turnId: "t1" }));
  await $.turn.complete(answered("t1", "It does X."));
  // A background agent started in t1 runs on after t1 ended, without completing before t2; no Jev variable: Haiku path.
  await drain($.turn.step({ ...step, turnId: "bg1", agentId: "bg" }));
  expect(sent.at(-1)?.timeout).toBe(14);
  env.JEV_URL = "https://jev.example/x";
  const before = sent.length;
  await drain($.turn.step({ ...step, turnId: "t2" }));
  expect(sent.length).toBeGreaterThan(before);
  expect(sent.at(-1)?.timeout).toBe(4);
});
