// rtk detection and fallback behavior; ported from test/universal-lint/rtk.bats.
import assert from "node:assert/strict";
import { test } from "vitest";
import { makeEnv } from "./support/lint-hook.mts";

const SC = "a.sh:1:6: note: Double quote to prevent globbing. [SC2086]";
const ESLINT = "a.js: 1:1  error  x is assigned a value but never used  no-unused-vars";

test("rtk: shellcheck on PATH + rtk supports it -> lint runs via rtk, issues surfaced", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  e.rtkStub("shellcheck", 1);
  const f = e.file("a.sh", "echo $1\n");
  const r = e.run(f, { out: SC });
  assert.match(r.ctx, /SC2086/);
  assert.ok(e.lines().some((l) => l.includes(`rtk shellcheck ${f}`)));
  assert.ok(!e.lines().some((l) => l.startsWith("shellcheck ")));
});

test("rtk: checkstyle unsupported by rtk -> falls through to direct invocation", () => {
  const e = makeEnv();
  e.recStub("checkstyle", 0);
  e.stub("rtk", "if [ \"$1\" = \"rewrite\" ]; then exit 1; fi", "echo \"rtk should not run the actual tool\" >&2", "exit 1");
  assert.deepEqual(e.run(e.file("A.java", "class A {}\n"), { out: "Starting audit...\nAudit done." }).result, {});
  assert.ok(e.lines().some((l) => l.startsWith("checkstyle ")));
});

test("rtk: rtk supports the tool but the run itself is killed -> falls back to direct invocation", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  e.stub("rtk", "if [ \"$1\" = \"rewrite\" ]; then printf \"rtk shellcheck __RTK_PROBE__\\n\"; exit 3; fi", "kill -KILL $$");
  const r = e.run(e.file("a.sh", "echo $1\n"), { out: SC });
  assert.match(r.ctx, /SC2086/);
  assert.ok(e.lines().some((l) => l.startsWith("shellcheck ")));
});

test("rtk: a clean non-zero exit with empty stdout (rtk-internal failure) falls back to direct invocation, not misreported as a finding", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  e.stub(
    "rtk",
    "if [ \"$1\" = \"rewrite\" ]; then printf \"rtk shellcheck __RTK_PROBE__\\n\"; exit 3; fi",
    "echo \"rtk: internal error, could not reach backend\" >&2",
    "exit 2",
  );
  const r = e.run(e.file("a.sh", "echo $1\n"), { out: SC });
  assert.match(r.ctx, /SC2086/);
  assert.doesNotMatch(r.ctx, /internal error/);
  assert.ok(e.lines().some((l) => l.startsWith("shellcheck ")));
});

test("rtk: npx-fallback tool routes through rtk's own discovered verb, not a raw npx wrap", () => {
  const e = makeEnv();
  e.rtkStub("lint", 1);
  // npx must be present on PATH (eslint's npmSpec candidacy requires it) but must never run once rtk succeeds
  e.stub("npx", "printf \"%s %s\\n\" \"npx\" \"$*\" >> \"$RECORD\"", "echo \"npx should not run when rtk succeeds\" >&2", "exit 1");
  const f = e.file("a.js", "let x = 1\n");
  const r = e.run(f, { out: "ESLint: 1 errors, 0 warnings in 1 files" });
  assert.match(r.ctx, /ESLint/);
  assert.ok(e.lines().some((l) => l.includes(`rtk lint ${f}`)));
  assert.ok(!e.lines().some((l) => l.includes("npx")));
});

test("rtk: npx-fallback falls back to bare npx when the rtk call errors", () => {
  const e = makeEnv();
  e.stub("rtk", "kill -KILL $$");
  e.recStub("npx", 1);
  const f = e.file("a.js", "let x = 1\n");
  const r = e.run(f, { out: ESLINT });
  assert.match(r.ctx, /no-unused-vars/);
  assert.ok(e.lines().some((l) => l.includes(`npx --yes eslint ${f}`)));
});

test("rtk: npx-fallback tool's discovered verb invocation fails (real binary missing) -> falls back to bare npx", () => {
  const e = makeEnv();
  e.stub(
    "rtk",
    "if [ \"$1\" = \"rewrite\" ]; then printf \"rtk lint __RTK_PROBE__\\n\"; exit 3; fi",
    "echo \"[rtk: No such file or directory (os error 2)]\" >&2",
    "exit 127",
  );
  e.recStub("npx", 1);
  const f = e.file("a.js", "let x = 1\n");
  const r = e.run(f, { out: ESLINT });
  assert.match(r.ctx, /no-unused-vars/);
  assert.ok(e.lines().some((l) => l.includes(`npx --yes eslint ${f}`)));
});
