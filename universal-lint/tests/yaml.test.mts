// yamllint findings, clean and the line-length guard; ported from test/universal-lint/yaml.bats.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
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

test("yaml: user-global ~/.config/yamllint/config present -> no -d override (it would replace that config)", () => {
  const e = makeEnv();
  mkdirSync(path.join(e.home, ".config", "yamllint"), { recursive: true });
  writeFileSync(path.join(e.home, ".config", "yamllint", "config"), "extends: relaxed\n");
  e.recStub("yamllint", 0);
  const f = e.file("a.yaml", "a: 1\n");
  e.run(f);
  assert.ok(!e.lines().some((l) => l.includes("line-length: disable")));
  assert.ok(e.lines().some((l) => l.includes(`yamllint ${f}`)));
});

test("yaml: $YAMLLINT_CONFIG_FILE names a missing file -> -d guard stays (yamllint does not fall back to XDG)", () => {
  const e = makeEnv();
  mkdirSync(path.join(e.home, ".config", "yamllint"), { recursive: true });
  writeFileSync(path.join(e.home, ".config", "yamllint", "config"), "extends: relaxed\n");
  e.recStub("yamllint", 0);
  e.run(e.file("a.yaml", "a: 1\n"), { env: { YAMLLINT_CONFIG_FILE: "~/missing" } });
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
