// Process tests of delivery on the built server: detached lint runs, the outbox, the next_report wake poll and its carriers.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { FILE_CHANGED_SLOTS } from "../src/hooks/lint-core.ts";
import { type LintEnv, makeEnv } from "./support/lint-hook.ts";

/** The 4-line script the scenarios write. */
const SH4 = "echo a\necho $1\necho b\necho $2\n";
/** The same script after line 2 was fixed. */
const SH4_FIXED = "echo a\necho \"$1\"\necho b\necho $2\n";
/** What the stub shellcheck reports while the findings file holds it. */
const FINDING_L2 = "a.sh:2:6: note: line2-marker [SC2086]\n";
/** The marker of FINDING_L2 in a report. */
const MARKER = /line2-marker/;
/** Hold of the detached tests, in ms (`UNIVERSAL_LINT_SETTLE_MS`). */
const HOLD = "400";

/**
 * A hermetic env whose shellcheck stub logs a line to `$RECORD` and reports the content of the findings file, if any,
 * plus one server for session `s1` (interactive, detached mode unless `env` overrides it).
 *
 * @param env - Extra server environment.
 * @returns The env, the script, the findings switch, the server client and payload helpers.
 */
function setup(env: Record<string, string> = {}) {
  const e = makeEnv();
  const findings = path.join(path.dirname(e.record), "findings");
  writeFileSync(findings, "");
  // PATH holds no cat: print the file with bash builtins
  e.stub("shellcheck", "echo run >> \"$RECORD\"", "if [ -s \"$FINDINGS\" ]; then printf '%s\\n' \"$(< \"$FINDINGS\")\"; exit 1; fi", "exit 0");
  const file = e.file("a.sh", SH4);
  const s = e.server({ env: { FINDINGS: findings, UNIVERSAL_LINT_SETTLE_MS: HOLD, CLAUDE_CODE_ENTRYPOINT: "cli", ...env } });
  const setFindings = (text: string): void => writeFileSync(findings, text);
  const edit = (key: string, over: Record<string, unknown> = {}) => s.call("file_edited", { cwd: e.cwd, session_id: "s1", tool_name: "Write", tool_input: { file_path: file, content: SH4 }, tool_response: {}, key, ...over });
  const stop = (over: Record<string, unknown> = {}) => s.call("stop", { hook_event_name: "Stop", cwd: e.cwd, session_id: "s1", agent_id: "", scratchpad_dir: "", stop_hook_active: "false", ...over });
  const changed = (f: string = file) => s.call("file_changed", { cwd: e.cwd, session_id: "s1", scratchpad_dir: "", file_path: f, event: "change" });
  const prompt = () => s.call("prompt_submitted", { cwd: e.cwd, session_id: "s1", scratchpad_dir: "" });
  const poll = (key: string, wait_ms: unknown) => s.call("next_report", { session_id: "s1", key, wait_ms });
  return { e, file, s, setFindings, edit, stop, changed, prompt, poll };
}

/**
 * Whether a call is already answered: used only to assert that a call is still pending (order, not a time threshold).
 *
 * @typeParam T - The call's answer.
 * @param p - The call.
 * @returns True when it settled within a short grace.
 */
const settled = <T>(p: Promise<T>): Promise<boolean> => Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 50))]);

/**
 * Waits until the stub linter ran `runs` times (a detached run started its lint).
 *
 * @param e - The env.
 * @param runs - How many runs.
 */
async function linted(e: LintEnv, runs = 1): Promise<void> {
  await expect.poll(() => e.lines().length, { interval: 20, timeout: 10_000 }).toBeGreaterThanOrEqual(runs);
}

test("detached: file_edited answers at once, next_report wakes ready, the prompt carries the report exactly once", async () => {
  const w = setup();
  w.setFindings(FINDING_L2);
  const k = await w.s.key("s1");
  assert.deepEqual(await w.edit(k), {});
  assert.deepEqual(await w.poll(k, 25_000), { state: "ready" });
  const r = await w.prompt();
  const out = r["hookSpecificOutput"] as Record<string, unknown>;
  assert.equal(out["hookEventName"], "UserPromptSubmit");
  assert.match(String(out["additionalContext"]), MARKER);
  assert.deepEqual(await w.prompt(), {});
  assert.deepEqual(await w.stop(), {});
});

