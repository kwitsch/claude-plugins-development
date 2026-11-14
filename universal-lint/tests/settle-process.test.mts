// Settle window (F34) at process level: real hook processes, a stub shellcheck whose findings a test can switch.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "vitest";
import { hashPath } from "../plugin/hooks/lint-file.mjs";
import { HOOK, type LintEnv, makeEnv, payload } from "./support/lint-hook.mts";

/** The 4-line script the scenarios edit. */
const SH4 = "echo a\necho $1\necho b\necho $2\n";
/** The same script after line 2 was rewritten. */
const SH4_FIXED = "echo a\necho \"$1\"\necho b\necho $2\n";
/** Edit hunks replacing line 2. */
const EDIT_L2 = { structuredPatch: [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: [" echo a", "-echo $1", "+echo \"$1\"", " echo b", " echo $2"] }] };
/** Edit hunks replacing line 4. */
const EDIT_L4 = { structuredPatch: [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: [" echo b", "-echo $2", "+echo \"$2\""] }] };
/** What the stub shellcheck reports for line 2. */
const FINDING_L2 = "a.sh:2:6: note: line2-marker [SC2086]\n";

/** Outcome of one hook process. */
interface Ran {
  status: number | null;
  stderr: string;
  stdout: string;
  ms: number;
}

/** A hermetic env whose shellcheck stub logs a line to `$RECORD` and reports the content of the findings file, if any. */
function setup(): { e: LintEnv; file: string; findings: string; setFindings(text: string): void } {
  const e = makeEnv();
  const findings = path.join(path.dirname(e.record), "findings");
  writeFileSync(findings, "");
  // PATH holds no cat: print the file with bash builtins
  e.stub("shellcheck", "echo run >> \"$RECORD\"", "if [ -s \"$FINDINGS\" ]; then printf '%s\\n' \"$(< \"$FINDINGS\")\"; exit 1; fi", "exit 0");
  const file = e.file("a.sh", SH4);
  return { e, file, findings, setFindings: (text) => writeFileSync(findings, text) };
}

/** Start one hook process and resolve with its outcome when it exits. */
function start(e: LintEnv, findings: string, input: string, env: Record<string, string>): Promise<Ran> {
  const t0 = Date.now();
  const child = spawn(process.execPath, [HOOK], { env: e.childEnv({ env: { FINDINGS: findings, ...env } }), stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stdin.end(input);
  return new Promise((resolve) => child.on("close", (status) => resolve({ status, stderr, stdout, ms: Date.now() - t0 })));
}

/** Wait until the stub linter of a hook ran (a line in `$RECORD`), then a little longer so the hook is inside its hold. */
async function intoHold(e: LintEnv, runs = 1): Promise<void> {
  await expect.poll(() => e.lines().length, { interval: 20, timeout: 10_000 }).toBeGreaterThanOrEqual(runs);
  await sleep(400);
}

/** The journal files of the env (empty when the directory does not exist). */
const journal = (e: LintEnv): string[] => (existsSync(path.join(e.data, "settle")) ? readdirSync(path.join(e.data, "settle")) : []);

test("a finding is held for the settle window, a clean lint is not", async () => {
  const s = setup();
  const edit = payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: EDIT_L2 });
  const clean = await start(s.e, s.findings, edit, { UNIVERSAL_LINT_SETTLE_MS: "700" });
  s.setFindings(FINDING_L2);
  const held = await start(s.e, s.findings, edit, { UNIVERSAL_LINT_SETTLE_MS: "700" });
  assert.equal(clean.status, 0);
  assert.equal(held.status, 2);
  assert.match(held.stderr, /line2-marker/);
  assert.ok(held.ms - clean.ms >= 500, `held ${held.ms} ms, clean ${clean.ms} ms`);
});

test("a later edit that rewrote the finding's line without reproducing the error: the first finding is not reported", async () => {
  const s = setup();
  s.setFindings(FINDING_L2);
  const first = start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: EDIT_L2 }), { UNIVERSAL_LINT_SETTLE_MS: "3000" });
  await intoHold(s.e);
  writeFileSync(s.file, SH4_FIXED);
  s.setFindings("");
  const second = await start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: EDIT_L2 }), {});
  const firstRan = await first;
  assert.equal(second.status, 0);
  assert.equal(firstRan.status, 0);
  assert.equal(firstRan.stderr, "");
  assert.ok(firstRan.ms >= 2500, "the first process held for the window");
});

test("a later edit elsewhere: the first finding is still reported", async () => {
  const s = setup();
  s.setFindings(FINDING_L2);
  const first = start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: EDIT_L2 }), { UNIVERSAL_LINT_SETTLE_MS: "2000" });
  await intoHold(s.e);
  writeFileSync(s.file, SH4.replace("$2", "\"$2\""));
  s.setFindings("");
  const second = await start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: EDIT_L4 }), {});
  const firstRan = await first;
  assert.equal(second.status, 0);
  assert.equal(firstRan.status, 2);
  assert.match(firstRan.stderr, /line2-marker/);
});

