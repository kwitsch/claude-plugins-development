import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hook = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugin/hooks/__EVENT_KEBAB__.mjs");

test("__EVENT__ hook exits 0 and emits JSON", () => {
  const r = spawnSync("node", [hook], {
    input: JSON.stringify({ session_id: "t", hook_event_name: "__EVENT__" }),
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "__EVENT__");
});
