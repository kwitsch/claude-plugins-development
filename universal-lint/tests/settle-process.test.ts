// Settle window (F34, F40) at process level: real hook processes, a stub shellcheck whose findings a test can switch.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "vitest";
import { hashPath, ownerOf } from "../src/hooks/lint-core.ts";
import { HOOK, type LintEnv, makeEnv, payload } from "./support/lint-hook.ts";

/** The 4-line script the scenarios edit. */
const SH4 = "echo a\necho $1\necho b\necho $2\n";
/** The same script after line 2 was rewritten. */
const SH4_FIXED = "echo a\necho \"$1\"\necho b\necho $2\n";
/** The same script after line 4 was rewritten. */
const SH4_L4 = "echo a\necho $1\necho b\necho \"$2\"\n";
/** Edit hunks replacing line 2. */
const EDIT_L2 = { structuredPatch: [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: [" echo a", "-echo $1", "+echo \"$1\"", " echo b", " echo $2"] }] };
/** Edit hunks replacing line 4. */
const EDIT_L4 = { structuredPatch: [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: [" echo b", "-echo $2", "+echo \"$2\""] }] };
/** An Edit of line 2 whose result is SH4 (the file on disk), so the journal's written digest matches the disk. */
const SET_L2 = { structuredPatch: [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: [" echo a", "-echo $x", "+echo $1", " echo b", " echo $2"] }], originalFile: SH4.replace("$1", "$x") };
/** An Edit of line 4 whose result is SH4. */
const SET_L4 = { structuredPatch: [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: [" echo b", "-echo $x", "+echo $2"] }], originalFile: SH4.replace("$2", "$x") };
/** What the stub shellcheck reports for line 2. */
const FINDING_L2 = "a.sh:2:6: note: line2-marker [SC2086]\n";
/** The session and agent of the subagent payloads. */
const AGENT = { session_id: "s1", agent_id: "agent-1" };

/** Outcome of one hook process. */
interface Ran {
  /** Exit status, null when killed by a signal. */
  status: number | null;
  /** Everything the process wrote to stderr (the findings, on exit 2). */
  stderr: string;
  /** Everything the process wrote to stdout. */
  stdout: string;
  /** Wall time from spawn to close. */
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

/** The journal records of the env (empty when the directory does not exist; `act/` holds stamps and markers). */
const journal = (e: LintEnv): string[] => (existsSync(path.join(e.data, "settle")) ? readdirSync(path.join(e.data, "settle")).filter((n) => n.endsWith(".json")) : []);
/** The same PostToolUse payload as made by a subagent. */
const bySub = (input: string): string => JSON.stringify({ ...(JSON.parse(input) as Record<string, unknown>), ...AGENT });
/** A Stop payload of the main conversation, or with `extra` a SubagentStop payload. */
const stop = (e: LintEnv, extra: Record<string, unknown> = {}): string => JSON.stringify({ hook_event_name: "agent_id" in extra ? "SubagentStop" : "Stop", cwd: e.cwd, stop_hook_active: false, ...extra });
/** A FileChanged payload for `file`. */
const changed = (file: string, cwd: string): string => JSON.stringify({ hook_event_name: "FileChanged", cwd, file_path: file, event: "change" });

test("a finding is held for the quiet time, a clean lint is not; both leave no record behind", async () => {
  const s = setup();
  const edit = payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: EDIT_L2 });
  const clean = await start(s.e, s.findings, edit, { UNIVERSAL_LINT_SETTLE_MS: "700" });
  assert.deepEqual(journal(s.e), []);
  s.setFindings(FINDING_L2);
  const held = await start(s.e, s.findings, edit, { UNIVERSAL_LINT_SETTLE_MS: "700" });
  assert.equal(clean.status, 0);
  assert.equal(held.status, 2);
  assert.match(held.stderr, /line2-marker/);
  assert.ok(held.ms - clean.ms >= 500, `held ${held.ms} ms, clean ${clean.ms} ms`);
  assert.deepEqual(journal(s.e), []);
});

