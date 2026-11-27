// Unit tests of the per-call context and the state cap of src/hooks/lint-core.ts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test, vi } from "vitest";
import { callCancelled, CANCELLED, capSet, configExists, editedHandler, markBlocked, ownerOf, recordEdit, runInCall, settleFindings, settleWaitMs, spawnGroup, STATE_CAP, stopAlreadyBlocked } from "../src/hooks/lint-core.ts";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.UNIVERSAL_LINT_SETTLE_MS;
});

test("callCancelled: true only for a client cancel, not for the call's own deadline, and false outside a call", async () => {
  assert.equal(callCancelled(), false);
  for (const [reason, expected] of [[CANCELLED, true], ["deadline", false], [undefined, false]] as const) {
    const c = new AbortController();
    assert.equal(await runInCall(c.signal, async () => callCancelled()), false, "not aborted yet");
    c.abort(reason);
    assert.equal(await runInCall(c.signal, async () => callCancelled()), expected, String(reason));
  }
});

test("capSet: past STATE_CAP the oldest entry is dropped, the newest kept; exactly STATE_CAP entries are all kept", () => {
  const m = new Map<number, number>();
  for (let i = 0; i < STATE_CAP; i++) capSet(m, i, i);
  assert.equal(m.size, STATE_CAP);
  assert.ok(m.has(0));
  capSet(m, STATE_CAP, 1);
  assert.equal(m.size, STATE_CAP);
  assert.equal(m.has(0), false);
  assert.ok(m.has(STATE_CAP));
});

test("capSet: re-setting an existing key makes it the newest (it survives the next drop)", () => {
  const m = new Map<number, number>();
  for (let i = 0; i < STATE_CAP; i++) capSet(m, i, i);
  capSet(m, 0, 9);
  capSet(m, STATE_CAP, 1);
  assert.equal(m.get(0), 9);
  assert.equal(m.has(1), false);
});

test("runInCall: deadlines count from the call's start, not from process start", async () => {
  process.env.UNIVERSAL_LINT_SETTLE_MS = "1000000000";
  vi.spyOn(process, "uptime").mockReturnValue(50);
  assert.equal(settleWaitMs(), 89_000 - 50_000, "no call context: process uptime");
  const now = vi.spyOn(performance, "now").mockReturnValueOnce(1_000_000).mockReturnValue(1_000_500);
  assert.equal(await runInCall(new AbortController().signal, async () => settleWaitMs()), 89_000 - 500);
  now.mockRestore();
});

test("runInCall: an aborted signal makes spawnGroup spawn nothing (pre-spawn error shape)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ul-cc-"));
  const mark = path.join(dir, "ran");
  const c = new AbortController();
  c.abort();
  const r = await runInCall(c.signal, () => spawnGroup(process.execPath, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(mark)}, "")`], { cwd: dir, encoding: "utf8" }));
  assert.equal(r.status, null);
  assert.equal(r.signal, null);
  assert.equal(r.stdout, "");
  assert.ok(r.error);
  assert.throws(() => writeFileSync(mark, "", { flag: "wx" }) === undefined && assert.fail("marker absent as expected"), /marker absent/);
});

test("runInCall: an abort during the run kills the child's group", async () => {
  const c = new AbortController();
  const p = runInCall(c.signal, () => spawnGroup(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { cwd: tmpdir(), encoding: "utf8", timeout: 20_000 }));
  setTimeout(() => c.abort(), 200);
  const r = await p;
  assert.notEqual(r.status, 0);
  assert.ok(r.signal === "SIGTERM" || r.signal === "SIGKILL");
});

test("runInCall clears the per-call memos: a config created between two calls is seen", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ul-cc-"));
  const sig = new AbortController().signal;
  assert.equal(await runInCall(sig, async () => configExists(dir, "x.json", true)), false);
  writeFileSync(path.join(dir, "x.json"), "{}");
  assert.equal(await runInCall(sig, async () => configExists(dir, "x.json", true)), true);
});

test("stopAlreadyBlocked / markBlocked: a marked owner's active stop is let through; a fresh stop clears the marker", () => {
  const args = { cwd: "", session_id: "cc-s1" };
  assert.equal(stopAlreadyBlocked({ ...args, stop_hook_active: true }), false, "no marker: sweep");
  markBlocked(ownerOf(args));
  assert.equal(stopAlreadyBlocked({ ...args, stop_hook_active: true }), true);
  assert.equal(stopAlreadyBlocked({ ...args, stop_hook_active: false }), false);
  assert.equal(stopAlreadyBlocked({ ...args, stop_hook_active: true }), false, "the fresh stop cleared it");
});

test("editedHandler: out of scope answers {} (the old PostToolUse branch of main)", async () => {
  assert.deepEqual(await editedHandler({ cwd: tmpdir(), tool_name: "Write", tool_input: { file_path: "/nonexistent/a.json" } }), {});
});

test("two records in the same millisecond sort in append order", async () => {
  process.env.UNIVERSAL_LINT_SETTLE_MS = "0";
  const dir = mkdtempSync(path.join(tmpdir(), "ul-cc-seq-"));
  const fp = path.join(dir, "a.sh");
  writeFileSync(fp, "echo a\n");
  const d = createHash("sha256").update("echo a\n").digest("base64");
  const owner = ownerOf({ cwd: "", session_id: "cc-seq" });
  const f = { tool: "shellcheck", target: "a.sh", base: dir, text: "a.sh:1:1: note: m [SC2086]" };
  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  const a = recordEdit(fp, fp, null, null, null, owner);
  const b = recordEdit(fp, fp, null, null, null, owner);
  assert.ok(a && b);
  assert.ok(a.name < b.name);
  assert.deepEqual(await settleFindings([f], fp, a, d, d, owner), [], "the newer record owns the report");
  assert.deepEqual(await settleFindings([f], fp, b, d, d, owner), [f]);
});
