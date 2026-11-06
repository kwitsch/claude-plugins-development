// yamllint findings, clean and the line-length guard; ported from test/universal-lint/yaml.bats.
import assert from "node:assert/strict";
import { test } from "vitest";
import { makeEnv } from "./support/lint-hook.mts";

test("yamllint finds an issue: additionalContext returned", () => {
  const e = makeEnv();
  e.recStub("yamllint", 1);
  const r = e.run(e.file("a.yaml", "a:   1\n"), { out: "a.yaml:1:4: [warning] too many spaces after colon (colons)" });
  assert.match(r.ctx, /colons/);
  assert.ok(e.lines().some((l) => l.startsWith("yamllint ")));
});

test("yamllint clean (exit 0) -> {}", () => {
  const e = makeEnv();
  e.recStub("yamllint", 0);
  assert.deepEqual(e.run(e.file("a.yaml", "a: 1\n")).result, {});
});

test("yaml: no project .yamllint config -> -d disables line-length (recorded argv)", () => {
  const e = makeEnv();
  e.recStub("yamllint", 0);
  e.run(e.file("a.yaml", "a: 1\n"));
  assert.ok(e.lines().some((l) => l.includes("rules: {line-length: disable}")));
});

test("yaml: project .yamllint present -> no -d override, yamllint runs bare", () => {
  const e = makeEnv();
  e.file(".yamllint", "extends: default\n");
  e.recStub("yamllint", 0);
  const f = e.file("a.yaml", "a: 1\n");
  e.run(f);
  assert.ok(!e.lines().some((l) => l.includes("line-length: disable")));
  assert.ok(e.lines().some((l) => l.includes(`yamllint ${f}`)));
});