test("a finding outside the edited file is held too", async () => {
  const s = setup();
  s.setFindings("other.sh:3:1: note: foreign-marker [SC2086]\n");
  const foreign = await start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: EDIT_L2 }), { UNIVERSAL_LINT_SETTLE_MS: "900" });
  assert.equal(foreign.status, 2);
  assert.match(foreign.stderr, /foreign-marker/);
  assert.ok(foreign.ms >= 800, `foreign ${foreign.ms} ms`);
});

test("the quiet time starts again when the same agent edits another file", async () => {
  const s = setup();
  const other = s.e.file("b.sh", "echo b\n");
  s.setFindings(FINDING_L2);
  const first = start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L2 }), { UNIVERSAL_LINT_SETTLE_MS: "1200" });
  await intoHold(s.e);
  s.setFindings("");
  assert.equal((await start(s.e, s.findings, payload(other, s.e.cwd), {})).status, 0);
  s.setFindings(FINDING_L2);
  const firstRan = await first;
  assert.equal(firstRan.status, 2);
  assert.match(firstRan.stderr, /line2-marker/);
  assert.ok(firstRan.ms >= 1500, `held ${firstRan.ms} ms`);
});

test("a later edit of the file whose lint is clean: nothing is reported and the held lint ends early", async () => {
  const s = setup();
  s.setFindings(FINDING_L2);
  const first = start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L2 }), { UNIVERSAL_LINT_SETTLE_MS: "5000" });
  await intoHold(s.e);
  writeFileSync(s.file, SH4_FIXED);
  s.setFindings("");
  const second = await start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: { ...EDIT_L2, originalFile: SH4 } }), {});
  const firstRan = await first;
  assert.equal(second.status, 0);
  assert.equal(firstRan.status, 0);
  assert.equal(firstRan.stderr, "");
  assert.ok(firstRan.ms < 4000, `the first process did not wait out its hold: ${firstRan.ms} ms`);
  assert.deepEqual(journal(s.e), []);
});

test("a later edit elsewhere in the file while the error is still there: the later lint reports the earlier edit's line, once", async () => {
  const s = setup();
  s.setFindings(`a.sh:1:1: note: line1-marker [SC2086]\n${FINDING_L2}`);
  const first = start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L2 }), { UNIVERSAL_LINT_SETTLE_MS: "3000" });
  await intoHold(s.e);
  writeFileSync(s.file, SH4_L4);
  const second = await start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: { ...EDIT_L4, originalFile: SH4 } }), {});
  const firstRan = await first;
  assert.equal(second.status, 2);
  assert.match(second.stderr, /line2-marker/);
  assert.doesNotMatch(second.stderr, /line1-marker/, "a line no pending edit touched stays gated");
  assert.equal(firstRan.status, 0);
  assert.equal(firstRan.stderr, "");
});

test("a later edit of the line that still has the error: the later edit reports it, the first one is dropped", async () => {
  const s = setup();
  s.setFindings(FINDING_L2);
  const first = start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L2 }), { UNIVERSAL_LINT_SETTLE_MS: "2000" });
  await intoHold(s.e);
  writeFileSync(s.file, SH4_FIXED);
  const second = await start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: { ...EDIT_L2, originalFile: SH4 } }), {});
  const firstRan = await first;
  assert.equal(second.status, 2);
  assert.match(second.stderr, /line2-marker/);
  assert.equal(firstRan.status, 0);
  assert.equal(firstRan.stderr, "");
});

test("a later Write drops the earlier findings of the file", async () => {
  const s = setup();
  s.setFindings(FINDING_L2);
  const first = start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L2 }), { UNIVERSAL_LINT_SETTLE_MS: "2000" });
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
  const first = start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L2 }), { UNIVERSAL_LINT_SETTLE_MS: "2000" });
  await intoHold(s.e);
  writeFileSync(s.file, "echo changed by a formatter\n");
  s.setFindings("");
  const echo = await start(s.e, s.findings, changed(s.file, s.e.cwd), {});
  assert.equal(echo.status, 0);
  assert.equal((await first).status, 0);
});

