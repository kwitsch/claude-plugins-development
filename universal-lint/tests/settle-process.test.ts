// Settle window (F34, F40) at process level: one built server per test, a stub shellcheck whose findings a test can switch.
// A test with a hold runs every call on a server with that hold (every lint is detached, reports arrive through the
// outbox): "the later lint reports, the earlier one stays silent" is asserted as "the marker is delivered exactly once".
// The old per-process wall times (a held process ended early, the hold restarted) have no equivalent on one server.
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "vitest";
import { FILE_CHANGED_SLOTS } from "../src/hooks/lint-core.ts";
import { type LintEnv, makeEnv, payload } from "./support/lint-hook.ts";

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
/** The session of every call. */
const SESSION = "s1";
/** The session and agent of the subagent payloads. */
const AGENT = { session_id: SESSION, agent_id: "agent-1" };

/** A `stop` answer: a block with its reason, or `{}`. */
interface StopAnswer {
  /** `"block"` when the stop was blocked. */
  decision?: string;
  /** The report text of a block. */
  reason?: string;
}

/** One server of a test, its key fetched once; every call carries `session_id` `s1`. */
interface Srv {
  /** Send a Write/Edit payload as the mod does (keyed `file_edited`); resolves with the reports its answer carried ("" when none). */
  edit(input: string): Promise<string>;
  /** Send a FileChanged payload as its `mcp_tool` hook does. */
  changed(input: string): Promise<unknown>;
  /** A Stop (or with `agent_id` in `extra` a SubagentStop) of session `s1`. */
  stop(extra?: Record<string, unknown>): Promise<StopAnswer>;
  /** The keyed `next_report` state after waiting up to `waitMs`. */
  state(waitMs: number): Promise<unknown>;
  /** Every report delivered to the main conversation until none arrives for `holdMs` plus 1.5 s, joined; "" when none. */
  reports(holdMs: number): Promise<string>;
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

/**
 * Start the test's server: hold `ms` (0 = every lint is awaited by its call), interactive (`cli`, so `next_report` waits).
 *
 * @param e - Test environment.
 * @param findings - The stub's findings file ("" for a stub that ignores it).
 * @param ms - `UNIVERSAL_LINT_SETTLE_MS`.
 * @param env - Extra environment of the server (and so of every stub it runs).
 * @returns The server's helpers.
 */
function server(e: LintEnv, findings: string, ms: number, env: Record<string, string> = {}): Srv {
  const srv = e.server({ env: { FINDINGS: findings, UNIVERSAL_LINT_SETTLE_MS: String(ms), CLAUDE_CODE_ENTRYPOINT: "cli", ...env } });
  const got: string[] = [];
  let key: string | undefined;
  const k = async (): Promise<string> => (key ??= await srv.key(SESSION));
  const state = async (waitMs: number): Promise<unknown> => (await srv.call("next_report", { session_id: SESSION, key: await k(), wait_ms: waitMs }))["state"];
  return {
    async edit(input) {
      const a = await srv.call("file_edited", { ...(JSON.parse(input) as Record<string, unknown>), session_id: SESSION, key: await k() });
      const text = typeof a["context"] === "string" ? a["context"] : "";
      if (text) got.push(text);
      return text;
    },
    changed: (input) => srv.call("file_changed", { ...(JSON.parse(input) as Record<string, unknown>), session_id: SESSION }),
    stop: (extra = {}) => srv.call("stop", { hook_event_name: "agent_id" in extra ? "SubagentStop" : "Stop", cwd: e.cwd, session_id: SESSION, stop_hook_active: false, ...extra }),
    state,
    async reports(holdMs) {
      // ends on `timeout` (nothing more is coming); `busy` or anything else is asked again (bounded), never taken for "done"
      for (let round = 0; round < 20; round++) {
        const s = await state(holdMs + 1500);
        if (s === "timeout") break;
        if (s !== "ready") continue;
        const a = await srv.call("prompt_submitted", { cwd: e.cwd, session_id: SESSION });
        const text = (a["hookSpecificOutput"] as { additionalContext?: string } | undefined)?.additionalContext;
        assert.ok(text, "a ready report must come out of prompt_submitted");
        got.push(text);
      }
      return got.splice(0).join("\n\n");
    },
  };
}

/** Wait until the stub linter ran `runs` times (lines in `$RECORD`), then a little longer so its lint is inside its hold. */
async function intoHold(e: LintEnv, runs = 1): Promise<void> {
  await expect.poll(() => e.lines().length, { interval: 20, timeout: 10_000 }).toBeGreaterThanOrEqual(runs);
  await sleep(400);
}

/**
 * How often `marker` occurs in `text`.
 *
 * @param text - The delivered reports.
 * @param marker - The finding's marker text.
 * @returns The count.
 */
const times = (text: string, marker: string): number => text.split(marker).length - 1;

/**
 * Asserts that no journal record of the owner is pending: a fresh stop answers {} and runs no linter (a pending
 * record would be linted by the sweep). The journal lives in the server's memory; this is its observable side.
 *
 * @param s - The test's setup.
 * @param srv - The test's server.
 * @param extra - `AGENT` for the subagent's SubagentStop.
 */
async function noPending(s: { e: LintEnv }, srv: Srv, extra?: Record<string, unknown>): Promise<void> {
  const runs = s.e.lines().length;
  assert.deepEqual(await srv.stop(extra), {});
  assert.equal(s.e.lines().length, runs, "nothing pending: the stop linted nothing");
}
/** The same PostToolUse payload as made by a subagent. */
const bySub = (input: string): string => JSON.stringify({ ...(JSON.parse(input) as Record<string, unknown>), ...AGENT });
/** A FileChanged payload for `file`. */
const changed = (file: string, cwd: string): string => JSON.stringify({ hook_event_name: "FileChanged", cwd, file_path: file, event: "change" });

test("a finding is held for the quiet time, a clean lint is not; both leave no record behind", async () => {
  const s = setup();
  const srv = server(s.e, s.findings, 1500);
  const edit = payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: EDIT_L2 });
  await srv.edit(edit);
  // lost: "a clean lint is not held" was the wall-time difference of two processes; here only its silence shows
  assert.equal(await srv.reports(1500), "");
  await noPending(s, srv);
  s.setFindings(FINDING_L2);
  await srv.edit(edit);
  await intoHold(s.e, 2);
  assert.equal(await srv.state(0), "timeout", "not ready while the hold runs");
  assert.match(await srv.reports(1500), /line2-marker/);
  await noPending(s, srv);
});

