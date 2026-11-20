// Runs under `claude plugin test` via development/scripts/plugin-test.ts (`pnpm --filter cc-knowledge test:plugin`), on a
// temp copy of the built plugin/. Imports the engine's own kit, not vitest (development/wiki/decisions/test-layers.md).
// The built register.js registers one event, tool.call with the matcher { tool: ["Agent", "Task"] }.
import { expect, test } from "claude-code/testing";

/** What the built mod rewrites a guide dispatch to. */
const TARGET = "cc-knowledge:claude-code-expert";

for (const tool of ["Agent", "Task"]) {
  test(`the built mod loads and reroutes a ${tool} call for claude-code-guide (tool.call)`, async ($, on) => {
    let got: Record<string, unknown> = {};
    on("tool.call", (_$, e) => {
      got = e;
      return { result: "ok" };
    });
    const r = await $.tool.call({ tool, subagent_type: "claude-code-guide", description: "D", prompt: "P" });
    expect(JSON.stringify(r)).toContain("ok");
    expect(got.subagent_type).toBe(TARGET);
    expect(got.prompt).toBe("P");
  });
}

test("another agent type and another tool pass through the built mod unchanged", async ($, on) => {
  const seen: unknown[] = [];
  on("tool.call", (_$, e) => {
    seen.push(e.subagent_type);
    return { result: "ok" };
  });
  await $.tool.call({ tool: "Agent", subagent_type: "Explore", description: "D", prompt: "P" });
  await $.tool.call({ tool: "Bash", command: "ls", subagent_type: "claude-code-guide" });
  expect(seen).toEqual(["Explore", "claude-code-guide"]);
});