test("the FileChanged echo of a Write/Edit is no later edit: it records nothing and the finding is reported", async () => {
  const s = setup();
  s.setFindings(FINDING_L2);
  writeFileSync(s.file, SH4_FIXED); // what EDIT_L2 writes, so the recorded digest matches the echo
  const first = start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: { ...EDIT_L2, originalFile: SH4 } }), { UNIVERSAL_LINT_SETTLE_MS: "1500" });
  await intoHold(s.e);
  const before = journal(s.e);
  const echo = await start(s.e, s.findings, changed(s.file, s.e.cwd), {});
  assert.equal(echo.status, 0);
  assert.deepEqual(journal(s.e), before);
  assert.equal(s.e.lines().length, 1, "the echo did not lint");
  const firstRan = await first;
  assert.equal(firstRan.status, 2);
  assert.match(firstRan.stderr, /line2-marker/);
});

test("FileChanged journals a whole-file edit for a file changed outside Write/Edit", async () => {
  const s = setup();
  s.setFindings(FINDING_L2);
  const run = start(s.e, s.findings, changed(s.file, s.e.cwd), { UNIVERSAL_LINT_SETTLE_MS: "1000" });
  await intoHold(s.e);
  const names = journal(s.e);
  assert.equal(names.length, 1);
  assert.ok(names[0].endsWith(`-${ownerOf(undefined)}.json`), "owned by the main conversation");
  assert.equal(JSON.parse(readFileSync(path.join(s.e.data, "settle", names[0]), "utf8")).hunks, null);
  assert.equal((await run).status, 2);
});

test("a FileChanged lint does not hold its slot while the findings settle", async () => {
  const s = setup();
  s.setFindings(FINDING_L2);
  const run = start(s.e, s.findings, changed(s.file, s.e.cwd), { UNIVERSAL_LINT_SETTLE_MS: "1500" });
  await intoHold(s.e);
  assert.ok(existsSync(path.join(s.e.data, "fc-slots")), "the slot dir was used");
  assert.deepEqual(readdirSync(path.join(s.e.data, "fc-slots")), [], "no slot is held during the hold");
  const ran = await run;
  assert.equal(ran.status, 2);
  assert.match(ran.stderr, /line2-marker/);
});

test("a later edit that fixed the cause of a held parse error on another line: the parse error is not reported", async () => {
  const s = setup();
  s.setFindings("a.sh:4:1: error: Couldn't find end of string [SC1009]\n");
  const first = start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L4 }), { UNIVERSAL_LINT_SETTLE_MS: "2000" });
  await intoHold(s.e);
  writeFileSync(s.file, SH4_FIXED);
  s.setFindings("");
  const second = await start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: { ...EDIT_L2, originalFile: SH4 } }), {});
  const firstRan = await first;
  assert.equal(second.status, 0);
  assert.equal(firstRan.status, 0);
  assert.equal(firstRan.stderr, "");
});

test("a later edit elsewhere that leaves the parse error: the later lint reports it, the held one is dropped", async () => {
  const s = setup();
  s.setFindings("a.sh:4:1: error: Couldn't find end of string [SC1009]\n");
  const first = start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L4 }), { UNIVERSAL_LINT_SETTLE_MS: "2000" });
  await intoHold(s.e);
  writeFileSync(s.file, SH4_FIXED);
  const second = await start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: { ...EDIT_L2, originalFile: SH4 } }), {});
  const firstRan = await first;
  assert.equal(second.status, 2);
  assert.match(second.stderr, /SC1009/);
  assert.equal(firstRan.status, 0);
});

