// Settle window (F34, F40): edits are journaled per owner, findings are held until the owner is quiet and reported by the lint of the newest state.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import { carryLine, editHunks, editRanges, hashPath, ownerOf, pendingRanges, type PendingRecord, recordEdit, runInCall, settleFindings, settleWaitMs, sweepHandler } from "../src/hooks/lint-core.ts";

/** The hook input type; the tests pass partial payloads on purpose (a Write, a missing patch). */
type HookInput = Parameters<typeof editHunks>[0];

/** An Edit payload with the given structuredPatch hunks. */
const edit = (structuredPatch: unknown) => ({ tool_name: "Edit", tool_response: { structuredPatch } });
/** Edit replacing line 2 of a 4-line file (same shape as tests/core.test.ts). */
const REPLACE_L2 = [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: [" echo a", "-echo $x", "+echo $1", " echo b", " echo $2"] }];
/** Edit deleting one line between lines 1 and 2. */
const DELETE_L2 = [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 4, lines: [" echo a", "-rm x", " echo $1", " echo b", " echo $2"] }];
/** Edit inserting two lines between lines 1 and 2. */
const INSERT_2 = [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 5, lines: [" l1", "+n1", "+n2", " l2", " l3"] }];

/**
 * Run `fn` with `UNIVERSAL_LINT_SETTLE_MS` and `CLAUDE_CODE_ENTRYPOINT` set (or unset), restoring the previous values.
 *
 * @param value - The seam value, or undefined to unset.
 * @param fn - The body.
 * @param entrypoint - The entrypoint value, or undefined to unset (vitest may itself run inside Claude Code).
 */
function withSeam(value: string | undefined, fn: () => void, entrypoint?: string): void {
  const old = { UNIVERSAL_LINT_SETTLE_MS: process.env.UNIVERSAL_LINT_SETTLE_MS, CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT };
  const set = (k: keyof typeof old, v: string | undefined): void => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  set("UNIVERSAL_LINT_SETTLE_MS", value);
  set("CLAUDE_CODE_ENTRYPOINT", entrypoint);
  try {
    fn();
  } finally {
    set("UNIVERSAL_LINT_SETTLE_MS", old.UNIVERSAL_LINT_SETTLE_MS);
    set("CLAUDE_CODE_ENTRYPOINT", old.CLAUDE_CODE_ENTRYPOINT);
  }
}

test("settleWaitMs: 20000 by default, the seam overrides it, bad seam values are ignored", () => {
  withSeam(undefined, () => assert.equal(settleWaitMs(0), 20_000));
  withSeam(undefined, () => assert.equal(settleWaitMs(0), 20_000), "cli");
  withSeam("0", () => assert.equal(settleWaitMs(0), 0));
  withSeam("250", () => assert.equal(settleWaitMs(0), 250));
  withSeam("abc", () => assert.equal(settleWaitMs(0), 20_000));
  withSeam("-1", () => assert.equal(settleWaitMs(0), 20_000));
  withSeam("", () => assert.equal(settleWaitMs(0), 20_000));
});

test("settleWaitMs: the time the owner has already been quiet counts", () => {
  withSeam(undefined, () => {
    assert.equal(settleWaitMs(0, 5000), 15_000);
    assert.equal(settleWaitMs(0, 19_999), 1);
    assert.equal(settleWaitMs(0, 20_000), 0);
    assert.equal(settleWaitMs(0, Date.now()), 0); // no activity stamp: quiet since the epoch
  });
});

test("settleWaitMs: a headless run (claude -p) holds nothing, unless the seam asks for a hold", () => {
  withSeam(undefined, () => assert.equal(settleWaitMs(0), 0), "sdk-cli");
  withSeam("250", () => assert.equal(settleWaitMs(0), 250), "sdk-cli");
});

test("settleWaitMs: the hold never reaches the 90 s hook backstop", () => {
  withSeam(undefined, () => {
    assert.equal(settleWaitMs(60_000), 20_000);
    assert.equal(settleWaitMs(87_000), 2000);
    assert.equal(settleWaitMs(89_500), 0);
    assert.equal(settleWaitMs(95_000), 0);
  });
});

test("editHunks: a replaced line maps to -1, the context lines to their new index", () => {
  assert.deepEqual(editHunks(edit(REPLACE_L2) as HookInput), [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, map: [0, -1, 2, 3] }]);
});