test("second carrier: a ready FileChanged report with no prompt goes out with the stop", async () => {
  const w = setup();
  w.setFindings(FINDING_L2);
  const k = await w.s.key("s1");
  assert.deepEqual(await w.changed(), {});
  assert.deepEqual(await w.poll(k, 25_000), { state: "ready" });
  const r = await w.stop();
  assert.equal(r["decision"], "block");
  assert.match(String(r["reason"]), MARKER);
  assert.deepEqual(await w.prompt(), {});
});

test("prompt_submitted resolves a pending waiter busy", async () => {
  const w = setup();
  const k = await w.s.key("s1");
  const p = w.poll(k, 25_000);
  assert.equal(await settled(p), false);
  assert.deepEqual(await w.prompt(), {});
  assert.deepEqual(await p, { state: "busy" });
});

test("a stray keyless next_report neither holds nor displaces the keyed waiter", async () => {
  const w = setup();
  w.setFindings(FINDING_L2);
  const k = await w.s.key("s1");
  const keyed = w.poll(k, 25_000);
  assert.deepEqual(await w.s.call("next_report", { session_id: "s1" }), { state: "busy" });
  assert.equal(await settled(keyed), false);
  await w.changed();
  assert.deepEqual(await keyed, { state: "ready" });
});

test("hold and supersede: a clean later edit of the file during the hold drops the held finding", async () => {
  const w = setup();
  w.setFindings(FINDING_L2);
  const k = await w.s.key("s1");
  assert.deepEqual(await w.edit(k), {});
  await linted(w.e);
  writeFileSync(w.file, SH4_FIXED);
  w.setFindings("");
  assert.deepEqual(await w.edit(k, { tool_input: { file_path: w.file, content: SH4_FIXED } }), {});
  assert.deepEqual(await w.poll(k, 1500), { state: "timeout" });
  assert.deepEqual(await w.stop(), {});
});

test("the sweep claims a held finding before the hold ends; nothing is delivered after it", async () => {
  const w = setup();
  w.setFindings(FINDING_L2);
  const k = await w.s.key("s1");
  assert.deepEqual(await w.edit(k), {});
  await linted(w.e);
  const r = await w.stop();
  assert.equal(r["decision"], "block");
  assert.match(String(r["reason"]), MARKER);
  assert.deepEqual(await w.poll(k, 1000), { state: "timeout" });
  assert.deepEqual(await w.prompt(), {});
});

test("a ready report rides the next keyed main file_edited answer", async () => {
  const w = setup();
  w.setFindings(FINDING_L2);
  const k = await w.s.key("s1");
  await w.changed();
  assert.deepEqual(await w.poll(k, 5000), { state: "ready" });
  w.setFindings("");
  const other = w.e.file("b.sh", "echo b\n");
  const r = await w.edit(k, { tool_input: { file_path: other, content: "echo b\n" } });
  assert.match(String(r["context"]), MARKER);
  assert.deepEqual(await w.stop(), {});
});

test("a subagent's edit wakes no one; only its SubagentStop reports it", async () => {
  const w = setup();
  w.setFindings(FINDING_L2);
  const k = await w.s.key("s1");
  assert.deepEqual(await w.edit(k, { agent_id: "A" }), {});
  assert.deepEqual(await w.poll(k, 800), { state: "timeout" });
  assert.deepEqual(await w.stop(), {});
  const r = await w.stop({ hook_event_name: "SubagentStop", agent_id: "A" });
  assert.equal(r["decision"], "block");
  assert.match(String(r["reason"]), MARKER);
});

