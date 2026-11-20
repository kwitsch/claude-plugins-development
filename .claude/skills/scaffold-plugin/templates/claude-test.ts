// Runs under `claude plugin test` via development/scripts/plugin-test.ts (`pnpm --filter __NAME__ test:plugin`), which copies this
// file next to a temp copy of the built plugin/. Imports the engine's own kit, not vitest; why this is not part of
// `pnpm test`: development/wiki/decisions/test-layers.md. Add one test per event the built register.js registers.
import { expect, test } from "claude-code/testing";

test("the built mod loads and passes a tool call through", async ($, on) => {
  // The official kit refuses a session.start answer without `cwd`.
  on("session.start", async () => ({ cwd: "/proj" }));
  on("tool.call", () => ({ result: "ok" }));
  await $.session.start({ source: "startup" });
  expect(JSON.stringify(await $.tool.call({ tool: "Bash", command: "ls" }))).toContain("ok");
});