test("two later edits whose hooks journal out of edit order: the chain is broken, the first later lint reports the whole file, nothing is lost", async () => {
  const s = setup();
  writeFileSync(s.file, "echo a\necho b\necho $1\necho c\n");
  s.setFindings("a.sh:3:6: note: line3-marker [SC2086]\n");
  const editA = { structuredPatch: [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: [" echo a", " echo b", "-echo $2", "+echo $1", " echo c"] }] };
  const first = start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: { ...editA, originalFile: "echo a\necho b\necho $2\necho c\n" } }), { UNIVERSAL_LINT_SETTLE_MS: "2500" });
  await intoHold(s.e);
  // B inserts a line at the top (the error moves to line 4), C rewrites `echo b` (line 3 after B); both land first
  writeFileSync(s.file, "echo new\necho a\necho B\necho $1\necho c\n");
  s.setFindings("a.sh:4:6: note: line4-marker [SC2086]\n");
  const editB = { structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: ["+echo new", " echo a", " echo b", " echo $1"] }] };
  const editC = { structuredPatch: [{ oldStart: 2, oldLines: 3, newStart: 2, newLines: 3, lines: [" echo a", "-echo b", "+echo B", " echo $1"] }] };
  // C's hook journals before B's: C was not cut from what the record before it wrote, so line 4 is not gated away
  const ranC = await start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: { ...editC, originalFile: "echo new\necho a\necho b\necho $1\necho c\n" } }), {});
  assert.equal(ranC.status, 2);
  assert.match(ranC.stderr, /line4-marker/);
  assert.equal((await start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: { ...editB, originalFile: "echo a\necho b\necho $1\necho c\n" } }), {})).status, 0, "B alone: line 4 is outside its edit");
  const firstRan = await first;
  assert.equal(firstRan.status, 0);
  assert.equal(firstRan.stderr, "");
});

test("a Write whose hook journals after a later Edit's hook: it reports the whole file", async () => {
  const s = setup(); // disk holds SH4 (= A): the Write wrote X, the Edit of line 4 then turned X into A
  s.setFindings(FINDING_L2);
  const edit = await start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L4 }), { UNIVERSAL_LINT_SETTLE_MS: "300" });
  assert.equal(edit.status, 0, "the Edit's range gate drops line 2");
  const write = JSON.parse(payload(s.file, s.e.cwd)) as { tool_input: { content: string } };
  write.tool_input.content = SET_L4.originalFile;
  const late = await start(s.e, s.findings, JSON.stringify(write), { UNIVERSAL_LINT_SETTLE_MS: "300" });
  assert.equal(late.status, 2);
  assert.match(late.stderr, /line2-marker/);
  assert.deepEqual(journal(s.e), []);
});