test("a finding outside the edited file is held too", async () => {
  const s = setup();
  const srv = server(s.e, s.findings, 1500);
  s.setFindings("other.sh:3:1: note: foreign-marker [SC2086]\n");
  await srv.edit(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: EDIT_L2 }));
  await intoHold(s.e);
  assert.equal(await srv.state(0), "timeout", "not ready while the hold runs");
  assert.match(await srv.reports(1500), /foreign-marker/);
});

test("the quiet time starts again when the same agent edits another file", async () => {
  const s = setup();
  const srv = server(s.e, s.findings, 1500);
  const other = s.e.file("b.sh", "echo b\n");
  s.setFindings(FINDING_L2);
  await srv.edit(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L2 }));
  await intoHold(s.e);
  s.setFindings("");
  await srv.edit(payload(other, s.e.cwd));
  await intoHold(s.e, 2);
  s.setFindings(FINDING_L2);
  // lost: the restart itself was the held process's wall time (>= 1.5 s); only the order is observable here
  assert.equal(await srv.state(0), "timeout", "the first report is not ready after the second edit");
  const text = await srv.reports(1500);
  assert.equal(times(text, "line2-marker"), 1);
});

test("a later edit of the file whose lint is clean: nothing is reported and the held lint ends early", async () => {
  const s = setup();
  const srv = server(s.e, s.findings, 1500);
  s.setFindings(FINDING_L2);
  await srv.edit(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L2 }));
  await intoHold(s.e);
  writeFileSync(s.file, SH4_FIXED);
  s.setFindings("");
  await srv.edit(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: { ...EDIT_L2, originalFile: SH4 } }));
  await intoHold(s.e, 2);
  // "ends early" was the held process's wall time; on one server only the silence is observable
  assert.equal(await srv.reports(1500), "");
  await noPending(s, srv);
});

