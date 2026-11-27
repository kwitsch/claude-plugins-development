// Unit tests of the function-hooks module (src/hooks/register.ts) on claude-engine-vitest: every `$` call the mod makes is a stub.
import { createKit } from "claude-engine-vitest";
import assert from "node:assert/strict";
import { WAKE_TEXT } from "../src/hooks/register.ts";

const { test, mock } = createKit({ module: new URL("../src/hooks/register.ts", import.meta.url), plugin: "universal-lint" });
/** The test's `on`, taken from the kit's own types. */
type On = Parameters<typeof mock.clock>[0];
/** One `$.mcp.call` the mod made: the server name, the tool and its arguments. */
type McpCall = { server: string; tool: string; args: Record<string, unknown> };
/** What a test changes in the fake world. */
type Options = {
  /** The `CLAUDE_CODE_ENTRYPOINT` `$.env.get` answers; an `Error` denies the call. */
  entrypoint?: string | Error;
  /** The JSON a tool call answers, given the call and its index (1-based); it may return a promise that resolves to the reply, and returning an `Error` denies the call. */
  answer?: (c: McpCall, n: number) => unknown;
  /** The result the stubbed `tool.call` bottom answers instead of `RESULT`. */
  toolResult?: unknown;
};

/** The full server name `$.mcp.connect` answers. */
const SERVER = "plugin:universal-lint:lint";
/** The stubbed Write/Edit result: a patch and the old content, as the engine's `tool.call` gives them. */
const RESULT = { ref: "r", result: { structuredPatch: [{ newStart: 1, lines: ["+x"] }], originalFile: "old\n" }, text: "ok" };

/** The default server: a key issue for an unkeyed call, `busy` for a keyed `next_report`, `{}` for a keyed `file_edited`. */
function serverAnswer(c: McpCall): unknown {
  if (c.args.key === undefined) return { key: "K1", headless: false };
  return c.tool === "next_report" ? { state: "busy" } : {};
}

/**
 * The server's key gate (handlers.ts `gate`): the first call of a session id is issued its key, any other call without that
 * key gets the neutral answer (`{}`, `busy`), a keyed call is answered with a finding naming the session and its key.
 *
 * @returns The `answer` option of `world`.
 */
function gateServer(): (c: McpCall) => unknown {
  const keys = new Map<string, string>();
  return (c) => {
    const sid = String(c.args.session_id);
    const known = keys.get(sid);
    if (known === undefined) {
      const key = `K${keys.size + 1}-${sid}`;
      keys.set(sid, key);
      return { key, headless: false };
    }
    if (c.args.key !== known) return c.tool === "next_report" ? { state: "busy" } : {};
    return c.tool === "next_report" ? { state: "busy" } : { context: `FINDING ${sid} ${known}` };
  };
}

/** Stubs every engine call of the mod; `answer(call, n)` gives the JSON a tool call answers (an Error denies it, a promise holds it). */
function world(on: On, o: Options = {}) {
  const calls: McpCall[] = [];
  const submitted: string[] = [];
  const state = { cwd: "/proj", session: "S1" };
  const clock = mock.clock(on);
  on("mcp.connect", () => ({ value: { isConnected: true, server: SERVER } }));
  on("mcp.call", async (_$, e) => {
    const c = { server: String(e.server), tool: String(e.tool), args: e.args as Record<string, unknown> };
    calls.push(c);
    const a: unknown = await (o.answer ? o.answer(c, calls.length) : serverAnswer(c));
    if (a instanceof Error) return { deny: a.message };
    return { value: { content: [{ type: "text", text: JSON.stringify(a) }] } };
  });
  on("session.id", () => ({ value: state.session }));
  on("session.cwd", () => ({ value: state.cwd }));
  on("env.get", () => (o.entrypoint instanceof Error ? { deny: o.entrypoint.message } : { value: o.entrypoint ?? "cli" }));
  on("prompt.submit", (_$, e) => (submitted.push(String(e.text)), { value: undefined }));
  on("session.start", async () => ({}));
  on("session.end", async () => ({}));
  on("turn.complete", async () => ({}));
  on("tool.call", () => o.toolResult ?? RESULT);
  return { calls, submitted, state, clock };
}

/** The wake polls among `calls`: keyed `next_report` calls without `wait_ms`. */
const polls = (calls: McpCall[]): McpCall[] => calls.filter((c) => c.tool === "next_report" && c.args.wait_ms === undefined);