/** An edit and its exact undo while the linter of the first hook (`first` builds its payload) runs; asserts the later lint reports and the first stays silent. */
async function editAndUndoDuringLint(first: (file: string, cwd: string) => string): Promise<void> {
  const e = makeEnv();
  // stub shellcheck: log `run`, wait READ_DELAY, read the file, log `read <delay>`, wait POST_DELAY, report each `echo $1` line
  const js = path.join(path.dirname(e.record), "stub.mjs");
  writeFileSync(
    js,
    [
      "import { appendFileSync, readFileSync } from 'node:fs';",
      "const s = (ms) => new Promise((r) => setTimeout(r, Number(ms || 0)));",
      "const f = process.argv.at(-1);",
      "appendFileSync(process.env.RECORD, 'run\\n');",
      "await s(process.env.READ_DELAY);",
      "const lines = readFileSync(f, 'utf8').split('\\n');",
      "appendFileSync(process.env.RECORD, `read ${process.env.READ_DELAY ?? 0}\\n`);",
      "await s(process.env.POST_DELAY);",
      "const out = lines.flatMap((l, i) => (l.includes('echo $1') ? [`a.sh:${i + 1}:6: note: aba-marker [SC2086]`] : []));",
      "if (out.length) { console.log(out.join('\\n')); process.exit(1); }",
    ].join("\n"),
  );
  e.stub("shellcheck", `exec node "${js}" "$@"`);
  const A = "echo a\necho $1\necho b\necho c\n";
  const B = `x\n${A}`;
  const file = e.file("a.sh", A);
  const edit = (structuredPatch: unknown, originalFile: string) => payload(file, e.cwd, { toolName: "Edit", toolResponse: { structuredPatch, originalFile } });
  const firstRun = start(e, "", first(file, e.cwd), { UNIVERSAL_LINT_SETTLE_MS: "3000", READ_DELAY: "1500", POST_DELAY: "2500" });
  await expect.poll(() => e.lines().length, { interval: 20, timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  // B inserts a line at the top before the first linter reads: B's own lint covers the pending whole-file edit and reports
  writeFileSync(file, B);
  const ranB = await start(e, "", edit([{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: ["+x", " echo a", " echo $1", " echo b"] }], A), {});
  assert.equal(ranB.status, 2);
  assert.match(ranB.stderr, /a\.sh:3:6: note: aba-marker/);
  await expect.poll(() => e.lines().includes("read 1500"), { interval: 20, timeout: 10_000 }).toBe(true);
  // C undoes B while the first linter still runs: the file is A again when that lint ends, but it read B
  writeFileSync(file, A);
  assert.equal((await start(e, "", edit([{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 3, lines: ["-x", " echo a", " echo $1", " echo b"] }], B), {})).status, 0);
  const firstRan = await firstRun;
  assert.equal(firstRan.status, 0, "a lint that saw the file change reports nothing: its line numbers are those of B");
  assert.equal(firstRan.stderr, "");
}

test("an edit and its exact undo while the linter runs (A->B->A): the later lint reports, the stale one stays silent", () => editAndUndoDuringLint((file, cwd) => payload(file, cwd)));

test("an edit and its exact undo while a FileChanged lint runs (A->B->A): the later lint reports, the stale one stays silent", () => editAndUndoDuringLint(changed));

/** A U+2028 above a finding (`first` builds the held lint's payload) and a later Edit of another line; asserts the later lint reports it. */
async function foreignBreakAboveFinding(first: (file: string, cwd: string) => string): Promise<void> {
  const s = setup();
  // patch lines: 1 `# x<U+2028>y`, 2 `echo $1`, 3 `echo b`; the linter counts U+2028 and reports `echo $1` on line 3
  const A = "# x y\necho $1\necho b\necho c\n";
  writeFileSync(s.file, A);
  s.setFindings("a.sh:3:6: note: ls-marker [SC2086]\n");
  const firstRun = start(s.e, s.findings, first(s.file, s.e.cwd), { UNIVERSAL_LINT_SETTLE_MS: "2000" });
  await intoHold(s.e);
  // the later Edit rewrites patch line 3 (`echo b`), which the linter numbers 4: with the patch's numbers the finding would be gated away
  writeFileSync(s.file, A.replace("echo b", "echo 'b'"));
  const edit = { structuredPatch: [{ oldStart: 2, oldLines: 3, newStart: 2, newLines: 3, lines: [" echo $1", "-echo b", "+echo 'b'", " echo c"] }], originalFile: A };
  const second = await start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: edit }), {});
  assert.equal(second.status, 2, "a file with such a line break is linted whole");
  assert.match(second.stderr, /ls-marker/);
  assert.equal((await firstRun).status, 0);
}

test("a U+2028 above a held finding and a later Edit: the later lint is whole-file and reports it", () => foreignBreakAboveFinding((file, cwd) => payload(file, cwd)));

test("a U+2028 above a held FileChanged finding and a later Edit: the later lint is whole-file and reports it", () => foreignBreakAboveFinding(changed));

test("a change nobody journaled between the held lint and a later Edit: the later lint reports the whole file, nothing is lost", async () => {
  const s = setup();
  s.setFindings(FINDING_L2);
  const first = start(s.e, s.findings, payload(s.file, s.e.cwd), { UNIVERSAL_LINT_SETTLE_MS: "2000" });
  await intoHold(s.e);
  // an outside change with no hook (`sed -i`, an unwatched file) puts two lines on top: `echo $1` moves to line 4
  const shifted = `# header\n# todo\n${SH4}`;
  writeFileSync(s.file, shifted.replace("# todo", "# done"));
  s.setFindings("a.sh:4:6: note: line4-marker [SC2086]\n");
  const editL2 = { structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" # header", "-# todo", "+# done", " echo a"] }], originalFile: shifted };
  const second = await start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: editL2 }), {});
  assert.equal(second.status, 2, "the pending Write makes the later lint whole-file");
  assert.match(second.stderr, /line4-marker/);
  const firstRan = await first;
  assert.equal(firstRan.status, 0);
  assert.equal(firstRan.stderr, "");
});

