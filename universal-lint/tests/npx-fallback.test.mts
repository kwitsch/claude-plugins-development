// eslint npx fallback (present/absent); ported from test/universal-lint/npx-fallback.bats.
import assert from "node:assert/strict";
import { test } from "vitest";
import { makeEnv } from "./support/lint-hook.mts";

test("eslint absent but npx present -> npx --yes eslint fallback runs, issues surfaced", () => {
  const e = makeEnv();
  e.recStub("npx", 1);
  const f = e.file("a.js", "let x = 1\n");
  const r = e.run(f, { out: "a.js: 1:1  error  x is assigned a value but never used  no-unused-vars" });
  assert.match(r.ctx, /no-unused-vars/);
  assert.ok(e.lines().some((l) => l.includes(`npx --yes eslint ${f}`)));
});

test("eslint present on PATH -> npx never invoked even if present", () => {
  const e = makeEnv();
  e.recStub("eslint", 0);
  e.recStub("npx", 0); // present but must not be used
  assert.deepEqual(e.run(e.file("a.js", "let x = 1\n"), { out: "clean" }).result, {});
  assert.ok(e.lines().some((l) => l.startsWith("eslint ")));
  assert.ok(!e.lines().some((l) => l.includes("npx")));
});