test("session.start fetches the key with two next_report calls", async ($, on) => {
  const w = world(on);
  await $.session.start({});
  assert.equal(w.calls.length, 2);
  for (const c of w.calls) {
    assert.equal(c.server, SERVER);
    assert.equal(c.tool, "next_report");
    assert.equal(c.args.session_id, "S1");
    assert.equal(c.args.wait_ms, 0);
  }
  assert.equal(w.calls[0]?.args.key, undefined);
  assert.equal(w.calls[1]?.args.key, "K1");
});

test("a throwing env.get does not skip the key call", async ($, on) => {
  const w = world(on, { entrypoint: new Error("x") });
  await $.session.start({});
  assert.equal(w.calls.length, 2);
});

test("a failing key call keeps the env.get result", async ($, on) => {
  const w = world(on, { entrypoint: "cli", answer: () => new Error("down") });
  await $.session.start({});
  await $.turn.complete({});
  await w.clock.settle();
  assert.equal(w.calls.at(-1)?.tool, "next_report");
  assert.equal(w.calls.at(-1)?.args.wait_ms, undefined);
});

test("every later call carries the key; a second session.start keeps it", async ($, on) => {
  const w = world(on);
  await $.session.start({});
  await $.tool.call({ tool: "Write", file_path: "/proj/a.sh", content: "x" });
  assert.equal(w.calls.at(-1)?.args.key, "K1");
  const before = w.calls.length;
  await $.session.start({});
  assert.equal(w.calls.length, before + 1);
  assert.equal(w.calls.at(-1)?.args.key, "K1");
});

test("a key answer is stored and the call repeated exactly once", async ($, on) => {
  const w = world(on, { answer: () => ({ key: "K2", headless: false }) });
  await $.session.start({});
  const r = await $.tool.call({ tool: "Write", file_path: "/proj/a.sh", content: "x" });
  const edits = w.calls.filter((c) => c.tool === "file_edited");
  assert.equal(edits.length, 2);
  assert.equal(edits[1]?.args.key, "K2");
  assert.deepEqual(r, RESULT);
});

test("file_edited payload follows the session cwd per edit", async ($, on) => {
  const w = world(on);
  await $.session.start({});
  await $.tool.call({ tool: "Edit", file_path: "/proj/a.sh", old_string: "a", new_string: "b" });
  assert.deepEqual(JSON.parse(JSON.stringify(w.calls.at(-1)?.args)), {
    cwd: "/proj",
    session_id: "S1",
    tool_name: "Edit",
    tool_input: { file_path: "/proj/a.sh" },
    tool_response: { structuredPatch: [{ newStart: 1, lines: ["+x"] }], originalFile: "old\n" },
    key: "K1",
  });
  w.state.cwd = "/proj/.claude/worktrees/w1";
  await $.tool.call({ tool: "Edit", file_path: "/proj/.claude/worktrees/w1/a.sh", old_string: "a", new_string: "b" });
  assert.equal(w.calls.at(-1)?.args.cwd, "/proj/.claude/worktrees/w1");
});

/** One Write through the test's `$.tool.call`; the answer carries the `context` the mod appended. */
const write = (call: (input?: Record<string, unknown>) => Promise<unknown>, file = "/proj/a.sh", content = "x") => call({ tool: "Write", file_path: file, content }) as Promise<{ context?: unknown }>;

test("overlapping edits of a session the mod has no key for both reach the server with the issued key", async ($, on) => {
  const w = world(on, { answer: gateServer() });
  await $.session.start({}); // S1 is keyed
  w.state.session = "S2"; // /clear: a new session id and no session.start
  const [a, b] = await Promise.all([write($.tool.call, "/proj/a.sh"), write($.tool.call, "/proj/b.sh")]);
  assert.deepEqual([a.context, b.context], [["FINDING S2 K2-S2"], ["FINDING S2 K2-S2"]]);
});

test("returning to a session id the server keyed before sends that session's own key", async ($, on) => {
  const w = world(on, { answer: gateServer() });
  await $.session.start({}); // S1: K1
  w.state.session = "S2";
  assert.deepEqual((await write($.tool.call)).context, ["FINDING S2 K2-S2"]);
  w.state.session = "S1"; // an in-process /resume back to S1: no session.start
  assert.deepEqual((await write($.tool.call)).context, ["FINDING S1 K1-S1"]);
});

