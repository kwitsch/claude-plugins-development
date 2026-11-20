// Runs under `claude plugin test` (scripts/plugin-test.ts copies this file next to the built plugin first).
// Imports the engine's own kit, not vitest: see development/wiki for why this is not part of `pnpm test`.
import { expect, test } from "claude-code/testing";

test("a non-search tool call passes through the built mod unchanged", async ($, on) => {
  on("tool.call", () => ({ result: "ok" }));
  const r = await $.tool.call({ tool: "Bash", command: "ls" });
  expect(JSON.stringify(r)).toContain("ok");
  expect(JSON.stringify(r)).not.toContain("graphmind-indexed");
});
