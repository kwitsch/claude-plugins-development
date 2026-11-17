// Tests for the built plugin/hooks/stop.mjs of rc-enhancement: the Stop hook that gates a bare plain-text question.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugin/hooks/stop.mjs");

/**
 * Runs the hook on a Stop payload.
 *
 * @param payload - The stdin JSON, or raw text.
 * @returns The parsed stdout (undefined when the hook stayed silent).
 */
const run = (payload: unknown): { decision?: string; reason?: string } | undefined => {
  const r = spawnSync("node", [script], { input: typeof payload === "string" ? payload : JSON.stringify(payload), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout === "" ? undefined : JSON.parse(r.stdout) as { decision?: string; reason?: string };
};

test("a main-session answer ending in a bare question is blocked with a reason that points at the session rule", () => {
  const out = run({ last_assistant_message: "Done.\n```\nwhy?\n```\nWant me to X or Y?" });
  assert.equal(out?.decision, "block");
  assert.ok(out?.reason?.includes("AskUserQuestion"));
  assert.ok(out?.reason?.includes("CRITICAL RULE"));
});

const quiet = [
  ["a plain answer", { last_assistant_message: "All done. Summary above." }],
  ["an empty answer", { last_assistant_message: "" }],
  ["a question inside a code fence", { last_assistant_message: "Result:\n```\nwhat?\n```" }],
  ["a question that is not the last line", { last_assistant_message: "Is it?\nYes, it is." }],
  ["a missing last message", {}],
  ["a stop a Stop hook already continued (stop_hook_active)", { stop_hook_active: true, last_assistant_message: "Which one?" }],
  ["a subagent (agent_id)", { agent_id: "a1", last_assistant_message: "Which file?" }],
] as const;

for (const [name, payload] of quiet) {
  test(`no block for ${name}`, () => {
    assert.equal(run(payload), undefined);
  });
}

test("an unreadable payload fails open", () => {
  assert.equal(run("not json"), undefined);
});