test("a later edit elsewhere in the file while the error is still there: the later lint reports the earlier edit's line, once", async () => {
  const s = setup();
  const srv = server(s.e, s.findings, 1500);
  s.setFindings(`a.sh:1:1: note: line1-marker [SC2086]\n${FINDING_L2}`);
  await srv.edit(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L2 }));
  await intoHold(s.e);
  writeFileSync(s.file, SH4_L4);
  await srv.edit(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: { ...EDIT_L4, originalFile: SH4 } }));
  await intoHold(s.e, 2);
  const text = await srv.reports(1500);
  assert.equal(times(text, "line2-marker"), 1);
  assert.doesNotMatch(text, /line1-marker/, "a line no pending edit touched stays gated");
});

test("a later edit of the line that still has the error: the later edit reports it, the first one is dropped", async () => {
  const s = setup();
  const srv = server(s.e, s.findings, 1500);
  s.setFindings(FINDING_L2);
  await srv.edit(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L2 }));
  await intoHold(s.e);
  writeFileSync(s.file, SH4_FIXED);
  await srv.edit(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: { ...EDIT_L2, originalFile: SH4 } }));
  await intoHold(s.e, 2);
  assert.equal(times(await srv.reports(1500), "line2-marker"), 1);
});

test("a later Write drops the earlier findings of the file", async () => {
  const s = setup();
  const srv = server(s.e, s.findings, 1500);
  s.setFindings(FINDING_L2);
  await srv.edit(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L2 }));
  await intoHold(s.e);
  writeFileSync(s.file, "echo rewritten\n");
  s.setFindings("");
  await srv.edit(payload(s.file, s.e.cwd));
  await intoHold(s.e, 2);
  assert.equal(await srv.reports(1500), "");
});

test("FileChanged outside Write/Edit supersedes a held finding", async () => {
  const s = setup();
  const srv = server(s.e, s.findings, 1500);
  s.setFindings(FINDING_L2);
  await srv.edit(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L2 }));
  await intoHold(s.e);
  writeFileSync(s.file, "echo changed by a formatter\n");
  s.setFindings("");
  await srv.changed(changed(s.file, s.e.cwd));
  await intoHold(s.e, 2);
  assert.equal(await srv.reports(1500), "");
});

test("the FileChanged echo of a Write/Edit is no later edit: it records nothing and the finding is reported", async () => {
  const s = setup();
  const srv = server(s.e, s.findings, 1500);
  s.setFindings(FINDING_L2);
  writeFileSync(s.file, SH4_FIXED); // what EDIT_L2 writes, so the recorded digest matches the echo
  await srv.edit(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: { ...EDIT_L2, originalFile: SH4 } }));
  await intoHold(s.e);
  await srv.changed(changed(s.file, s.e.cwd));
  await sleep(200); // the echo's detached run: a digest skip, done long before this
  assert.match(await srv.reports(1500), /line2-marker/);
  assert.equal(s.e.lines().length, 1, "the echo did not lint");
  await noPending(s, srv); // the echo journaled nothing the report left behind
});

test("FileChanged journals a whole-file edit for a file changed outside Write/Edit", async () => {
  const s = setup();
  const srv = server(s.e, s.findings, 1500);
  s.setFindings("a.sh:3:6: note: line3-marker [SC2086]\n");
  await srv.changed(changed(s.file, s.e.cwd));
  await intoHold(s.e);
  assert.deepEqual(await srv.stop(AGENT), {}, "not the subagent's record");
  const swept = await srv.stop();
  assert.equal(swept.decision, "block", "owned by the main conversation");
  assert.match(swept.reason ?? "", /line3-marker/, "a whole-file record: no line is gated away");
  assert.equal(await srv.reports(1500), "", "the sweep claimed the record: the held lint stays silent");
});

