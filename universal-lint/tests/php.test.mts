// PHP (phpstan/psalm) fallback and classification cases; ported from test/universal-lint/php.bats.
import assert from "node:assert/strict";
import { test } from "vitest";
import { makeEnv } from "./support/lint-hook.mts";

test("phpstan on PATH, reports issues (exit 1) -> additionalContext returned", () => {
  const e = makeEnv();
  e.recStub("phpstan", 1);
  const f = e.file("a.php", "<?php echo $undefinedVar;\n");
  const r = e.run(f, { out: "a.php:1: Undefined variable: $undefinedVar" });
  assert.match(r.ctx, /Undefined variable/);
  assert.ok(e.lines().some((l) => l.includes(`phpstan analyse ${f}`)));
});

test("phpstan absent, psalm on PATH, reports issues (exit 2) -> additionalContext returned", () => {
  const e = makeEnv();
  e.recStub("psalm", 2);
  const f = e.file("a.php", "<?php echo $undefinedVar;\n");
  const r = e.run(f, { out: "ERROR: PossiblyUndefinedVariable" });
  assert.match(r.ctx, /PossiblyUndefinedVariable/);
  assert.ok(e.lines().some((l) => l.includes(`psalm ${f}`)));
});

test("psalm exits 1 (problem running, e.g. missing config) -> treated as skip, no output", () => {
  const e = makeEnv();
  e.recStub("psalm", 1);
  assert.deepEqual(e.run(e.file("a.php", "<?php echo $undefinedVar;\n"), { out: "Could not locate a config XML file" }).result, {});
});