test("editHunks: a pure deletion shrinks the new side, an insertion grows it", () => {
  assert.deepEqual(editHunks(edit(DELETE_L2) as HookInput), [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 4, map: [0, -1, 1, 2, 3] }]);
  assert.deepEqual(editHunks(edit(INSERT_2) as HookInput), [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 5, map: [0, 3, 4] }]);
});

test("editHunks: `\\ No newline at end of file` is not a line", () => {
  const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "\\ No newline at end of file", "+b", "\\ No newline at end of file"] }];
  assert.deepEqual(editHunks(edit(patch) as HookInput), [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, map: [-1] }]);
});

test("editHunks: Write, another tool, a missing or malformed patch -> null (whole file)", () => {
  assert.equal(editHunks({ tool_name: "Write", tool_response: { structuredPatch: REPLACE_L2 } } as HookInput), null);
  assert.equal(editHunks({ tool_name: "Edit", tool_response: {} } as HookInput), null);
  assert.equal(editHunks(edit("nope") as HookInput), null);
  assert.equal(editHunks(edit([{ newStart: 1, lines: [] }]) as HookInput), null);
  assert.equal(editHunks(edit([{ oldStart: 1, newStart: 1, lines: "x" }]) as HookInput), null);
  assert.deepEqual(editHunks(edit([]) as HookInput), []);
});

test("carryLine: a replaced line is touched, the others keep or shift their place", () => {
  const h = editHunks(edit(REPLACE_L2) as HookInput) ?? [];
  assert.equal(carryLine(0, h), 0);
  assert.equal(carryLine(1, h), null);
  assert.equal(carryLine(2, h), 2);
  assert.equal(carryLine(9, h), 9); // after the hunk, same size: no shift
});

test("carryLine: a deletion shifts the lines after it, an insertion pushes them down", () => {
  const del = editHunks(edit(DELETE_L2) as HookInput) ?? [];
  assert.equal(carryLine(1, del), null);
  assert.equal(carryLine(2, del), 1);
  assert.equal(carryLine(10, del), 9);
  const ins = editHunks(edit(INSERT_2) as HookInput) ?? [];
  assert.equal(carryLine(0, ins), 0);
  assert.equal(carryLine(1, ins), 3);
  assert.equal(carryLine(20, ins), 22);
});

test("carryLine: lines before the first hunk are unchanged, shifts of several hunks add up", () => {
  const hunks = [
    { oldStart: 10, oldLines: 2, newStart: 10, newLines: 4, map: [9, 12] }, // +2 lines
    { oldStart: 30, oldLines: 3, newStart: 32, newLines: 2, map: [31, -1, 33] }, // -1 line
  ];
  assert.equal(carryLine(3, hunks), 3);
  assert.equal(carryLine(15, hunks), 17); // between the hunks: +2
  assert.equal(carryLine(30, hunks), null); // the removed line of the second hunk
  assert.equal(carryLine(50, hunks), 51); // after both: +2 -1
});

test("carryLine: a hunk without old lines names the line before it", () => {
  const hunks = [{ oldStart: 5, oldLines: 0, newStart: 6, newLines: 2, map: [] }]; // two lines inserted after 1-based line 5
  assert.equal(carryLine(4, hunks), 4); // the 5th line itself stays
  assert.equal(carryLine(5, hunks), 7);
});

// ---- journal, pending lines and the hold ----------------------------------------------------------------------------
// The journal lives in the module's memory, shared by every test of this file: each world has its own owners, and the
// presence of a record is asserted through behaviour (a sweep of the owner reports it, or answers {} when none is left).
// Removed with the file journal (spec inventory): "recordEdit fails open: an unusable data dir gives null" and
// "settleFindings: an unreadable journal means report"; a map has no unusable directory and no unreadable record.