test("a FileChanged lint does not hold its slot while the findings settle", async () => {
  const s = setup();
  // the K further files' linters block after they started (until `release` exists), so no slot is free for a later one
  // and "K lints started while the first finding is held" can only hold if the first lint gave its slot back
  const release = path.join(path.dirname(s.e.record), "release");
  s.e.stub("shellcheck", "echo run >> \"$RECORD\"", `case "$*" in */b[0-9]*.sh*) while [ ! -e "${release}" ]; do node -e "setTimeout(() => {}, 20)"; done;; esac`, "if [ -s \"$FINDINGS\" ]; then printf '%s\\n' \"$(< \"$FINDINGS\")\"; exit 1; fi", "exit 0");
  // a hold far longer than the whole test: the first report cannot become ready before the K lints started, whatever the machine's speed;
  // the hold is then ended by the Stop sweep (which claims the pending records), not by waiting for its deadline
  const srv = server(s.e, s.findings, 30_000);
  s.setFindings(FINDING_L2);
  await srv.changed(changed(s.file, s.e.cwd));
  await intoHold(s.e);
  const others = Array.from({ length: FILE_CHANGED_SLOTS }, (_, i) => s.e.file(`b${i}.sh`, "echo b\n"));
  for (const f of others) await srv.changed(changed(f, s.e.cwd));
  await expect.poll(() => s.e.lines().length, { interval: 20, timeout: 10_000 }).toBe(1 + FILE_CHANGED_SLOTS);
  assert.notEqual(await srv.state(0), "ready", "all K lints started before the first report was ready");
  writeFileSync(release, "");
  const swept = await srv.stop();
  assert.equal(swept.decision, "block");
  assert.match(swept.reason ?? "", /line2-marker/);
});

test("a later edit that fixed the cause of a held parse error on another line: the parse error is not reported", async () => {
  const s = setup();
  const srv = server(s.e, s.findings, 1500);
  s.setFindings("a.sh:4:1: error: Couldn't find end of string [SC1009]\n");
  await srv.edit(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L4 }));
  await intoHold(s.e);
  writeFileSync(s.file, SH4_FIXED);
  s.setFindings("");
  await srv.edit(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: { ...EDIT_L2, originalFile: SH4 } }));
  await intoHold(s.e, 2);
  assert.equal(await srv.reports(1500), "");
});

test("a later edit elsewhere that leaves the parse error: the later lint reports it, the held one is dropped", async () => {
  const s = setup();
  const srv = server(s.e, s.findings, 1500);
  s.setFindings("a.sh:4:1: error: Couldn't find end of string [SC1009]\n");
  await srv.edit(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L4 }));
  await intoHold(s.e);
  writeFileSync(s.file, SH4_FIXED);
  await srv.edit(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: { ...EDIT_L2, originalFile: SH4 } }));
  await intoHold(s.e, 2);
  assert.equal(times(await srv.reports(1500), "SC1009"), 1);
});

