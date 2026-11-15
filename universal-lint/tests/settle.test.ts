// Settle window (F34, F40): edits are journaled per owner, findings are held until the owner is quiet and reported by the lint of the newest state.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, test } from "vitest";
import { carryLine, editHunks, editRanges, hashPath, ownerOf, pendingRanges, recordEdit, settleFindings, settleWaitMs } from "../plugin/hooks/lint-file.mjs";

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
  assert.deepEqual(editHunks(edit(REPLACE_L2)), [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, map: [0, -1, 2, 3] }]);
});

test("editHunks: a pure deletion shrinks the new side, an insertion grows it", () => {
  assert.deepEqual(editHunks(edit(DELETE_L2)), [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 4, map: [0, -1, 1, 2, 3] }]);
  assert.deepEqual(editHunks(edit(INSERT_2)), [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 5, map: [0, 3, 4] }]);
});

test("editHunks: `\\ No newline at end of file` is not a line", () => {
  const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "\\ No newline at end of file", "+b", "\\ No newline at end of file"] }];
  assert.deepEqual(editHunks(edit(patch)), [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, map: [-1] }]);
});

test("editHunks: Write, another tool, a missing or malformed patch -> null (whole file)", () => {
  assert.equal(editHunks({ tool_name: "Write", tool_response: { structuredPatch: REPLACE_L2 } }), null);
  assert.equal(editHunks({ tool_name: "Edit", tool_response: {} }), null);
  assert.equal(editHunks(edit("nope")), null);
  assert.equal(editHunks(edit([{ newStart: 1, lines: [] }])), null);
  assert.equal(editHunks(edit([{ oldStart: 1, newStart: 1, lines: "x" }])), null);
  assert.deepEqual(editHunks(edit([])), []);
});

test("carryLine: a replaced line is touched, the others keep or shift their place", () => {
  const h = editHunks(edit(REPLACE_L2)) ?? [];
  assert.equal(carryLine(0, h), 0);
  assert.equal(carryLine(1, h), null);
  assert.equal(carryLine(2, h), 2);
  assert.equal(carryLine(9, h), 9); // after the hunk, same size: no shift
});