test("a later edit of the line that still has the error: the later edit reports it, the first one is dropped", async () => {
  const s = setup();
  s.setFindings(FINDING_L2);
  const first = start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: EDIT_L2 }), { UNIVERSAL_LINT_SETTLE_MS: "2000" });
  await intoHold(s.e);
  writeFileSync(s.file, SH4_FIXED);
  const second = await start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: EDIT_L2 }), {});
  const firstRan = await first;
  assert.equal(second.status, 2);
  assert.match(second.stderr, /line2-marker/);
  assert.equal(firstRan.status, 0);
  assert.equal(firstRan.stderr, "");
});

test("a later Write drops the earlier findings of the file", async () => {
  const s = setup();
  s.setFindings(FINDING_L2);
  const first = start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: EDIT_L2 }), { UNIVERSAL_LINT_SETTLE_MS: "2000" });
  await intoHold(s.e);
  writeFileSync(s.file, "echo rewritten\n");
  s.setFindings("");
  const second = await start(s.e, s.findings, payload(s.file, s.e.cwd), {});
  assert.equal(second.status, 0);
  assert.equal((await first).status, 0);
});

test("FileChanged outside Write/Edit supersedes a held finding", async () => {
  const s = setup();
  s.setFindings(FINDING_L2);
  const first = start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: EDIT_L2 }), { UNIVERSAL_LINT_SETTLE_MS: "2000" });
  await intoHold(s.e);
  writeFileSync(s.file, "echo changed by a formatter\n");
  s.setFindings("");
  const changed = await start(s.e, s.findings, JSON.stringify({ hook_event_name: "FileChanged", cwd: s.e.cwd, file_path: s.file, event: "change" }), {});
  assert.equal(changed.status, 0);
  assert.equal((await first).status, 0);
});

test("the FileChanged echo of a Write/Edit is no later edit: it records nothing and the finding is reported", async () => {
  const s = setup();
  s.setFindings(FINDING_L2);
  const first = start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: EDIT_L2 }), { UNIVERSAL_LINT_SETTLE_MS: "1500" });
  await intoHold(s.e);
  const before = journal(s.e);
  const echo = await start(s.e, s.findings, JSON.stringify({ hook_event_name: "FileChanged", cwd: s.e.cwd, file_path: s.file, event: "change" }), {});
  assert.equal(echo.status, 0);
  assert.deepEqual(journal(s.e), before);
  assert.equal(s.e.lines().length, 1, "the echo did not lint");
  const firstRan = await first;
  assert.equal(firstRan.status, 2);
  assert.match(firstRan.stderr, /line2-marker/);
});

test("PostToolUse journals its edit; an Edit that changed nothing journals nothing", async () => {
  const s = setup();
  const real = realpathSync(s.file);
  assert.equal((await start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: { structuredPatch: [] } }), {})).status, 0);
  assert.deepEqual(journal(s.e), []);
  assert.equal((await start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: EDIT_L2 }), {})).status, 0);
  const names = journal(s.e);
  assert.equal(names.length, 1);
  assert.ok(names[0].startsWith(`${hashPath(real)}-`));
  assert.equal(JSON.parse(readFileSync(path.join(s.e.data, "settle", names[0]), "utf8")).hunks[0].oldLines, 4);
});

test("FileChanged journals a whole-file edit for a file changed outside Write/Edit", async () => {
  const s = setup();
  const r = await start(s.e, s.findings, JSON.stringify({ hook_event_name: "FileChanged", cwd: s.e.cwd, file_path: s.file, event: "change" }), {});
  assert.equal(r.status, 0);
  const names = journal(s.e);
  assert.equal(names.length, 1);
  assert.equal(JSON.parse(readFileSync(path.join(s.e.data, "settle", names[0]), "utf8")).hunks, null);
});

test("a FileChanged lint does not hold its slot while the findings settle", async () => {
  const s = setup();
  s.setFindings(FINDING_L2);
  const changed = start(s.e, s.findings, JSON.stringify({ hook_event_name: "FileChanged", cwd: s.e.cwd, file_path: s.file, event: "change" }), { UNIVERSAL_LINT_SETTLE_MS: "1500" });
  await intoHold(s.e);
  assert.ok(existsSync(path.join(s.e.data, "fc-slots")), "the slot dir was used");
  assert.deepEqual(readdirSync(path.join(s.e.data, "fc-slots")), [], "no slot is held during the hold");
  const ran = await changed;
  assert.equal(ran.status, 2);
  assert.match(ran.stderr, /line2-marker/);
});