test("two later edits whose hooks journal out of edit order: the chain is broken, the first later lint reports the whole file, nothing is lost", async () => {
  const s = setup();
  const srv = server(s.e, s.findings, 1500);
  writeFileSync(s.file, "echo a\necho b\necho $1\necho c\n");
  s.setFindings("a.sh:3:6: note: line3-marker [SC2086]\n");
  const editA = { structuredPatch: [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: [" echo a", " echo b", "-echo $2", "+echo $1", " echo c"] }] };
  await srv.edit(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: { ...editA, originalFile: "echo a\necho b\necho $2\necho c\n" } }));
  await intoHold(s.e);
  // B inserts a line at the top (the error moves to line 4), C rewrites `echo b` (line 3 after B); both land first
  writeFileSync(s.file, "echo new\necho a\necho B\necho $1\necho c\n");
  s.setFindings("a.sh:4:6: note: line4-marker [SC2086]\n");
  const editB = { structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: ["+echo new", " echo a", " echo b", " echo $1"] }] };
  const editC = { structuredPatch: [{ oldStart: 2, oldLines: 3, newStart: 2, newLines: 3, lines: [" echo a", "-echo b", "+echo B", " echo $1"] }] };
  // C's call journals before B's: C was not cut from what the record before it wrote, so line 4 is not gated away
  await srv.edit(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: { ...editC, originalFile: "echo new\necho a\necho b\necho $1\necho c\n" } }));
  await intoHold(s.e, 2);
  await srv.edit(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: { ...editB, originalFile: "echo a\necho b\necho $1\necho c\n" } }));
  await intoHold(s.e, 3);
  const text = await srv.reports(1500);
  assert.equal(times(text, "line4-marker"), 1);
  assert.doesNotMatch(text, /line3-marker/);
});

test("a Write whose hook journals after a later Edit's hook: it reports the whole file", async () => {
  const s = setup(); // disk holds SH4 (= A): the Write wrote X, the Edit of line 4 then turned X into A
  const srv = server(s.e, s.findings, 300);
  s.setFindings(FINDING_L2);
  await srv.edit(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L4 }));
  assert.equal(await srv.reports(300), "", "the Edit's range gate drops line 2");
  const write = JSON.parse(payload(s.file, s.e.cwd)) as { tool_input: { content: string } };
  write.tool_input.content = SET_L4.originalFile;
  await srv.edit(JSON.stringify(write));
  assert.match(await srv.reports(300), /line2-marker/);
  await noPending(s, srv);
});

