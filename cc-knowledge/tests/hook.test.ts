// Tests of the built plugin/hooks/register.mjs of cc-knowledge: the claude-code-guide reroute. The hook runs through the
// kit; the manifest wiring (hooks.json, claude plugin validate) is checked on the shipped files.
import { createKit } from "claude-engine-vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test as plain } from "vitest";
import { PLUGIN, readPluginJson } from "./support/plugin.ts";

const { test } = createKit({ module: new URL("../plugin/hooks/register.mjs", import.meta.url), plugin: "cc-knowledge" });

/** The test's `$` and `on` (the kit does not export their types). */
type Runner = Parameters<Parameters<typeof test>[2]>[0];
type On = Parameters<Parameters<typeof test>[2]>[1];

/** What the agent type of the call is rewritten to. */
const TARGET = "cc-knowledge:claude-code-expert";

/** Runs one call through the hook and returns the input the rest of the chain (the stub) received. */
async function seen(call: Record<string, unknown>, $: Runner, on: On): Promise<Record<string, unknown>> {
  let got: Record<string, unknown> = {};
  on("tool.call", (_$: unknown, e: Record<string, unknown>) => {
    got = e;
    return { result: "ok" };
  });
  const r = (await $.tool.call(call)) as { result?: unknown };
  expect(r.result).toBe("ok");
  return got;
}

test("an Agent call to claude-code-guide runs as the expert, keeping its other arguments", async ($, on) => {
  const got = await seen({ tool: "Agent", subagent_type: "claude-code-guide", description: "D", prompt: "P", model: "haiku" }, $, on);
  expect(got).toMatchObject({ tool: "Agent", subagent_type: TARGET, description: "D", prompt: "P", model: "haiku" });
});

test("a Task call to claude-code-guide is rerouted too", async ($, on) => {
  const got = await seen({ tool: "Task", subagent_type: "claude-code-guide", description: "D", prompt: "P" }, $, on);
  expect(got).toMatchObject({ tool: "Task", subagent_type: TARGET });
});

// every separator/case spelling normalizes to the guide (normalize: lowercase, runs of non-alphanumerics to "-", trimmed)
for (const spelling of ["Claude Code Guide", "CLAUDE_CODE_GUIDE", " claude-code-guide ", "__claude_code--guide__"]) {
  test(`the spelling ${JSON.stringify(spelling)} is rerouted`, async ($, on) => {
    const got = await seen({ tool: "Agent", subagent_type: spelling, description: "D", prompt: "P" }, $, on);
    expect(got.subagent_type).toBe(TARGET);
  });
}

// loop-safe: the target itself and look-alikes pass unchanged; a missing or non-string type too
for (const other of ["general-purpose", "Explore", TARGET, "claude-code-guide-x", "", undefined, null, 7]) {
  test(`the type ${JSON.stringify(other) ?? "undefined"} passes untouched`, async ($, on) => {
    const call = { tool: "Agent", subagent_type: other, description: "D", prompt: "P" };
    const got = await seen(call, $, on);
    expect(got).toEqual(call);
  });
}

test("a call of another tool is not touched", async ($, on) => {
  const got = await seen({ tool: "Bash", command: "echo claude-code-guide", subagent_type: "claude-code-guide" }, $, on);
  expect(got).toMatchObject({ tool: "Bash", command: "echo claude-code-guide", subagent_type: "claude-code-guide" });
});

plain("hooks.json is exactly the mods module list of the built entry", () => {
  expect(readPluginJson("hooks/hooks.json")).toEqual({ modules: ["./register.mjs"] });
  expect(existsSync(join(PLUGIN, "hooks/register.mjs"))).toBe(true);
});

plain("no helper module, old command hook, MCP server or launcher ships", () => {
  for (const gone of ["hooks/lib.mjs", "hooks/reroute.mjs", "hooks/reroute-guide.mjs", "mcp", ".mcp.json", "bin"]) {
    expect(existsSync(join(PLUGIN, gone)), gone).toBe(false);
  }
});

const hasClaude = spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0;

plain.skipIf(!hasClaude)("claude plugin validate passes and lists the tool.call hook", () => {
  const r = spawnSync("claude", ["plugin", "validate", PLUGIN], { encoding: "utf8" });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(r.stdout + r.stderr).toContain("./register.mjs hooks: tool.call{tool=Agent|Task}");
});
