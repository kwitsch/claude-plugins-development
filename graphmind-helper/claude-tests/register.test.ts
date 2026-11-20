// Runs under `claude plugin test` via scripts/plugin-test.ts (`pnpm --filter graphmind-helper test:plugin`), which copies
// this file next to a temp copy of the built plugin/. Imports the engine's own kit, not vitest; why this is not part of
// `pnpm test`: development/wiki/decisions/test-layers.md. Together the tests fire all 5 events the built register.js registers.
import { expect, mock, test } from "claude-code/testing";
import { BIN, envValue, mcpText, OWN, processOut } from "./world.js";

/** The test's `on`, taken from the kit's own types. */
type On = Parameters<typeof mock.clock>[0];

/** A prompt with code terms: gets the briefing and the recall. */
const CODE_PROMPT = "where is foo_bar defined in the code";

/**
 * Stubs every engine call of the module (a subset of tests/support/kit.ts `setupWith`). One call per test, before the first `$` call.
 *
 * @param on - The test's `on`.
 * @param opts - `noBinary`: no graphmind binary exists.
 * @returns The context entries of each prompt the module passed on, the toasts, and the fake clock.
 */
function world(on: On, opts: { noBinary?: boolean } = {}) {
  const prompts: string[] = [];
  const toasts: string[] = [];
  const clock = mock.clock(on);
  const files = opts.noBinary ? [] : [BIN];
  on("env.get", (_$, e) => ({ value: envValue(String(e.name)) }));
  on("session.cwd", () => ({ value: "/proj" }));
  on("fs.exists", (_$, e) => ({ value: files.includes(String(e.path)) }));
  on("fs.stat", (_$, e) => (files.includes(String(e.path)) ? { value: { kind: "file", size: 1, mtimeMs: 0 } } : { deny: "ENOENT" }));
  on("fs.read", () => ({ deny: "ENOENT" }));
  on("tool.list", () => ({ value: OWN }));
  on("process.run", (_$, e) => {
    const argv = [...(e.argv as string[])];
    return { value: { exitCode: 0, stdout: processOut(argv), stderr: "" } };
  });
  on("ui.toast", (_$, e) => {
    toasts.push(String(e.text));
    return { value: undefined };
  });
  // The official kit refuses a session.start answer without `cwd` (claude-engine-vitest accepts `{}`).
  on("session.start", async () => ({ cwd: "/proj" }));
  on("session.end", async () => ({ sessionId: "s" }));
  on("session.compact", async () => ({ messages: [{ role: "user", text: "summary", toolUses: [] }] }));
  on("prompt.submit", (_$, e) => {
    prompts.push(((e.context as readonly string[] | undefined) ?? []).join("\n"));
    return { text: String(e.text) };
  });
  on("tool.call", (_$, e) => {
    const tool = String(e.tool);
    if (!tool.startsWith("mcp__")) return { result: "tool output" };
    const text = mcpText(tool);
    // The shape of a real MCP tool result: text parts under `result` and the joined text.
    return { result: [{ type: "text", text }], text };
  });
  return { prompts, toasts, clock };
}

/**
 * Whether a tool result carries the module's nudge.
 *
 * @param r - The result of `$.tool.call`.
 * @returns True when a context entry names graphmind-indexed.
 */
function nudged(r: unknown): boolean {
  return JSON.stringify((r as { context?: unknown[] } | undefined)?.context ?? []).includes("graphmind-indexed");
}

test("a non-search tool call passes through the built mod unchanged", async ($, on) => {
  world(on);
  await $.session.start({ source: "startup", cwd: "/proj" });
  const r = await $.tool.call({ tool: "Bash", command: "ls" });
  expect(JSON.stringify(r)).toContain("tool output");
  expect(nudged(r)).toBe(false);
});

test("the first code search gets the nudge, a second one none (tool.call)", async ($, on) => {
  world(on);
  await $.session.start({ source: "startup", cwd: "/proj" });
  expect(nudged(await $.tool.call({ tool: "Grep" }))).toBe(true);
  expect(nudged(await $.tool.call({ tool: "Grep" }))).toBe(false);
});

test("session.end resets the nudge", async ($, on) => {
  world(on);
  await $.session.start({ source: "startup", cwd: "/proj" });
  expect(nudged(await $.tool.call({ tool: "Grep" }))).toBe(true);
  await $.session.end({ reason: "clear" });
  expect(nudged(await $.tool.call({ tool: "Grep" }))).toBe(true);
});

test("a main-conversation session.compact resets the nudge", async ($, on) => {
  world(on);
  await $.session.start({ source: "startup", cwd: "/proj" });
  expect(nudged(await $.tool.call({ tool: "Grep" }))).toBe(true);
  await $.session.compact({ trigger: "manual", messages: [{ role: "user", text: "hi", toolUses: [] }] });
  expect(nudged(await $.tool.call({ tool: "Grep" }))).toBe(true);
});

test("session.start without a graphmind binary toasts", async ($, on) => {
  const { toasts, clock } = world(on, { noBinary: true });
  await $.session.start({ source: "startup", cwd: "/proj" });
  await clock.settle();
  expect(toasts.join("\n")).toContain("graphmind binary was not found");
});

test("the first prompt gets the briefing with the priority entry and the map (prompt.submit)", async ($, on) => {
  const { prompts } = world(on);
  await $.session.start({ source: "startup", cwd: "/proj" });
  await $.prompt.submit({ text: CODE_PROMPT, origin: { kind: "composer" } });
  const ctx = prompts.join("\n");
  expect(ctx).toContain("always use X");
  expect(ctx).toContain("top file");
});
