// Per-file idle-window debounce (token marker); ported from test/universal-lint/debounce.bats.
// Small non-zero windows via UNIVERSAL_LINT_DEBOUNCE_MS keep the tests fast.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "vitest";
import { makeEnv } from "./support/lint-hook.mts";

const OUT = "a.sh:1:6: note: something [SC2086]";

test("debounce: two rapid edits to one file run the linter once (older invocation superseded)", async () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const f = e.file("a.sh", "echo $1\n");
  const first = e.start(f, { out: OUT, debounceMs: "400" }); // writes its token, sleeps, then bails (superseded)
  await sleep(100);
  const second = e.start(f, { out: OUT, debounceMs: "400" }); // newer token, wins, runs the linter
  await Promise.all([first.done, second.done]);
  assert.equal(e.lines().length, 1);
});

test("debounce: a single edit with a non-zero window still runs the linter exactly once", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const r = e.run(e.file("a.sh", "echo $1\n"), { out: OUT, debounceMs: "200" });
  assert.equal(e.lines().length, 1);
  assert.match(r.ctx, /SC2086/);
});

test("debounce: UNIVERSAL_LINT_DEBOUNCE_MS=0 runs the linter immediately (test fast-path)", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  e.run(e.file("a.sh", "echo $1\n"), { out: OUT, debounceMs: "0" });
  assert.equal(e.lines().length, 1);
});

test("debounce: an explicitly empty UNIVERSAL_LINT_DEBOUNCE_MS falls back to the script's real 5000ms default, not an immediate run", async () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  // real default is 5000ms, far longer than this test waits
  const { child, done } = e.start(e.file("a.sh", "echo $1\n"), { out: OUT, debounceMs: "" });
  await sleep(300);
  assert.equal(e.lines().length, 0); // still debouncing: "" did not coerce to an immediate run
  child.kill();
  await done;
});