test("a Write sends the text that landed (the result's content), not the model's text from before a PreToolUse rewrite", async ($, on) => {
  const w = world(on, { toolResult: { ...RESULT, result: { ...RESULT.result, content: "REWRITTEN" } } });
  await write($.tool.call, "/proj/a.sh", "ORIGINAL");
  assert.deepEqual(w.calls.at(-1)?.args.tool_input, { file_path: "/proj/a.sh", content: "REWRITTEN" });
});

test("a Write whose result carries no content sends the model's text", async ($, on) => {
  const w = world(on);
  await write($.tool.call, "/proj/a.sh", "ORIGINAL");
  assert.deepEqual(w.calls.at(-1)?.args.tool_input, { file_path: "/proj/a.sh", content: "ORIGINAL" });
});

test("agent_id is sent for a subagent's edit", async ($, on) => {
  const w = world(on);
  await $.tool.call({ tool: "Write", file_path: "/proj/a.sh", content: "x", agentId: "A1" });
  assert.equal(w.calls.at(-1)?.args.agent_id, "A1");
});

test("a context answer is appended to the tool result", async ($, on) => {
  world(on, { answer: (c) => (c.args.key === undefined ? { key: "K1", headless: false } : { context: "FINDING" }) });
  const r = (await $.tool.call({ tool: "Write", file_path: "/proj/a.sh", content: "x" })) as { context?: unknown };
  assert.deepEqual(r.context, ["FINDING"]);
});

test("a context answer is appended after the tool's own context", async ($, on) => {
  world(on, { answer: (c) => (c.args.key === undefined ? { key: "K1", headless: false } : { context: "FINDING" }), toolResult: { ...RESULT, context: ["x"] } });
  const r = (await $.tool.call({ tool: "Write", file_path: "/proj/a.sh", content: "x" })) as { context?: unknown };
  assert.deepEqual(r.context, ["x", "FINDING"]);
});

test("an empty answer leaves the tool result alone", async ($, on) => {
  world(on);
  assert.deepEqual(await $.tool.call({ tool: "Write", file_path: "/proj/a.sh", content: "x" }), RESULT);
});

for (const toolResult of [{ deny: "no" }, { ...RESULT, isError: true }]) {
  test(`a ${"deny" in toolResult ? "denied" : "isError"} tool result passes through without a file_edited call`, async ($, on) => {
    const w = world(on, { toolResult });
    assert.deepEqual(await $.tool.call({ tool: "Write", file_path: "/proj/a.sh", content: "x" }), toolResult);
    assert.equal(w.calls.filter((c) => c.tool === "file_edited").length, 0);
  });
}

test("another tool makes no MCP call", async ($, on) => {
  const w = world(on);
  await $.tool.call({ tool: "Read", file_path: "/proj/a.sh" });
  assert.equal(w.calls.length, 0);
});

const arming: { name: string; o: Options; agentId?: string; armed: boolean }[] = [
  { name: "a subagent's turn.complete", o: {}, agentId: "A1", armed: false },
  { name: "entrypoint sdk-cli", o: { entrypoint: "sdk-cli" }, armed: false },
  { name: "headless unknown", o: { entrypoint: new Error("x"), answer: () => new Error("down") }, armed: false },
  { name: "server headless true over mod cli", o: { entrypoint: "cli", answer: (c) => (c.args.key === undefined ? { key: "K1", headless: true } : { state: "busy" }) }, armed: false },
  { name: "entrypoint cli", o: { entrypoint: "cli" }, armed: true },
];
for (const row of arming) {
  test(`wake poll arming: ${row.name} ${row.armed ? "arms" : "arms nothing"}`, async ($, on) => {
    const w = world(on, row.o);
    await $.session.start({});
    await $.turn.complete(row.agentId === undefined ? {} : { agentId: row.agentId });
    await w.clock.settle();
    assert.equal(polls(w.calls).length, row.armed ? 1 : 0);
    if (row.armed) assert.equal(polls(w.calls)[0]?.args.key, "K1", "the poll carries the session key");
  });
}

/** A server whose keyed polls answer the given states in order (then `busy`). */
const pollingServer = (states: string[]) => (c: McpCall): unknown => {
  if (c.args.key === undefined) return { key: "K1", headless: false };
  if (c.tool !== "next_report" || c.args.wait_ms === 0) return { state: "busy" };
  return { state: states.shift() ?? "busy" };
};