/** An edit and its exact undo while the linter of the first call (`kind`) runs; asserts the stale lint's line number is never reported. */
async function editAndUndoDuringLint(kind: "write" | "changed"): Promise<void> {
  const e = makeEnv();
  // stub shellcheck: log `run`; only its first run waits READ_DELAY, reads the file, logs `read <delay>` and waits
  // POST_DELAY (the env is the server's, so it reaches every run); reports each `echo $1` line
  const js = path.join(path.dirname(e.record), "stub.mjs");
  writeFileSync(
    js,
    [
      "import { appendFileSync, readFileSync } from 'node:fs';",
      "const s = (ms) => new Promise((r) => setTimeout(r, Number(ms || 0)));",
      "const f = process.argv.at(-1);",
      "appendFileSync(process.env.RECORD, 'run\\n');",
      "const first = readFileSync(process.env.RECORD, 'utf8').split('\\n').filter((l) => l === 'run').length === 1;",
      "const delay = first ? process.env.READ_DELAY : 0;",
      "await s(delay);",
      "const lines = readFileSync(f, 'utf8').split('\\n');",
      "appendFileSync(process.env.RECORD, `read ${delay ?? 0}\\n`);",
      "await s(first ? process.env.POST_DELAY : 0);",
      "const out = lines.flatMap((l, i) => (l.includes('echo $1') ? [`a.sh:${i + 1}:6: note: aba-marker [SC2086]`] : []));",
      "if (out.length) { console.log(out.join('\\n')); process.exit(1); }",
    ].join("\n"),
  );
  e.stub("shellcheck", `exec node "${js}" "$@"`);
  const srv = server(e, "", 3000, { READ_DELAY: "1500", POST_DELAY: "2500" });
  const A = "echo a\necho $1\necho b\necho c\n";
  const B = `x\n${A}`;
  const file = e.file("a.sh", A);
  const edit = (structuredPatch: unknown, originalFile: string) => payload(file, e.cwd, { toolName: "Edit", toolResponse: { structuredPatch, originalFile } });
  if (kind === "write") await srv.edit(payload(file, e.cwd));
  else await srv.changed(changed(file, e.cwd));
  await expect.poll(() => e.lines().length, { interval: 20, timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  // B inserts a line at the top before the first linter reads
  writeFileSync(file, B);
  await srv.edit(edit([{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: ["+x", " echo a", " echo $1", " echo b"] }], A));
  await expect.poll(() => e.lines().includes("read 1500"), { interval: 20, timeout: 10_000 }).toBe(true);
  // C undoes B while the first linter still runs: the file is A again when that lint ends, but it read B
  writeFileSync(file, A);
  await srv.edit(edit([{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 3, lines: ["-x", " echo a", " echo $1", " echo b"] }], B));
  const text = await srv.reports(3000);
  assert.equal(times(text, "a.sh:2:6: note: aba-marker"), 1, "the newest lint reports the finding at its line in A");
  assert.doesNotMatch(text, /a\.sh:3:6/, "a lint that saw the file change reports nothing: its line numbers are those of B");
}

test("an edit and its exact undo while the linter runs (A->B->A): the later lint reports, the stale one stays silent", () => editAndUndoDuringLint("write"));

test("an edit and its exact undo while a FileChanged lint runs (A->B->A): the later lint reports, the stale one stays silent", () => editAndUndoDuringLint("changed"));

/** A U+2028 above a finding (`kind` is the held lint's call) and a later Edit of another line; asserts the finding is reported once. */
async function foreignBreakAboveFinding(kind: "write" | "changed"): Promise<void> {
  const s = setup();
  const srv = server(s.e, s.findings, 1500);
  // patch lines: 1 `# x<U+2028>y`, 2 `echo $1`, 3 `echo b`, 4 `echo c`; the linter counts U+2028 and reports `echo $1` on line 3
  const A = "# x\u2028y\necho $1\necho b\necho c\n";
  writeFileSync(s.file, A);
  s.setFindings("a.sh:3:6: note: ls-marker [SC2086]\n");
  // "write": the held lint is an Edit of patch line 2 only (a Write or FileChanged record is whole-file anyway and would hide the guard);
  // the finding sits on linter line 3, so with the patch's numbers it lies outside [2, 2] and outside the later edit's line 4
  const first = { structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" # x\u2028y", "-echo $x", "+echo $1", " echo b"] }], originalFile: A.replace("echo $1", "echo $x") };
  if (kind === "write") await srv.edit(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: first }));
  else await srv.changed(changed(s.file, s.e.cwd));
  await intoHold(s.e);
  // the later Edit rewrites patch line 4 (`echo c`), which the linter numbers 5
  writeFileSync(s.file, A.replace("echo c", "echo 'c'"));
  const edit = { structuredPatch: [{ oldStart: 2, oldLines: 3, newStart: 2, newLines: 3, lines: [" echo $1", " echo b", "-echo c", "+echo 'c'"] }], originalFile: A };
  await srv.edit(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: edit }));
  await intoHold(s.e, 2);
  assert.equal(times(await srv.reports(1500), "ls-marker"), 1, "a file with such a line break is linted whole");
}

test("a U+2028 above a held finding and a later Edit: the later lint is whole-file and reports it", () => foreignBreakAboveFinding("write"));

test("a U+2028 above a held FileChanged finding and a later Edit: the later lint is whole-file and reports it", () => foreignBreakAboveFinding("changed"));

test("a change nobody journaled between the held lint and a later Edit: the later lint reports the whole file, nothing is lost", async () => {
  const s = setup();
  const srv = server(s.e, s.findings, 1500);
  s.setFindings(FINDING_L2);
  await srv.edit(payload(s.file, s.e.cwd));
  await intoHold(s.e);
  // an outside change with no hook (`sed -i`, an unwatched file) puts two lines on top: `echo $1` moves to line 4
  const shifted = `# header\n# todo\n${SH4}`;
  writeFileSync(s.file, shifted.replace("# todo", "# done"));
  s.setFindings("a.sh:4:6: note: line4-marker [SC2086]\n");
  const editL2 = { structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" # header", "-# todo", "+# done", " echo a"] }], originalFile: shifted };
  await srv.edit(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: editL2 }));
  await intoHold(s.e, 2);
  const text = await srv.reports(1500);
  assert.equal(times(text, "line4-marker"), 1, "the pending Write makes the later lint whole-file");
  assert.doesNotMatch(text, /line2-marker/);
});