/** Scratch root of this file's journal tests, removed when the file finishes. */
const SCRATCH = mkdtempSync(path.join(tmpdir(), "universal-lint-settle-"));
/** A directory holding a `shellcheck` stub that reports a marker on lines 1 to 8 of `a.sh` (exit 1). */
const STUB_BIN = path.join(SCRATCH, "bin");
/** The PATH before this file put the stub first. */
const OLD_PATH = process.env.PATH;
beforeAll(() => {
  mkdirSync(STUB_BIN, { recursive: true });
  const out = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `a.sh:${n}:1: note: sweep-marker${n} [SC2086]`).join("\\n\\n");
  writeFileSync(path.join(STUB_BIN, "shellcheck"), `#!/bin/sh\nprintf '${out}\\n'\nexit 1\n`, { mode: 0o755 });
  process.env.PATH = `${STUB_BIN}${path.delimiter}${OLD_PATH ?? ""}`;
});
afterAll(() => {
  process.env.PATH = OLD_PATH;
  rmSync(SCRATCH, { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());
/** Counter giving every `world` its own directory and owners. */
let worlds = 0;
/** The 6-line file the scenarios start from. */
const SIX = "l1\nl2\nl3\nl4\nl5\nl6\n";
/** SHA-256 base64 of a text, as `fileDigest` computes it. */
const digestOf = (text: string): string => createHash("sha256").update(text).digest("base64");
/** Hunks replacing line 3 of SIX. */
const REPLACE_3 = [{ oldStart: 1, oldLines: 6, newStart: 1, newLines: 6, lines: [" l1", " l2", "-l3", "+L3", " l4", " l5", " l6"] }];
/** Hunks replacing line 6 of SIX. */
const REPLACE_6 = [{ oldStart: 4, oldLines: 3, newStart: 4, newLines: 3, lines: [" l4", " l5", "-l6", "+L6"] }];
/** Hunks inserting two lines after line 1 of SIX. */
const INSERT_AFTER_1 = [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 5, lines: [" l1", "+n1", "+n2", " l2", " l3"] }];
/** The owner of a payload without session and agent. */
const MAIN = ownerOf(undefined);
/** Another owner: a subagent of the same (unnamed) session. */
const AGENT = ownerOf({ cwd: "", agent_id: "a1" });

/** Make the scratch directory of one scenario, with its own session and owners. */
function world() {
  const session = `w${worlds++}`;
  const proj = path.join(SCRATCH, session);
  mkdirSync(proj, { recursive: true });
  process.env.UNIVERSAL_LINT_SETTLE_MS = "0";
  const file = path.join(proj, "a.sh");
  /** The records this world's `journalEdit` calls stored, oldest first. */
  const recs: PendingRecord[] = [];
  return { proj, file, session, recs, real: realpathSync(proj) + "/a.sh", main: ownerOf({ cwd: "", session_id: session }), agent: ownerOf({ cwd: "", session_id: session, agent_id: "a1" }) };
}

/** A shellcheck-style finding with one diagnostic per given 1-based line. */
const found = (proj: string, lines: number[]) => ({ tool: "shellcheck", target: "a.sh", base: proj, text: lines.map((n) => `a.sh:${n}:6: note: m${n}-marker [SC2086]`).join("\n\n") });

/**
 * Journal one Edit of the world's file as the hook does: write the new content, record hunks, lines and digests.
 *
 * @param w - The `world`.
 * @param before - The content the hunks apply to.
 * @param content - The content after the edit.
 * @param hunks - The `structuredPatch` hunks, or null for a Write.
 * @param owner - The journal owner; default the world's main conversation.
 * @returns The record handle.
 */
function journalEdit(w: ReturnType<typeof world>, before: string, content: string, hunks: unknown, owner = w.main) {
  writeFileSync(w.file, content);
  const e = hunks === null ? { tool_name: "Write" } : edit(hunks);
  const h = editHunks(e as HookInput);
  const ranges = editRanges(e as HookInput);
  const rec = recordEdit(w.file, w.real, h, hunks === null ? null : digestOf(before), digestOf(content), owner, ranges, w.proj);
  assert.ok(rec);
  w.recs.push({ hunks: h, ranges: ranges ?? null, digest: digestOf(content), before: hunks === null ? null : digestOf(before), fp: w.file, cwd: w.proj });
  return rec;
}

/** The records the world's `journalEdit` calls stored, oldest first. */
const stored = (w: ReturnType<typeof world>) => w.recs;

/**
 * The Stop sweep of the world's main conversation (or with `agent` its subagent's SubagentStop), in a call context.
 *
 * @param w - The `world`.
 * @param agent - Sweep the subagent `a1` instead.
 * @returns The sweep's hook result: the stub's findings when a record was pending, else {}.
 */
const sweep = (w: ReturnType<typeof world>, agent = false) => runInCall(new AbortController().signal, () => sweepHandler({ cwd: w.proj, session_id: w.session, ...(agent ? { agent_id: "a1", hook_event_name: "SubagentStop" } : { hook_event_name: "Stop" }) }));

/**
 * Whether a promise is still pending after `ms`.
 *
 * @param p - The promise.
 * @param ms - How long to wait.
 * @returns `"pending"` or `"held"` (settled first).
 */
const after = (p: Promise<unknown>, ms: number) => Promise.race([p.then(() => "held"), sleep(ms).then(() => "pending")]);

test("ownerOf: the session and the agent name the owner, a payload without them is the main conversation of no session", () => {
  assert.match(MAIN, /^[0-9a-f]{16}$/);
  assert.equal(ownerOf({ cwd: "" }), MAIN);
  assert.notEqual(AGENT, MAIN);
  assert.notEqual(ownerOf({ cwd: "", session_id: "s1" }), MAIN);
  assert.notEqual(ownerOf({ cwd: "", session_id: "s1", agent_id: "a1" }), ownerOf({ cwd: "", session_id: "s1" }));
  assert.equal(ownerOf({ cwd: "", session_id: "s1", agent_id: "a1" }), ownerOf({ cwd: "", session_id: "s1", agent_id: "a1" }));
  assert.notEqual(ownerOf({ cwd: "", session_id: "s1a", agent_id: "1" }), ownerOf({ cwd: "", session_id: "s1", agent_id: "a1" }));
});

test("recordEdit names <key>-<seq 12>-<ms 15>-<owner>.json and makes the owner active", async () => {
  const w = world();
  writeFileSync(w.file, SIX);
  const rec = recordEdit(w.file, w.real, editHunks(edit(REPLACE_3) as HookInput), digestOf("before"), undefined, w.agent, [[2, 2]], w.proj);
  assert.ok(rec);
  assert.equal(rec.key, hashPath(w.real));
  assert.match(rec.name, new RegExp(`^[0-9a-f]{64}-\\d{12}-\\d{15}-${w.agent}\\.json$`));
  process.env.UNIVERSAL_LINT_SETTLE_MS = "300";
  const f = [found(w.proj, [3])];
  const held = settleFindings(f, w.file, rec, digestOf(SIX), digestOf(SIX), w.agent);
  assert.equal(await after(held, 100), "pending", "the owner just edited: the hold runs");
  assert.equal(await held, f);
});

test("recordEdit keeps pending records for a day and prunes older ones", async () => {
  const w = world();
  writeFileSync(w.file, SIX);
  const t = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const now = vi.spyOn(Date, "now").mockReturnValue(t);
  assert.ok(recordEdit(w.file, w.real, null, null, null, w.agent, null, w.proj)); // the old record
  now.mockReturnValue(t + 120_000);
  assert.ok(recordEdit(w.file, w.real, null, null, null, w.main, null, w.proj)); // still pending a day later
  now.mockReturnValue(t + day + 60_000);
  const other = path.join(w.proj, "b.txt"); // not lintable: its record never reports
  writeFileSync(other, "x\n");
  assert.ok(recordEdit(other, realpathSync(other), null, null, null, w.main, null, w.proj));
  now.mockRestore();
  assert.deepEqual(await sweep(w, true), {}, "the day-old record was pruned");
  assert.match(String((await sweep(w)).hookSpecificOutput?.additionalContext), /sweep-marker/, "the younger record stayed");
});

test("a record dated far ahead (clock stepped back) does not read as a later edit: the journal orders by sequence, not by the clock", async () => {
  const w = world();
  writeFileSync(w.file, SIX);
  const t = Date.now();
  const now = vi.spyOn(Date, "now").mockReturnValue(t + 3_600_000);
  assert.ok(recordEdit(w.file, w.real, null, null, null, w.main, null, w.proj));
  now.mockReturnValue(t);
  const own = recordEdit(w.file, w.real, null, null, null, w.main, null, w.proj);
  assert.ok(own);
  now.mockRestore();
  const f = [found(w.proj, [3])];
  assert.equal(await settleFindings(f, w.file, own, digestOf(SIX), digestOf(SIX), w.main), f);
});

test("a clock stepped back between two edits of a file does not reorder them: the later edit is the newest record and reports", async () => {
  const w = world();
  writeFileSync(w.file, SIX);
  const t = Date.now();
  const now = vi.spyOn(Date, "now").mockReturnValue(t);
  const first = recordEdit(w.file, w.real, null, null, null, w.main, null, w.proj);
  now.mockReturnValue(t - 5000);
  const second = recordEdit(w.file, w.real, null, null, null, w.main, null, w.proj);
  now.mockRestore();
  assert.ok(first && second);
  const f = [found(w.proj, [3])];
  assert.deepEqual(await settleFindings(f, w.file, first, digestOf(SIX), digestOf(SIX), w.main), [], "a newer edit owns the report");
  assert.equal(await settleFindings(f, w.file, second, digestOf(SIX), digestOf(SIX), w.main), f);
});

test("pendingRanges: one record alone gives its own lines, whatever the digests say", () => {
  const w = world();
  journalEdit(w, SIX, SIX.replace("l3", "L3"), REPLACE_3);
  assert.deepEqual(pendingRanges(stored(w), digestOf("a formatter rewrote the file")), [[2, 2]]);
  const v = world();
  journalEdit(v, SIX, "rewritten\n", null);
  assert.equal(pendingRanges(stored(v), digestOf("rewritten\n")), null);
  assert.equal(pendingRanges([], digestOf(SIX)), null);
});

test("pendingRanges: an earlier edit's line is carried through a later insertion above it and joined with the later lines", () => {
  const w = world();
  const a = SIX.replace("l3", "L3");
  const b = "l1\nn1\nn2\nl2\nL3\nl4\nl5\nl6\n";
  journalEdit(w, SIX, a, REPLACE_3);
  journalEdit(w, a, b, INSERT_AFTER_1);
  assert.deepEqual(pendingRanges(stored(w), digestOf(b)), [[4, 4], [1, 2]]);
});

test("pendingRanges: a line a later edit replaced is no longer an earlier edit's line", () => {
  const w = world();
  const a = SIX.replace("l3", "L3");
  const b = a.replace("L3", "l3");
  journalEdit(w, SIX, a, REPLACE_3);
  journalEdit(w, a, b, [{ oldStart: 2, oldLines: 3, newStart: 2, newLines: 3, lines: [" l2", "-L3", "+l3", " l4"] }]);
  assert.deepEqual(pendingRanges(stored(w), digestOf(b)), [[2, 2]]);
});

test("pendingRanges: a Write among the pending edits means the whole file", () => {
  const w = world();
  journalEdit(w, "", SIX, null);
  journalEdit(w, SIX, SIX.replace("l3", "L3"), REPLACE_3);
  assert.equal(pendingRanges(stored(w), digestOf(SIX.replace("l3", "L3"))), null);
});

test("pendingRanges: a broken chain means the whole file (a change nobody journaled, a formatter, hooks out of edit order)", () => {
  const a = SIX.replace("l3", "L3");
  const b = a.replace("l6", "L6");
  const between = world(); // the second edit was cut from content no record holds
  journalEdit(between, SIX, a, REPLACE_3);
  journalEdit(between, "shifted by sed -i", b, REPLACE_6);
  assert.equal(pendingRanges(stored(between), digestOf(b)), null);
  const later = world(); // the file is no longer what the last edit wrote
  journalEdit(later, SIX, a, REPLACE_3);
  journalEdit(later, a, b, REPLACE_6);
  assert.deepEqual(pendingRanges(stored(later), digestOf(b)), [[2, 2], [5, 5]]);
  assert.equal(pendingRanges(stored(later), digestOf("reformatted")), null);
  const swapped = world(); // the later edit's hook journaled first
  journalEdit(swapped, a, b, REPLACE_6);
  journalEdit(swapped, SIX, a, REPLACE_3);
  assert.equal(pendingRanges(stored(swapped), digestOf(b)), null);
});

test("settleFindings: nothing to settle or nothing to tell returns at once", async () => {
  const w = world();
  const rec = journalEdit(w, "", SIX, null);
  process.env.UNIVERSAL_LINT_SETTLE_MS = "400";
  const d0 = digestOf(SIX);
  const f = [found(w.proj, [3])];
  assert.equal(await after(settleFindings([], w.file, rec, d0, d0, w.main), 200), "held", "no findings: no hold");
  assert.deepEqual(await settleFindings([], w.file, rec, d0, d0, w.main), []);
  assert.equal(await settleFindings(f, w.file, null, d0, d0, w.main), f, "no journal record: reported (fail open)");
  assert.equal(await settleFindings(f, w.file, rec, null, null, w.main), f, "unreadable file: reported (fail open)");
  assert.deepEqual(await settleFindings(f, w.file, rec, d0, "changed during the lint", w.main), [], "a later lint or the sweep reports the new content");
  assert.equal(await after(settleFindings(f, w.file, rec, d0, null, w.main), 200), "held", "a changed file: no hold");
  assert.deepEqual(await settleFindings(f, w.file, rec, d0, null, w.main), []);
  assert.match(String((await sweep(w)).hookSpecificOutput?.additionalContext), /sweep-marker/, "the record stays pending");
});

test("settleFindings: no later edit, the findings are reported and the file's records are cleared", async () => {
  const w = world();
  const a = SIX.replace("l3", "L3");
  journalEdit(w, SIX, a, REPLACE_3);
  const rec = journalEdit(w, a, a.replace("l6", "L6"), REPLACE_6);
  const d0 = digestOf(a.replace("l6", "L6"));
  const f = [found(w.proj, [3])];
  assert.equal(await settleFindings(f, w.file, rec, d0, d0, w.main), f);
  assert.deepEqual(await sweep(w), {}, "no record left");
});

test("settleFindings: a newer edit of the file by the same owner takes the report over, the records stay for it", async () => {
  const w = world();
  const rec = journalEdit(w, "", SIX, null);
  journalEdit(w, SIX, SIX.replace("l6", "L6"), REPLACE_6);
  writeFileSync(w.file, SIX); // even with the content back to what the first lint read
  assert.deepEqual(await settleFindings([found(w.proj, [3])], w.file, rec, digestOf(SIX), digestOf(SIX), w.main), []);
  assert.match(String((await sweep(w)).hookSpecificOutput?.additionalContext), /sweep-marker/, "the records stay pending");
});

test("settleFindings: another owner's record of the file is no newer edit of this owner", async () => {
  const w = world();
  const rec = journalEdit(w, "", SIX, null);
  journalEdit(w, "", SIX, null, w.agent);
  const f = [found(w.proj, [3])];
  assert.equal(await settleFindings(f, w.file, rec, digestOf(SIX), digestOf(SIX), w.main), f);
  assert.match(String((await sweep(w, true)).hookSpecificOutput?.additionalContext), /sweep-marker/, "the other owner's record is not cleared");
});

test("settleFindings: the own record gone (a sweep claimed it, a later clean lint covered it) reports nothing", async () => {
  const w = world();
  const rec = journalEdit(w, "", SIX, null);
  await sweep(w); // the sweep claims the record
  assert.deepEqual(await settleFindings([found(w.proj, [3])], w.file, rec, digestOf(SIX), digestOf(SIX), w.main), []);
});

test("settleFindings: a change outside Write/Edit during the hold reports nothing, the record stays for the sweep", async () => {
  const w = world();
  const rec = journalEdit(w, "", SIX, null);
  process.env.UNIVERSAL_LINT_SETTLE_MS = "300";
  const held = settleFindings([found(w.proj, [3])], w.file, rec, digestOf(SIX), digestOf(SIX), w.main);
  await sleep(100);
  writeFileSync(w.file, SIX.replace("l3", "fixed by sed -i"));
  assert.deepEqual(await held, []);
  assert.match(String((await sweep(w)).hookSpecificOutput?.additionalContext), /sweep-marker/);
});

test("settleFindings: holds every finding for the quiet time, also one outside the file", async () => {
  const w = world();
  process.env.UNIVERSAL_LINT_SETTLE_MS = "400";
  const foreign = { tool: "tsc", target: "a.sh", base: w.proj, text: "/other/b.ts:1:1 error elsewhere-marker" };
  for (const f of [[found(w.proj, [3])], [foreign]]) {
    const rec = journalEdit(w, "", SIX, null);
    const held = settleFindings(f, w.file, rec, digestOf(SIX), digestOf(SIX), w.main);
    assert.equal(await after(held, 100), "pending", "held");
    assert.equal(await held, f);
  }
});

test("settleFindings: the quiet time starts again with every Write/Edit of the owner, on any file; another owner's edits do not count", async () => {
  const w = world();
  const other = path.join(w.proj, "b.sh");
  writeFileSync(other, "echo b\n");
  const rec = journalEdit(w, "", SIX, null);
  process.env.UNIVERSAL_LINT_SETTLE_MS = "500";
  const f = [found(w.proj, [3])];
  const held = settleFindings(f, w.file, rec, digestOf(SIX), digestOf(SIX), w.main);
  await sleep(300);
  assert.ok(recordEdit(other, realpathSync(other), null, null, null, w.main)); // the owner edits another file: quiet again from here
  assert.equal(await after(held, 350), "pending", "the hold restarted with the owner's edit");
  assert.equal(await held, f);
  const rec2 = journalEdit(w, "", SIX, null);
  const held2 = settleFindings(f, w.file, rec2, digestOf(SIX), digestOf(SIX), w.main);
  await sleep(300);
  assert.ok(recordEdit(other, realpathSync(other), null, null, null, w.agent));
  assert.equal(await after(held2, 450), "held", "another owner's edit does not restart the hold");
  assert.equal(await held2, f);
});
