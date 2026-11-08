// Pure tests of the built plugin/hooks/policy.mjs.
import assert from "node:assert/strict";
import { test } from "vitest";
import { gateBash, inScratchpad } from "../plugin/hooks/policy.mjs";

const ROOTS = ["/tmp"];
const SP = "/tmp/claude-1000/-proj/sid-1/scratchpad";

test("inScratchpad accepts a file inside this session's scratchpad", () => {
  assert.equal(inScratchpad(`${SP}/notes.md`, "sid-1", ROOTS), true);
  assert.equal(inScratchpad(`${SP}/a/b/c.txt`, "sid-1", ROOTS), true);
  assert.equal(inScratchpad(`${SP}/./x/../notes.md`, "sid-1", ROOTS), true);
});

test("inScratchpad rejects other sessions, the directory itself, traversal, relative paths and foreign roots", () => {
  assert.equal(inScratchpad("/tmp/claude-1000/-proj/sid-2/scratchpad/x", "sid-1", ROOTS), false);
  assert.equal(inScratchpad(SP, "sid-1", ROOTS), false);
  assert.equal(inScratchpad(`${SP}/`, "sid-1", ROOTS), false);
  assert.equal(inScratchpad(`${SP}/../../../../etc/x`, "sid-1", ROOTS), false);
  assert.equal(inScratchpad("scratchpad/x", "sid-1", ROOTS), false);
  assert.equal(inScratchpad("", "sid-1", ROOTS), false);
  assert.equal(inScratchpad("/home/u/claude-1000/-proj/sid-1/scratchpad/x", "sid-1", ROOTS), false);
  assert.equal(inScratchpad("/tmp/claude-abc/-proj/sid-1/scratchpad/x", "sid-1", ROOTS), false);
  assert.equal(inScratchpad("/tmp/claude-1000/-proj/sid-1/other/x", "sid-1", ROOTS), false);
  assert.equal(inScratchpad(`${SP}/x`, "", ROOTS), false);
  assert.equal(inScratchpad(`${SP}/x`, "sid-1", []), false);
});

test("inScratchpad honours a custom root with a trailing slash", () => {
  assert.equal(inScratchpad("/var/folders/T/claude-501/-proj/sid-1/scratchpad/x", "sid-1", ["/var/folders/T/", "/tmp"]), true);
  assert.equal(inScratchpad("/var/folders/T/claude-501/-proj/sid-1/scratchpad/x", "sid-1", ["/tmp"]), false);
});

const danger = (p: number) => ({ type: "score" as const, score: 2 * p, probabilities: { "0": 0, "1": 1 - p, "2": p }, confidence: 0.9 });

test("gateBash only ever denies: dangerous and out of scope", () => {
  assert.equal(gateBash(danger(0.95), 0.03)?.decision, "deny");
  assert.equal(gateBash(danger(0.95), 0.9), undefined);
  assert.equal(gateBash(danger(0.95), undefined), undefined);
  assert.equal(gateBash(danger(0.6), 0.03), undefined);
  assert.equal(gateBash(undefined, 0.03), undefined);
});
