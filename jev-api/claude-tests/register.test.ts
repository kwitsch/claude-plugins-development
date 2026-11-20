// Runs under `claude plugin test` via development/scripts/plugin-test.ts (`pnpm --filter jev-api test:plugin`), on a temp
// copy of the built plugin/. Imports the engine's own kit, not vitest (development/wiki/decisions/test-layers.md).
// Together the tests fire all 3 events the built register.js registers: session.start, tool.call, tool.check.
// No live JEV server: tool.register and the transport server ($.mcp.connect, $.mcp.call) are stubs.
import { expect, mock, test } from "claude-code/testing";

/** The test's `on`, taken from the kit's own types. */
type On = Parameters<typeof mock.clock>[0];

/** The full name of the plugin's tool. */
const REQUEST = "mcp__jev-api__request";
/** The API's answer to the one noul question. */
const NOUL = { type: "noul", noul: 0.9 };
/** The transport server's outcome for a request that System One answered. */
const OUTCOME = { kind: "ok", status: 200, text: JSON.stringify({ answers: { q0: NOUL }, usage: {} }) };

/**
 * Stubs every engine call of the module. One call per test, before the first `$` call.
 *
 * @param on - The test's `on`.
 * @returns The bare names registered and the transport server's tools called.
 */
function world(on: On) {
  const registered: string[] = [];
  const mcpCalls: string[] = [];
  mock.env(on, { JEV_URL: "https://jev.example/x" });
  mock.store(on, {});
  mock.clock(on);
  on("ui.log", () => ({ value: undefined }));
  on("tool.register", (_$, e) => {
    registered.push(String(e.name));
    return { value: { tool: `mcp__jev-api__${String(e.name)}` } };
  });
  on("mcp.connect", () => ({ value: { isConnected: true, server: "plugin:jev-api:http" } }));
  on("mcp.call", (_$, e) => {
    mcpCalls.push(String(e.tool));
    return { value: { isError: false, content: [{ type: "text", text: JSON.stringify(OUTCOME) }], structuredContent: OUTCOME } };
  });
  on("session.start", async () => ({ cwd: "/proj" }));
  on("tool.call", () => ({ result: "tool output" }));
  // allow, not ask: a test's own $.tool.call passes tool.check first, and ask denies it (no user to ask)
  on("tool.check", () => ({ decision: "allow" }));
  return { registered, mcpCalls };
}

test("the built mod loads and session.start registers the request tool (session.start)", async ($, on) => {
  const { registered } = world(on);
  await $.session.start({ source: "startup", cwd: "/proj" });
  expect(registered).toEqual(["request"]);
});

test("a request call is answered through the transport server with the answers in question order (tool.call)", async ($, on) => {
  const { mcpCalls } = world(on);
  await $.session.start({ source: "startup", cwd: "/proj" });
  const r = (await $.tool.call({ tool: REQUEST, state: "Hello there!", questions: [{ type: "noul", instructions: "Is this text a greeting?" }] })) as { result?: string; deny?: string };
  expect(r.deny).toBeUndefined();
  expect(JSON.parse(String(r.result))).toEqual([NOUL]);
  expect(mcpCalls).toContain("request");
});

test("an invalid request call is refused before anything is sent (tool.call)", async ($, on) => {
  const { mcpCalls } = world(on);
  await $.session.start({ source: "startup", cwd: "/proj" });
  const r = await $.tool.call({ tool: REQUEST, state: "", questions: [] });
  expect(JSON.stringify(r)).toContain("request: state must be a non-empty string");
  expect(mcpCalls).toEqual([]);
});

test("a call of another tool passes through the built mod unchanged (tool.call)", async ($, on) => {
  world(on);
  await $.session.start({ source: "startup", cwd: "/proj" });
  expect(JSON.stringify(await $.tool.call({ tool: "Bash", command: "ls" }))).toContain("tool output");
});

test("the model is kept off the transport server's tools; other tools keep Claude Code's verdict (tool.check)", async ($, on) => {
  world(on);
  await $.session.start({ source: "startup", cwd: "/proj" });
  const own = (await $.tool.check({ tool: "mcp__plugin_jev-api_http__request", input: {} })) as { decision?: string; reason?: string };
  expect(own.decision).toBe("deny");
  expect(own.reason).toContain(REQUEST);
  const other = (await $.tool.check({ tool: "Bash", input: { command: "ls" } })) as { decision?: string };
  expect(other.decision).toBe("allow");
});
