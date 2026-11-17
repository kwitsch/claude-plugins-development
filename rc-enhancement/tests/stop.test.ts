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

test("a main-session answer whose closing paragraph asks a question is blocked with a reason that points at the session rule", () => {
  const out = run({ last_assistant_message: "Done.\n```\nwhy?\n```\nWant me to X or Y?" });
  assert.equal(out?.decision, "block");
  assert.ok(out?.reason?.includes("AskUserQuestion"));
  assert.ok(out?.reason?.includes("CRITICAL RULE"));
  assert.ok(out?.reason?.includes("bullet list"));
});

const asked = [
  ["a question followed by more sentences in the same paragraph", "Intro.\n\nWhich file? Then I continue. Afterwards I stop."],
  ["a question on its own line with text after it in the paragraph", "Which file?\nI will wait."],
  ["a question in a closing list", "Options:\n- A\n- Which one?"],
] as const;

for (const [name, message] of asked) {
  test(`block for ${name}`, () => {
    assert.equal(run({ last_assistant_message: message })?.decision, "block");
  });
}

const quiet = [
  ["a plain answer", { last_assistant_message: "All done. Summary above." }],
  ["an empty answer", { last_assistant_message: "" }],
  ["a question inside a code fence", { last_assistant_message: "Result:\n```\nwhat?\n```" }],
  ["a question in an earlier paragraph", { last_assistant_message: "Is it?\n\nYes, it is." }],
  ["a question in inline code", { last_assistant_message: "Use `a ? b : c` here." }],
  ["a quoted question", { last_assistant_message: "He wrote:\n> Which one?\nDone." }],
  ["a ? inside a URL", { last_assistant_message: "See https://example.com/x?y=1 for details." }],
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