test("a change nobody journaled that lands before a later Edit's hook runs: the later lint reports the whole file, nothing is lost", async () => {
  const s = setup();
  const srv = server(s.e, s.findings, 1500);
  const A1 = "echo a\necho b\n\necho c\necho $1\necho d\n";
  writeFileSync(s.file, A1);
  s.setFindings("a.sh:5:6: note: line5-marker [SC2086]\n");
  await srv.edit(payload(s.file, s.e.cwd));
  await intoHold(s.e);
  // E2 rewrites line 2; before its call runs, another program deletes the blank line 3 (`echo $1` moves to line 4)
  const A2x = "echo a\necho B\necho c\necho $1\necho d\n";
  writeFileSync(s.file, A2x);
  s.setFindings("a.sh:4:6: note: line4-marker [SC2086]\n");
  const e2 = { structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" echo a", "-echo b", "+echo B", " "] }], originalFile: A1 };
  await srv.edit(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: e2 }));
  await intoHold(s.e, 2);
  // E3 rewrites line 5 of A2x (`echo d`), the line `echo $1` had in A1
  writeFileSync(s.file, A2x.replace("echo d", "echo D"));
  const e3 = { structuredPatch: [{ oldStart: 3, oldLines: 3, newStart: 3, newLines: 3, lines: [" echo c", " echo $1", "-echo d", "+echo D"] }], originalFile: A2x };
  await srv.edit(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: e3 }));
  await intoHold(s.e, 3);
  const text = await srv.reports(1500);
  assert.equal(times(text, "line4-marker"), 1);
  assert.doesNotMatch(text, /line5-marker/);
});

// ---- owner routing and the Stop / SubagentStop sweep (F40) -----------------------------------------------------------

test("a subagent's Edit is journaled and not linted; an Edit that changed nothing journals nothing", async () => {
  const s = setup();
  const srv = server(s.e, s.findings, 0);
  s.setFindings(FINDING_L2);
  assert.equal(await srv.edit(bySub(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: { structuredPatch: [] } }))), "");
  await noPending(s, srv, AGENT);
  s.setFindings(`a.sh:1:1: note: line1-marker [SC2086]\n${FINDING_L2}`);
  assert.equal(await srv.edit(bySub(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L2 }))), "");
  assert.deepEqual(s.e.lines(), [], "no linter ran");
  assert.deepEqual(await srv.stop(), {}, "not the main conversation's record");
  const swept = await srv.stop(AGENT);
  assert.equal(swept.decision, "block");
  assert.match(swept.reason ?? "", /line2-marker/, "the journaled ranges gate the sweep: the edited line");
  assert.doesNotMatch(swept.reason ?? "", /line1-marker/, "a line outside the edit stays gated");
});

test("SubagentStop reports the agent's pending edits once, gated to the lines of all its edits", async () => {
  const s = setup();
  const srv = server(s.e, s.findings, 0);
  s.setFindings(`a.sh:1:1: note: line1-marker [SC2086]\n${FINDING_L2}a.sh:4:6: note: line4-marker [SC2086]\n`);
  assert.equal(await srv.edit(bySub(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L2 }))), "");
  writeFileSync(s.file, SH4_L4);
  assert.equal(await srv.edit(bySub(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: { ...EDIT_L4, originalFile: SH4 } }))), "");
  const swept = await srv.stop(AGENT);
  assert.equal(swept.decision, "block");
  assert.match(swept.reason ?? "", /^universal-lint: shellcheck found issues in a\.sh:/);
  assert.match(swept.reason ?? "", /line2-marker/);
  assert.match(swept.reason ?? "", /line4-marker/);
  assert.doesNotMatch(swept.reason ?? "", /line1-marker/, "a line the agent did not touch stays gated");
  assert.equal(s.e.lines().length, 1, "one lint for the file, not one per edit");
  await noPending(s, srv, AGENT);
});