test("a typed prompt before the first poll stops the wake loop", async ($, on) => {
  const w = world(on, { answer: pollingServer(["ready"]) });
  await $.session.start({});
  await $.turn.complete({});
  await $.prompt.submit({ text: "typed" }); // the loop is scheduled (clock.after(0)) but has not polled yet
  await w.clock.settle();
  assert.equal(polls(w.calls).length, 0);
  assert.deepEqual(w.submitted.filter((t) => t === WAKE_TEXT), []);
});

test("a typed prompt while a poll is pending stops the loop after that poll, with no wake and no second poll", async ($, on) => {
  let release: (v: unknown) => void = () => undefined;
  const held = new Promise((resolve) => (release = resolve));
  let first = true;
  const w = world(on, {
    answer: (c) => {
      if (c.args.key === undefined) return { key: "K1", headless: false };
      if (c.tool === "next_report" && c.args.wait_ms === undefined && first) {
        first = false;
        return held;
      }
      return { state: "ready" };
    },
  });
  await $.session.start({});
  await $.turn.complete({});
  await w.clock.settle();
  assert.equal(polls(w.calls).length, 1);
  await $.prompt.submit({ text: "typed" });
  release({ state: "timeout" }); // the poll ends as a timeout: without the prompt hook the loop would poll again and wake
  await w.clock.settle();
  assert.equal(polls(w.calls).length, 1);
  assert.deepEqual(w.submitted.filter((t) => t === WAKE_TEXT), []);
});

test("the next main turn.complete after a typed prompt arms the wake again", async ($, on) => {
  const w = world(on, { answer: pollingServer(["busy", "ready"]) });
  await $.session.start({});
  await $.turn.complete({});
  await w.clock.settle();
  await $.prompt.submit({ text: "typed" });
  await $.turn.complete({});
  await w.clock.settle();
  assert.equal(polls(w.calls).length, 2);
  assert.deepEqual(w.submitted.filter((t) => t === WAKE_TEXT), [WAKE_TEXT]);
});

test("ready submits WAKE_TEXT once and stops", async ($, on) => {
  const w = world(on, { answer: pollingServer(["ready"]) });
  await $.session.start({});
  await $.turn.complete({});
  await w.clock.settle();
  assert.deepEqual(w.submitted, [WAKE_TEXT]);
  assert.equal(polls(w.calls).length, 1);
});

test("timeout polls again", async ($, on) => {
  const w = world(on, { answer: pollingServer(["timeout", "timeout", "busy"]) });
  await $.session.start({});
  await $.turn.complete({});
  await w.clock.settle();
  assert.equal(polls(w.calls).length, 3);
  assert.deepEqual(w.submitted, []);
});

test("busy stops after one poll", async ($, on) => {
  const w = world(on, { answer: pollingServer(["busy"]) });
  await $.session.start({});
  await $.turn.complete({});
  await w.clock.settle();
  assert.equal(polls(w.calls).length, 1);
  assert.deepEqual(w.submitted, []);
});

test("a session.start during a pending poll stops the old loop", async ($, on) => {
  let release: (v: unknown) => void = () => undefined;
  const held = new Promise((resolve) => (release = resolve));
  const w = world(on, {
    answer: (c) => {
      if (c.args.key === undefined) return { key: "K1", headless: false };
      if (c.tool === "next_report" && c.args.wait_ms === undefined) return held;
      return { state: "busy" };
    },
  });
  await $.session.start({});
  await $.turn.complete({});
  await w.clock.settle();
  assert.equal(polls(w.calls).length, 1);
  await $.session.start({});
  release({ state: "ready" });
  await w.clock.settle();
  assert.deepEqual(w.submitted, []);
});

test("a rejecting mcp.call never throws out of a hook", async ($, on) => {
  const w = world(on, { answer: () => new Error("down") });
  await $.session.start({});
  assert.deepEqual(await $.tool.call({ tool: "Write", file_path: "/proj/a.sh", content: "x" }), RESULT);
  await $.turn.complete({});
  await w.clock.settle();
});

test("WAKE_TEXT is the spec's literal", () => {
  assert.equal(WAKE_TEXT, "universal-lint: files that changed while the session was idle have lint findings. They are attached to this message as hook context. Fix them, or say why not.");
});
