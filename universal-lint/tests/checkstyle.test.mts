// checkstyle output classification and config resolution; ported from test/universal-lint/checkstyle.bats.
import assert from "node:assert/strict";
import { test } from "vitest";
import { makeEnv } from "./support/lint-hook.mts";

test("checkstyle: boilerplate-only exit 0 -> {}", () => {
  const e = makeEnv();
  e.recStub("checkstyle", 0);
  assert.deepEqual(e.run(e.file("A.java", "class A {}\n"), { out: "Starting audit...\nAudit done." }).result, {});
});

test("checkstyle: boilerplate + warning-severity violation, exit 0 -> issues surfaced (proves NOT exit-code based)", () => {
  const e = makeEnv();
  e.recStub("checkstyle", 0);
  const r = e.run(e.file("A.java", "class A {}\n"), { out: "Starting audit...\n[WARN] A.java:1: Missing a Javadoc comment. [JavadocType]\nAudit done." });
  assert.match(r.ctx, /JavadocType/);
});

test("checkstyle: no 'Audit done.' (crash) -> {}", () => {
  const e = makeEnv();
  e.recStub("checkstyle", 1);
  assert.deepEqual(e.run(e.file("A.java", "class A {}\n"), { out: "Exception in thread \"main\" java.lang.RuntimeException: bad config" }).result, {});
});

test("checkstyle: project checkstyle.xml present -> -c <path to it> in recorded argv", () => {
  const e = makeEnv();
  e.file("checkstyle.xml", "<module name=\"Checker\"/>\n");
  e.recStub("checkstyle", 0);
  e.run(e.file("A.java", "class A {}\n"), { out: "Starting audit...\nAudit done." });
  assert.ok(e.lines().some((l) => l.includes(`-c ${e.cwd}/checkstyle.xml`)));
});

test("checkstyle: no project config -> -c /google_checks.xml in recorded argv", () => {
  const e = makeEnv();
  e.recStub("checkstyle", 0);
  e.run(e.file("A.java", "class A {}\n"), { out: "Starting audit...\nAudit done." });
  assert.ok(e.lines().some((l) => l.includes("-c /google_checks.xml")));
});