test("carryLine: a deletion shifts the lines after it, an insertion pushes them down", () => {
  const del = editHunks(edit(DELETE_L2)) ?? [];
  assert.equal(carryLine(1, del), null);
  assert.equal(carryLine(2, del), 1);
  assert.equal(carryLine(10, del), 9);
  const ins = editHunks(edit(INSERT_2)) ?? [];
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

/** Scratch root of this file's journal tests, removed when the file finishes. */
const SCRATCH = mkdtempSync(path.join(tmpdir(), "universal-lint-settle-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
/** Counter giving every `world` its own directory. */
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
/** The owner of a payload without session and agent (what `recordEdit` and `settleFindings` default to). */
const MAIN = ownerOf(undefined);
/** Another owner: a subagent of the same (unnamed) session. */
const AGENT = ownerOf({ cwd: "", agent_id: "a1" });

/** Make the scratch directories of one scenario and point the plugin data dir at them. */
function world() {
  const base = path.join(SCRATCH, String(worlds++));
  const data = path.join(base, "data");
  const proj = path.join(base, "proj");
  mkdirSync(proj, { recursive: true });
  process.env.CLAUDE_PLUGIN_DATA = data;
  process.env.UNIVERSAL_LINT_SETTLE_MS = "0";
  const file = path.join(proj, "a.sh");
  const journal = path.join(data, "settle");
  /** The record files in the journal (the `act` directory holds the activity stamps). */
  const records = (): string[] => readdirSync(journal).filter((n) => n.endsWith(".json"));
  return { data, proj, file, journal, records, real: realpathSync(proj) + "/a.sh" };
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
 * @param owner - The journal owner.
 * @returns The record handle.
 */
async function journalEdit(w: ReturnType<typeof world>, before: string, content: string, hunks: unknown, owner = MAIN) {
  await sleep(3); // same pid, same millisecond would collide on the record name
  writeFileSync(w.file, content);
  const e = hunks === null ? { tool_name: "Write" } : edit(hunks);
  const rec = recordEdit(w.file, w.real, editHunks(e), hunks === null ? null : digestOf(before), digestOf(content), owner, editRanges(e), w.proj);
  assert.ok(rec);
  return rec;
}

/** The stored records of the world's file for an owner, oldest first. */
const stored = (w: ReturnType<typeof world>, owner = MAIN) => w.records().filter((n) => n.endsWith(`-${owner}.json`)).sort().map((n) => JSON.parse(readFileSync(path.join(w.journal, n), "utf8")));

test("ownerOf: the session and the agent name the owner, a payload without them is the main conversation of no session", () => {
  assert.match(MAIN, /^[0-9a-f]{16}$/);
  assert.equal(ownerOf({ cwd: "" }), MAIN);
  assert.notEqual(AGENT, MAIN);
  assert.notEqual(ownerOf({ cwd: "", session_id: "s1" }), MAIN);
  assert.notEqual(ownerOf({ cwd: "", session_id: "s1", agent_id: "a1" }), ownerOf({ cwd: "", session_id: "s1" }));
  assert.equal(ownerOf({ cwd: "", session_id: "s1", agent_id: "a1" }), ownerOf({ cwd: "", session_id: "s1", agent_id: "a1" }));
  assert.notEqual(ownerOf({ cwd: "", session_id: "s1a", agent_id: "1" }), ownerOf({ cwd: "", session_id: "s1", agent_id: "a1" }));
});

test("recordEdit writes <key>-<ms>-<pid>-<owner>.json with hunks, lines, digests, path and cwd, and the activity stamp", () => {
  const w = world();
  writeFileSync(w.file, SIX);
  const hunks = editHunks(edit(REPLACE_3));
  const t0 = Date.now();
  const rec = recordEdit(w.file, w.real, hunks, digestOf("before"), undefined, AGENT, [[2, 2]], w.proj);
  assert.ok(rec);
  assert.equal(rec.key, hashPath(w.real));
  assert.deepEqual(w.records(), [rec.name]);
  assert.match(rec.name, new RegExp(`^[0-9a-f]{64}-\\d{15}-\\d+-${AGENT}\\.json$`));
  assert.deepEqual(JSON.parse(readFileSync(path.join(w.journal, rec.name), "utf8")), { hunks, ranges: [[2, 2]], digest: digestOf(SIX), before: digestOf("before"), fp: w.file, cwd: w.proj });
  assert.deepEqual(readdirSync(path.join(w.journal, "act")), [AGENT]);
  const stamp = Number(readFileSync(path.join(w.journal, "act", AGENT), "utf8"));
  assert.ok(stamp >= t0 && stamp <= Date.now());
});

test("recordEdit keeps pending records for a day and prunes older ones, temp leftovers too", () => {
  const w = world();
  writeFileSync(w.file, SIX);
  mkdirSync(w.journal, { recursive: true });
  const stamp = (ms: number) => String(ms).padStart(15, "0");
  const day = 24 * 60 * 60 * 1000;
  const old = `${"a".repeat(64)}-${stamp(Date.now() - day - 60_000)}-1-${MAIN}.json`;
  const oldTmp = `${"b".repeat(64)}-${stamp(Date.now() - 2 * day)}-1-${MAIN}.json.tmp`;
  const pending = `${"c".repeat(64)}-${stamp(Date.now() - day + 60_000)}-1-${MAIN}.json`;
  for (const n of [old, oldTmp, pending]) writeFileSync(path.join(w.journal, n), "{}");
  const rec = recordEdit(w.file, w.real, null);
  assert.ok(rec);
  const byName = (a: string, b: string): number => a.localeCompare(b);
  assert.deepEqual(w.records().sort(byName), [pending, rec.name].sort(byName));
  assert.ok(!readdirSync(w.journal).includes(oldTmp));
});

test("recordEdit also prunes a record dated far ahead (clock stepped back): it must not read as a later edit", async () => {
  const w = world();
  writeFileSync(w.file, SIX);
  const first = recordEdit(w.file, w.real, null);
  assert.ok(first);
  const ahead = `${first.key}-${String(Date.now() + 3_600_000).padStart(15, "0")}-1-${MAIN}.json`;
  writeFileSync(path.join(w.journal, ahead), "{}");
  await sleep(3);
  const own = recordEdit(w.file, w.real, null);
  assert.ok(own);
  assert.ok(!w.records().includes(ahead));
  const f = [found(w.proj, [3])];
  assert.equal(await settleFindings(f, w.file, own, digestOf(SIX), digestOf(SIX)), f);
});

test("recordEdit fails open: an unusable data dir gives null", () => {
  const w = world();
  writeFileSync(w.file, SIX);
  process.env.CLAUDE_PLUGIN_DATA = w.file; // a regular file: mkdir below it fails
  assert.equal(recordEdit(w.file, w.real, null), null);
});

test("pendingRanges: one record alone gives its own lines, whatever the digests say", async () => {
  const w = world();
  await journalEdit(w, SIX, SIX.replace("l3", "L3"), REPLACE_3);
  assert.deepEqual(pendingRanges(stored(w), digestOf("a formatter rewrote the file")), [[2, 2]]);
  const v = world();
  await journalEdit(v, SIX, "rewritten\n", null);
  assert.equal(pendingRanges(stored(v), digestOf("rewritten\n")), null);
  assert.equal(pendingRanges([], digestOf(SIX)), null);
});

test("pendingRanges: an earlier edit's line is carried through a later insertion above it and joined with the later lines", async () => {
  const w = world();
  const a = SIX.replace("l3", "L3");
  const b = "l1\nn1\nn2\nl2\nL3\nl4\nl5\nl6\n";
  await journalEdit(w, SIX, a, REPLACE_3);
  await journalEdit(w, a, b, INSERT_AFTER_1);
  assert.deepEqual(pendingRanges(stored(w), digestOf(b)), [[4, 4], [1, 2]]);
});

test("pendingRanges: a line a later edit replaced is no longer an earlier edit's line", async () => {
  const w = world();
  const a = SIX.replace("l3", "L3");
  const b = a.replace("L3", "l3");
  await journalEdit(w, SIX, a, REPLACE_3);
  await journalEdit(w, a, b, [{ oldStart: 2, oldLines: 3, newStart: 2, newLines: 3, lines: [" l2", "-L3", "+l3", " l4"] }]);
  assert.deepEqual(pendingRanges(stored(w), digestOf(b)), [[2, 2]]);
});

test("pendingRanges: a Write among the pending edits means the whole file", async () => {
  const w = world();
  await journalEdit(w, "", SIX, null);
  await journalEdit(w, SIX, SIX.replace("l3", "L3"), REPLACE_3);
  assert.equal(pendingRanges(stored(w), digestOf(SIX.replace("l3", "L3"))), null);
});

test("pendingRanges: a broken chain means the whole file (a change nobody journaled, a formatter, hooks out of edit order)", async () => {
  const a = SIX.replace("l3", "L3");
  const b = a.replace("l6", "L6");
  const between = world(); // the second edit was cut from content no record holds
  await journalEdit(between, SIX, a, REPLACE_3);
  await journalEdit(between, "shifted by sed -i", b, REPLACE_6);
  assert.equal(pendingRanges(stored(between), digestOf(b)), null);
  const after = world(); // the file is no longer what the last edit wrote
  await journalEdit(after, SIX, a, REPLACE_3);
  await journalEdit(after, a, b, REPLACE_6);
  assert.deepEqual(pendingRanges(stored(after), digestOf(b)), [[2, 2], [5, 5]]);
  assert.equal(pendingRanges(stored(after), digestOf("reformatted")), null);
  const swapped = world(); // the later edit's hook journaled first
  await journalEdit(swapped, a, b, REPLACE_6);
  await journalEdit(swapped, SIX, a, REPLACE_3);
  assert.equal(pendingRanges(stored(swapped), digestOf(b)), null);
});

test("settleFindings: nothing to settle or nothing to tell returns at once", async () => {
  const w = world();
  const rec = await journalEdit(w, "", SIX, null);
  process.env.UNIVERSAL_LINT_SETTLE_MS = "400";
  const d0 = digestOf(SIX);
  const f = [found(w.proj, [3])];
  const t0 = Date.now();
  assert.deepEqual(await settleFindings([], w.file, rec, d0, d0), []);
  assert.equal(await settleFindings(f, w.file, null, d0, d0), f, "no journal record: reported (fail open)");
  assert.equal(await settleFindings(f, w.file, rec, null, null), f, "unreadable file: reported (fail open)");
  assert.deepEqual(await settleFindings(f, w.file, rec, d0, "changed during the lint"), [], "a later lint or the sweep reports the new content");
  assert.deepEqual(await settleFindings(f, w.file, rec, d0, null), []);
  assert.ok(Date.now() - t0 < 200, "none of these holds");
  assert.deepEqual(w.records(), [rec.name], "the record stays pending");
});

test("settleFindings: no later edit, the findings are reported and the file's records are cleared", async () => {
  const w = world();
  const a = SIX.replace("l3", "L3");
  await journalEdit(w, SIX, a, REPLACE_3);
  const rec = await journalEdit(w, a, a.replace("l6", "L6"), REPLACE_6);
  const d0 = digestOf(a.replace("l6", "L6"));
  const f = [found(w.proj, [3])];
  assert.equal(await settleFindings(f, w.file, rec, d0, d0), f);
  assert.deepEqual(w.records(), []);
});

test("settleFindings: a newer edit of the file by the same owner takes the report over, the records stay for it", async () => {
  const w = world();
  const rec = await journalEdit(w, "", SIX, null);
  const later = await journalEdit(w, SIX, SIX.replace("l6", "L6"), REPLACE_6);
  writeFileSync(w.file, SIX); // even with the content back to what the first lint read
  assert.deepEqual(await settleFindings([found(w.proj, [3])], w.file, rec, digestOf(SIX), digestOf(SIX)), []);
  assert.deepEqual(w.records().sort(), [rec.name, later.name].sort());
});

test("settleFindings: another owner's record of the file is no newer edit of this owner", async () => {
  const w = world();
  const rec = await journalEdit(w, "", SIX, null);
  const other = await journalEdit(w, "", SIX, null, AGENT);
  const f = [found(w.proj, [3])];
  assert.equal(await settleFindings(f, w.file, rec, digestOf(SIX), digestOf(SIX)), f);
  assert.deepEqual(w.records(), [other.name], "the other owner's record is not cleared");
});

test("settleFindings: the own record gone (a sweep claimed it, a later clean lint covered it) reports nothing", async () => {
  const w = world();
  const rec = await journalEdit(w, "", SIX, null);
  rmSync(path.join(w.journal, rec.name));
  assert.deepEqual(await settleFindings([found(w.proj, [3])], w.file, rec, digestOf(SIX), digestOf(SIX)), []);
});

test("settleFindings: a change outside Write/Edit during the hold reports nothing, the record stays for the sweep", async () => {
  const w = world();
  const rec = await journalEdit(w, "", SIX, null);
  process.env.UNIVERSAL_LINT_SETTLE_MS = "300";
  const held = settleFindings([found(w.proj, [3])], w.file, rec, digestOf(SIX), digestOf(SIX));
  await sleep(100);
  writeFileSync(w.file, SIX.replace("l3", "fixed by sed -i"));
  assert.deepEqual(await held, []);
  assert.deepEqual(w.records(), [rec.name]);
});

test("settleFindings: an unreadable journal means report", async () => {
  const w = world();
  const rec = await journalEdit(w, "", SIX, null);
  const f = [found(w.proj, [3])];
  rmSync(w.journal, { recursive: true });
  assert.equal(await settleFindings(f, w.file, rec, digestOf(SIX), digestOf(SIX)), f);
});

test("settleFindings: holds every finding for the quiet time, also one outside the file", async () => {
  const w = world();
  process.env.UNIVERSAL_LINT_SETTLE_MS = "400";
  const foreign = { tool: "tsc", target: "a.sh", base: w.proj, text: "/other/b.ts:1:1 error elsewhere-marker" };
  for (const f of [[found(w.proj, [3])], [foreign]]) {
    const rec = await journalEdit(w, "", SIX, null);
    const t0 = Date.now();
    assert.equal(await settleFindings(f, w.file, rec, digestOf(SIX), digestOf(SIX)), f);
    assert.ok(Date.now() - t0 >= 380, "held");
  }
});

test("settleFindings: the quiet time starts again with every Write/Edit of the owner, on any file; another owner's edits do not count", async () => {
  const w = world();
  const other = path.join(w.proj, "b.sh");
  writeFileSync(other, "echo b\n");
  const rec = await journalEdit(w, "", SIX, null);
  process.env.UNIVERSAL_LINT_SETTLE_MS = "500";
  const f = [found(w.proj, [3])];
  const t0 = Date.now();
  const held = settleFindings(f, w.file, rec, digestOf(SIX), digestOf(SIX));
  await sleep(300);
  assert.ok(recordEdit(other, realpathSync(other), null, null, null, MAIN)); // the owner edits another file: quiet again from here
  assert.equal(await held, f);
  assert.ok(Date.now() - t0 >= 780, `held ${Date.now() - t0} ms`);
  const rec2 = await journalEdit(w, "", SIX, null);
  const t1 = Date.now();
  const held2 = settleFindings(f, w.file, rec2, digestOf(SIX), digestOf(SIX));
  await sleep(300);
  assert.ok(recordEdit(other, realpathSync(other), null, null, null, AGENT));
  assert.equal(await held2, f);
  assert.ok(Date.now() - t1 < 780, `held ${Date.now() - t1} ms`);
});