test("detached: after a blocked stop, the fix edit's remaining finding is let through the stop and announced later", async () => {
  const w = setup();
  w.setFindings(FINDING_L2);
  const k = await w.s.key("s1");
  await w.edit(k);
  await linted(w.e);
  assert.equal((await w.stop())["decision"], "block");
  assert.deepEqual(await w.edit(k), {});
  assert.deepEqual(await w.stop({ stop_hook_active: "true" }), {});
  assert.deepEqual(await w.poll(k, 5000), { state: "ready" });
});

test("inline: after a blocked stop, the fix edit's remaining finding is the context of its answer", async () => {
  const w = setup({ UNIVERSAL_LINT_SETTLE_MS: "0" });
  w.setFindings(FINDING_L2);
  const k = await w.s.key("s1");
  await w.changed();
  assert.equal((await w.stop())["decision"], "block");
  assert.match(String((await w.edit(k))["context"]), MARKER);
  assert.deepEqual(await w.stop({ stop_hook_active: "true" }), {});
});

test("headless never waits: a keyed long-poll answers busy at once", async () => {
  const w = setup({ CLAUDE_CODE_ENTRYPOINT: "sdk-cli" });
  const k = await w.s.key("s1");
  assert.deepEqual(await w.poll(k, 25_000), { state: "busy" });
});

test("clamp: a short wait_ms times out; a non-numeric one waits the default until a prompt ends it", async () => {
  const w = setup();
  const k = await w.s.key("s1");
  assert.deepEqual(await w.poll(k, 300), { state: "timeout" });
  const p = w.poll(k, "x");
  assert.equal(await settled(p), false);
  await w.prompt();
  assert.deepEqual(await p, { state: "busy" });
});

test("stdin close ends the server with a waiter and a detached lint pending, and kills the linter", async () => {
  const e = makeEnv();
  const pidfile = path.join(path.dirname(e.cwd), "sleep.pid");
  // node, not sleep: the server's PATH holds only bash/node/git
  e.stub("shellcheck", `node -e "setTimeout(() => {}, 30000)" & echo $! > "${pidfile}"`, "wait");
  const file = e.file("a.sh", SH4);
  const s = e.server({ env: { UNIVERSAL_LINT_SETTLE_MS: HOLD, CLAUDE_CODE_ENTRYPOINT: "cli" } });
  const k = await s.key("s1");
  void s.call("next_report", { session_id: "s1", key: k, wait_ms: 25_000 });
  assert.deepEqual(await s.call("file_edited", { cwd: e.cwd, session_id: "s1", tool_name: "Write", tool_input: { file_path: file, content: SH4 }, tool_response: {}, key: k }), {});
  await expect.poll(() => existsSync(pidfile) && readFileSync(pidfile, "utf8").trim() !== "", { interval: 50, timeout: 10_000 }).toBe(true);
  const pid = Number(readFileSync(pidfile, "utf8"));
  assert.equal(await s.close(), 0);
  await expect.poll(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, { interval: 50, timeout: 2000 }).toBe(true);
});

test("a stop is answered while K FileChanged lints block and one more waits for a slot", async () => {
  const w = setup();
  const rel = path.join(path.dirname(w.e.cwd), "release");
  // records a line, then blocks until the release file exists (node, not sleep: the PATH holds only bash/node/git)
  w.e.stub("shellcheck", "echo run >> \"$RECORD\"", `node -e 'const fs = require("fs"); const t = () => { if (!fs.existsSync(${JSON.stringify(rel)})) setTimeout(t, 20); }; t();'`, "exit 0");
  const files = Array.from({ length: FILE_CHANGED_SLOTS + 1 }, (_, i) => w.e.file(`b${i}.sh`, "echo b\n"));
  for (const f of files) assert.deepEqual(await w.changed(f), {});
  await linted(w.e, FILE_CHANGED_SLOTS);
  // a SubagentStop of an agent without records: the main Stop's sweep would lint the K pending files with the blocking stub
  assert.deepEqual(await w.stop({ hook_event_name: "SubagentStop", agent_id: "idle" }), {});
  writeFileSync(rel, "");
  await linted(w.e, FILE_CHANGED_SLOTS + 1);
});
