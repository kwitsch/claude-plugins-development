// stylelint (SCSS/CSS); ported from test/universal-lint/stylelint.bats.
import assert from "node:assert/strict";
import { test } from "vitest";
import { makeEnv } from "./support/lint-hook.mts";

const OUT = "a.scss:1:1: Expected a trailing semicolon (declaration-block-trailing-semicolon)";

test("stylelint finds an issue (exit 2): additionalContext returned", () => {
  const e = makeEnv();
  e.recStub("stylelint", 2);
  const r = e.run(e.file("a.scss", ".a{color:red}\n"), { out: OUT });
  assert.match(r.ctx, /trailing-semicolon/);
  assert.ok(e.lines().some((l) => l.startsWith("stylelint ")));
});

test("stylelint clean (exit 0) -> {}", () => {
  const e = makeEnv();
  e.recStub("stylelint", 0);
  assert.deepEqual(e.run(e.file("a.scss", ".a{color:red;}\n")).result, {});
});

test("stylelint exit 1 (fatal error) -> {} (proves 0/2/else, not 0/1/else)", () => {
  const e = makeEnv();
  e.recStub("stylelint", 1);
  assert.deepEqual(e.run(e.file("a.scss", ".a{color:red;}\n"), { out: "SyntaxError: Unexpected token" }).result, {});
});

test("stylelint absent but npx present -> npx --yes stylelint fallback runs, issues surfaced", () => {
  const e = makeEnv();
  e.recStub("npx", 2);
  const f = e.file("a.scss", ".a{color:red}\n");
  const r = e.run(f, { out: OUT });
  assert.match(r.ctx, /trailing-semicolon/);
  assert.ok(e.lines().some((l) => l.includes(`npx --yes stylelint ${f}`)));
});

test("stylelint present on PATH -> npx never invoked even if present", () => {
  const e = makeEnv();
  e.recStub("stylelint", 0);
  e.recStub("npx", 0);
  assert.deepEqual(e.run(e.file("a.scss", ".a{color:red;}\n"), { out: "clean" }).result, {});
  assert.ok(e.lines().some((l) => l.startsWith("stylelint ")));
  assert.ok(!e.lines().some((l) => l.includes("npx")));
});

test("stylelint finds an issue on a .css file (exit 2): additionalContext returned", () => {
  const e = makeEnv();
  e.recStub("stylelint", 2);
  const r = e.run(e.file("a.css", ".a{color:red}\n"), { out: "a.css:1:1: Expected a trailing semicolon (declaration-block-trailing-semicolon)" });
  assert.match(r.ctx, /trailing-semicolon/);
  assert.ok(e.lines().some((l) => l.startsWith("stylelint ")));
});