test("a change nobody journaled that lands before a later Edit's hook runs: the later lint reports the whole file, nothing is lost", async () => {
  const s = setup();
  const A1 = "echo a\necho b\n\necho c\necho $1\necho d\n";
  writeFileSync(s.file, A1);
  s.setFindings("a.sh:5:6: note: line5-marker [SC2086]\n");
  const first = start(s.e, s.findings, payload(s.file, s.e.cwd), { UNIVERSAL_LINT_SETTLE_MS: "2500" });
  await intoHold(s.e);
  // E2 rewrites line 2; before its hook runs, another program deletes the blank line 3 (`echo $1` moves to line 4)
  const A2x = "echo a\necho B\necho c\necho $1\necho d\n";
  writeFileSync(s.file, A2x);
  s.setFindings("a.sh:4:6: note: line4-marker [SC2086]\n");
  const e2 = { structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" echo a", "-echo b", "+echo B", " "] }], originalFile: A1 };
  const ranE2 = await start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: e2 }), {});
  assert.equal(ranE2.status, 2);
  assert.match(ranE2.stderr, /line4-marker/);
  // E3 rewrites line 5 of A2x (`echo d`), the line `echo $1` had in A1: alone, gated to its own line
  writeFileSync(s.file, A2x.replace("echo d", "echo D"));
  const e3 = { structuredPatch: [{ oldStart: 3, oldLines: 3, newStart: 3, newLines: 3, lines: [" echo c", " echo $1", "-echo d", "+echo D"] }], originalFile: A2x };
  assert.equal((await start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: e3 }), {})).status, 0, "line 4 is outside E3");
  assert.equal((await first).status, 0);
});

// ---- owner routing and the Stop / SubagentStop sweep (F40) -----------------------------------------------------------

test("a subagent's Edit is journaled and not linted; an Edit that changed nothing journals nothing", async () => {
  const s = setup();
  s.setFindings(FINDING_L2);
  const real = realpathSync(s.file);
  assert.equal((await start(s.e, s.findings, bySub(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: { structuredPatch: [] } })), {})).status, 0);
  assert.deepEqual(journal(s.e), []);
  const ran = await start(s.e, s.findings, bySub(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L2 })), {});
  assert.equal(ran.status, 0);
  assert.equal(ran.stderr, "");
  assert.deepEqual(s.e.lines(), [], "no linter ran");
  const names = journal(s.e);
  assert.equal(names.length, 1);
  assert.ok(names[0].startsWith(`${hashPath(real)}-`));
  assert.ok(names[0].endsWith(`-${ownerOf({ cwd: "", ...AGENT })}.json`));
  const rec = JSON.parse(readFileSync(path.join(s.e.data, "settle", names[0]), "utf8"));
  assert.equal(rec.hunks[0].oldLines, 4);
  assert.deepEqual(rec.ranges, [[1, 1]]);
  assert.equal(rec.fp, s.file);
  assert.equal(rec.cwd, s.e.cwd);
});

test("SubagentStop reports the agent's pending edits once, gated to the lines of all its edits", async () => {
  const s = setup();
  s.setFindings(`a.sh:1:1: note: line1-marker [SC2086]\n${FINDING_L2}a.sh:4:6: note: line4-marker [SC2086]\n`);
  assert.equal((await start(s.e, s.findings, bySub(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L2 })), {})).status, 0);
  writeFileSync(s.file, SH4_L4);
  assert.equal((await start(s.e, s.findings, bySub(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: { ...EDIT_L4, originalFile: SH4 } })), {})).status, 0);
  assert.equal(journal(s.e).length, 2);
  const swept = await start(s.e, s.findings, stop(s.e, AGENT), {});
  assert.equal(swept.status, 2);
  assert.match(swept.stderr, /^universal-lint: shellcheck found issues in a\.sh:/);
  assert.match(swept.stderr, /line2-marker/);
  assert.match(swept.stderr, /line4-marker/);
  assert.doesNotMatch(swept.stderr, /line1-marker/, "a line the agent did not touch stays gated");
  assert.equal(s.e.lines().length, 1, "one lint for the file, not one per edit");
  assert.deepEqual(journal(s.e), []);
});

