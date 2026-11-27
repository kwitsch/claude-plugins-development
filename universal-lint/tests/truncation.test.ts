// MAX_CONTEXT_CHARS output capping and MAX_BUFFER_BYTES output collection; ported from test/universal-lint/truncation.bats.
import assert from "node:assert/strict";
import { test } from "vitest";
import { MAX_CONTEXT_CHARS, truncate } from "../src/hooks/lint-core.ts";
import { makeEnv } from "./support/lint-hook.ts";

test("output over MAX_CONTEXT_CHARS is capped and marked truncated", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const r = e.run(e.file("a.sh", "echo $1\n"), { out: "x".repeat(5000) });
  assert.ok(r.ctx.endsWith("… (truncated)"));
});

/** Whether a string has no lone surrogate (`isWellFormed` needs a newer lib than the tests compile with). */
const wellFormed = (s: string): boolean => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

test("the cap cuts by code point: an emoji straddling it is dropped whole, no lone surrogate reaches the model", () => {
  const head = "x".repeat(MAX_CONTEXT_CHARS - 1);
  const cut = truncate(`${head}😀tail`); // the emoji's high surrogate is the MAX_CONTEXT_CHARS-th code unit
  assert.ok(wellFormed(cut));
  assert.equal(cut, `${head}\n… (truncated)`);
  const whole = truncate(`${head.slice(1)}😀tail`); // the emoji ends exactly at the cap: it stays
  assert.ok(wellFormed(whole));
  assert.equal(whole, `${head.slice(1)}😀\n… (truncated)`);
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
