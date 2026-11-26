// Runs under `claude plugin test` via development/scripts/plugin-test.ts (`pnpm --filter universal-lint test:plugin`), on a
// temp copy of the built plugin/. Together the tests fire all 4 registrations of the built register.js: session.start,
// tool.call for Write/Edit, turn.complete and session.end. No imports besides the kit: the fake world is in memory.
import { expect, mock, test } from "claude-code/testing";

/** The test's `on`, taken from the kit's own types. */
type On = Parameters<typeof mock.clock>[0];

/**
 * Stubs every engine call of the mod: the lint server answers a keyless call with the key issue, a keyed `file_edited`
 * with a finding and a keyed `next_report` with the next state of `poll` (`timeout` for `wait_ms: 0`).
 *
 * @param on - The test's `on`.
 * @param poll - States the wake poll's keyed `next_report` calls get, in order; `busy` once it is used up.
 * @returns The tools called, the prompts submitted and the fake clock.
 */
function world(on: On, poll: string[] = ["busy"]) {
  const tools: string[] = [];
  const submitted: string[] = [];
  const clock = mock.clock(on);
  on("mcp.connect", () => ({ value: { isConnected: true, server: "plugin:universal-lint:lint" } }));
  on("mcp.call", (_$, e) => {
    tools.push(String(e.tool));
    const args = e.args as { key?: string; wait_ms?: number };
    const a = args.key === undefined ? { key: "K", headless: false } : e.tool === "file_edited" ? { context: "FINDING" } : { state: args.wait_ms === 0 ? "timeout" : poll.shift() ?? "busy" };
    return { value: { content: [{ type: "text", text: JSON.stringify(a) }] } };
  });
  on("session.id", () => ({ value: "S" }));
  on("session.cwd", () => ({ value: "/proj" }));
  on("env.get", () => ({ value: "cli" }));
  on("prompt.submit", (_$, e) => (submitted.push(String(e.text)), { text: String(e.text) }));
  on("session.start", async () => ({ cwd: "/proj" }));
  on("session.end", async () => ({ sessionId: "S" }));
  on("turn.complete", async () => ({ text: "" }));
  on("tool.call", () => ({ result: { structuredPatch: [], originalFile: "" }, text: "ok" }));
  return { tools, submitted, clock };
}

test("the built mod loads and fetches the session key (session.start)", async ($, on) => {
  const w = world(on);
  await $.session.start({ source: "startup", cwd: "/proj" });
  expect(w.tools).toEqual(["next_report", "next_report"]);
});

test("a Write is sent to file_edited and its finding is appended as context (tool.call { tool: [Write, Edit] })", async ($, on) => {
  const w = world(on);
  await $.session.start({ source: "startup", cwd: "/proj" });
  expect(JSON.stringify(await $.tool.call({ tool: "Write", file_path: "/proj/a.sh", content: "x" }))).toContain("FINDING");
  expect(w.tools.at(-1)).toEqual("file_edited");
});

test("the main turn end polls and a ready report submits the wake prompt (turn.complete)", async ($, on) => {
  const w = world(on, ["ready"]);
  await $.session.start({ source: "startup", cwd: "/proj" });
  await $.turn.complete({ turnId: "t1", reason: "answer", answer: "Done.", durationMs: 1, isAborted: false });
  await w.clock.settle();
  expect(w.submitted.length).toEqual(1);
});

test("session.end stops a pending poll (session.end)", async ($, on) => {
  const w = world(on, ["timeout", "ready"]);
  await $.session.start({ source: "startup", cwd: "/proj" });
  await $.session.end({ reason: "clear" });
  await $.turn.complete({ turnId: "t1", reason: "answer", answer: "Done.", durationMs: 1, isAborted: false });
  await w.clock.settle();
  expect(w.tools.filter((t) => t === "next_report").length > 2).toEqual(true);
});