test("the stop that follows a report is let through without a sweep; the next fresh stop sweeps again", async () => {
  const s = setup();
  s.setFindings(FINDING_L2);
  const edit = bySub(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L2 }));
  await start(s.e, s.findings, edit, {});
  assert.equal((await start(s.e, s.findings, stop(s.e, AGENT), {})).status, 2);
  await start(s.e, s.findings, edit, {}); // the agent's fix attempt
  const again = await start(s.e, s.findings, stop(s.e, { ...AGENT, stop_hook_active: true }), {});
  assert.equal(again.status, 0, "never block the same stop twice");
  assert.equal(s.e.lines().length, 1);
  assert.equal(journal(s.e).length, 1, "the record stays pending");
  const fresh = await start(s.e, s.findings, stop(s.e, AGENT), {});
  assert.equal(fresh.status, 2);
  assert.match(fresh.stderr, /line2-marker/);
});

test("a stop continued by another hook (stop_hook_active without an own report) still sweeps", async () => {
  const s = setup();
  s.setFindings(FINDING_L2);
  await start(s.e, s.findings, bySub(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L2 })), {});
  const swept = await start(s.e, s.findings, stop(s.e, { ...AGENT, stop_hook_active: true }), {});
  assert.equal(swept.status, 2);
  assert.match(swept.stderr, /line2-marker/);
});

test("a sweep with nothing pending, with a clean file or with a file that is gone reports nothing", async () => {
  const s = setup();
  assert.equal((await start(s.e, s.findings, stop(s.e), {})).status, 0);
  assert.equal((await start(s.e, s.findings, stop(s.e, AGENT), {})).status, 0);
  assert.deepEqual(s.e.lines(), []);
  const edit = bySub(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L2 }));
  await start(s.e, s.findings, edit, {});
  const clean = await start(s.e, s.findings, stop(s.e, AGENT), {});
  assert.equal(clean.status, 0);
  assert.equal(s.e.lines().length, 1);
  assert.deepEqual(journal(s.e), []);
  s.setFindings(FINDING_L2);
  await start(s.e, s.findings, edit, {});
  rmSync(s.file);
  const gone = await start(s.e, s.findings, stop(s.e, AGENT), {});
  assert.equal(gone.status, 0);
  assert.equal(s.e.lines().length, 1, "a file out of scope is not linted");
  assert.deepEqual(journal(s.e), []);
});

test("Stop sweeps the main conversation's pending file: the held lint is claimed and stays silent; a subagent's stop does not touch it", async () => {
  const s = setup();
  s.setFindings(FINDING_L2);
  const held = start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L2 }), { UNIVERSAL_LINT_SETTLE_MS: "5000" });
  await intoHold(s.e);
  const sub = await start(s.e, s.findings, stop(s.e, AGENT), {});
  assert.equal(sub.status, 0);
  assert.equal(journal(s.e).length, 1);
  const swept = await start(s.e, s.findings, stop(s.e), {});
  assert.equal(swept.status, 2);
  assert.match(swept.stderr, /line2-marker/);
  const heldRan = await held;
  assert.equal(heldRan.status, 0);
  assert.equal(heldRan.stderr, "");
  assert.ok(heldRan.ms < 4000, `the held lint ended early: ${heldRan.ms} ms`);
  assert.equal(s.e.lines().length, 2, "the edit's lint and the sweep's");
});

test("a held finding that the turn end finds repaired outside Write/Edit is never reported", async () => {
  const s = setup();
  s.setFindings(FINDING_L2);
  const held = start(s.e, s.findings, payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L2 }), { UNIVERSAL_LINT_SETTLE_MS: "5000" });
  await intoHold(s.e);
  writeFileSync(s.file, SH4_FIXED); // e.g. `sed -i` on an unwatched file
  s.setFindings("");
  assert.equal((await held).status, 0, "the file changed during the hold");
  assert.equal(journal(s.e).length, 1, "left for the sweep");
  assert.equal((await start(s.e, s.findings, stop(s.e), {})).status, 0);
  assert.deepEqual(journal(s.e), []);
});