test("the stop that follows a report is let through without a sweep; the next fresh stop sweeps again", async () => {
  const s = setup();
  const srv = server(s.e, s.findings, 0);
  s.setFindings(FINDING_L2);
  const edit = bySub(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L2 }));
  await srv.edit(edit);
  assert.equal((await srv.stop(AGENT)).decision, "block");
  await srv.edit(edit); // the agent's fix attempt
  const again = await srv.stop({ ...AGENT, stop_hook_active: true });
  assert.equal(again.decision, undefined, "never block the same stop twice");
  assert.equal(s.e.lines().length, 1);
  const fresh = await srv.stop(AGENT);
  assert.equal(fresh.decision, "block");
  assert.match(fresh.reason ?? "", /line2-marker/);
});

test("a stop continued by another hook (stop_hook_active without an own report) still sweeps", async () => {
  const s = setup();
  const srv = server(s.e, s.findings, 0);
  s.setFindings(FINDING_L2);
  await srv.edit(bySub(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L2 })));
  const swept = await srv.stop({ ...AGENT, stop_hook_active: true });
  assert.equal(swept.decision, "block");
  assert.match(swept.reason ?? "", /line2-marker/);
});

test("a sweep with nothing pending, with a clean file or with a file that is gone reports nothing", async () => {
  const s = setup();
  const srv = server(s.e, s.findings, 0);
  assert.equal((await srv.stop()).decision, undefined);
  assert.equal((await srv.stop(AGENT)).decision, undefined);
  assert.deepEqual(s.e.lines(), []);
  const edit = bySub(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L2 }));
  await srv.edit(edit);
  assert.equal((await srv.stop(AGENT)).decision, undefined);
  assert.equal(s.e.lines().length, 1);
  s.setFindings(FINDING_L2);
  await noPending(s, srv, AGENT);
  await srv.edit(edit);
  rmSync(s.file);
  assert.equal((await srv.stop(AGENT)).decision, undefined);
  assert.equal(s.e.lines().length, 1, "a file out of scope is not linted");
  writeFileSync(s.file, SH4);
  await noPending(s, srv, AGENT); // the sweep dropped the gone file's records
});

test("Stop sweeps the main conversation's pending file: the held lint is claimed and stays silent; a subagent's stop does not touch it", async () => {
  const s = setup();
  const srv = server(s.e, s.findings, 3000);
  s.setFindings(FINDING_L2);
  await srv.edit(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L2 }));
  await intoHold(s.e);
  assert.equal((await srv.stop(AGENT)).decision, undefined);
  const swept = await srv.stop();
  assert.equal(swept.decision, "block");
  assert.match(swept.reason ?? "", /line2-marker/);
  assert.equal(await srv.reports(3000), "", "the held lint stays silent");
  assert.equal(s.e.lines().length, 2, "the edit's lint and the sweep's");
});

test("a held finding that the turn end finds repaired outside Write/Edit is never reported", async () => {
  const s = setup();
  const srv = server(s.e, s.findings, 1500);
  s.setFindings(FINDING_L2);
  await srv.edit(payload(s.file, s.e.cwd, { toolName: "Edit", toolResponse: SET_L2 }));
  await intoHold(s.e);
  writeFileSync(s.file, SH4_FIXED); // e.g. `sed -i` on an unwatched file
  s.setFindings("");
  assert.equal(await srv.reports(1500), "", "the file changed during the hold");
  const runs = s.e.lines().length;
  assert.equal((await srv.stop()).decision, undefined);
  assert.equal(s.e.lines().length, runs + 1, "left for the sweep: the stop linted the file");
  await noPending(s, srv);
});
