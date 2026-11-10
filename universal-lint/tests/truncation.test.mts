// MAX_CONTEXT_CHARS output capping and MAX_BUFFER_BYTES output collection; ported from test/universal-lint/truncation.bats.
import assert from "node:assert/strict";
import { test } from "vitest";
import { makeEnv } from "./support/lint-hook.mts";

test("output over MAX_CONTEXT_CHARS is capped and marked truncated", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const r = e.run(e.file("a.sh", "echo $1\n"), { out: "x".repeat(5000) });
  assert.ok(r.ctx.endsWith("… (truncated)"));
});

/** Filler lines the stub prints after the located line: "lorem ipsum dolor\n" x 120,000 = 2.16 MB, above spawnSync's 1 MiB default, below MAX_BUFFER_BYTES (10 MiB). */
const FILLER_LINES = 120_000;

test("output over 1 MiB keeps its finding and is truncated", () => {
  const e = makeEnv();
  e.stub(
    "shellcheck",
    `node -e 'process.stdout.write("a.sh:1:6: note: Double quote to prevent globbing. [SC2086]\\n" + "lorem ipsum dolor\\n".repeat(${FILLER_LINES}))'`,
    "exit 1",
  );
  const r = e.run(e.file("a.sh", "echo $1\n"));
  assert.equal(r.status, 2);
  assert.ok(r.ctx.includes("a.sh:1:6: note: Double quote to prevent globbing. [SC2086]"));
  assert.ok(r.ctx.endsWith("… (truncated)"));
  assert.ok(r.ctx.length < 5000);
});
