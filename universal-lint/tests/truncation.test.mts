// MAX_CONTEXT_CHARS output capping; ported from test/universal-lint/truncation.bats.
import assert from "node:assert/strict";
import { test } from "vitest";
import { makeEnv } from "./support/lint-hook.mts";

test("output over MAX_CONTEXT_CHARS is capped and marked truncated", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const r = e.run(e.file("a.sh", "echo $1\n"), { out: "x".repeat(5000) });
  assert.ok(r.ctx.endsWith("… (truncated)"));
});
