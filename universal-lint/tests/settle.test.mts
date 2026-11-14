// Settle window (F34): findings are held for a few seconds and dropped when a later edit rewrote the line they sit on.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, test } from "vitest";
import { carryLine, editHunks, gateFinding, hashPath, recordEdit, settleFindings, settleWaitMs } from "../plugin/hooks/lint-file.mjs";

/** An Edit payload with the given structuredPatch hunks. */
const edit = (structuredPatch: unknown) => ({ tool_name: "Edit", tool_response: { structuredPatch } });
/** Edit replacing line 2 of a 4-line file (same shape as tests/core.test.mts). */
const REPLACE_L2 = [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: [" echo a", "-echo $x", "+echo $1", " echo b", " echo $2"] }];
/** Edit deleting one line between lines 1 and 2. */
const DELETE_L2 = [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 4, lines: [" echo a", "-rm x", " echo $1", " echo b", " echo $2"] }];
/** Edit inserting two lines between lines 1 and 2. */
const INSERT_2 = [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 5, lines: [" l1", "+n1", "+n2", " l2", " l3"] }];

/**
 * Run `fn` with `UNIVERSAL_LINT_SETTLE_MS` set (or unset), restoring the previous value.
 *
 * @param value - The value, or undefined to unset.
 * @param fn - The body.
 */
function withSeam(value: string | undefined, fn: () => void): void {
  const old = process.env.UNIVERSAL_LINT_SETTLE_MS;
  if (value === undefined) delete process.env.UNIVERSAL_LINT_SETTLE_MS;
  else process.env.UNIVERSAL_LINT_SETTLE_MS = value;
  try {
    fn();
  } finally {
    if (old === undefined) delete process.env.UNIVERSAL_LINT_SETTLE_MS;
    else process.env.UNIVERSAL_LINT_SETTLE_MS = old;
  }
}

test("settleWaitMs: 5000 by default, the seam overrides it, bad seam values are ignored", () => {
  withSeam(undefined, () => assert.equal(settleWaitMs(0), 5000));
  withSeam("0", () => assert.equal(settleWaitMs(0), 0));
  withSeam("250", () => assert.equal(settleWaitMs(0), 250));
  withSeam("abc", () => assert.equal(settleWaitMs(0), 5000));
  withSeam("-1", () => assert.equal(settleWaitMs(0), 5000));
  withSeam("", () => assert.equal(settleWaitMs(0), 5000));
});

test("settleWaitMs: the hold never reaches the 90 s hook backstop", () => {
  withSeam(undefined, () => {
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

/** A shellcheck-style finding of two diagnostics, on 1-based lines 3 and 5 of /p/a.sh. */
const finding = () => ({ tool: "shellcheck", target: "a.sh", base: "/p", text: "a.sh:3:6: note: x-marker [SC2086]\na.sh:5:1: note: y-marker [SC2086]" });

test("gateFinding with a predicate keeps the diagnostics whose line the predicate accepts", () => {
  const kept = gateFinding(finding(), (line0: number) => line0 !== 2, "/p/a.sh");
  assert.ok(kept);
  assert.doesNotMatch(kept.text, /x-marker/);
  assert.match(kept.text, /y-marker/);
  assert.equal(gateFinding(finding(), () => false, "/p/a.sh"), null);
});

test("gateFinding: keepParseErrors=false drops a parse error the predicate rejects, the default keeps it", () => {
  const parse = { tool: "shellcheck", target: "a.sh", base: "/p", text: "a.sh:3:1: error: Couldn't parse this. [SC1073]" };
  assert.ok(gateFinding(parse, () => false, "/p/a.sh"));
  assert.equal(gateFinding(parse, () => false, "/p/a.sh", false), null);
});

/** The built plugin is typed by inference from its default (`true`): the string mode needs a cast. */
const DROP = "drop" as unknown as boolean;

test("gateFinding: keepParseErrors='drop' drops an own-file parse error on any line, keeps the rest", () => {
  const parse = { tool: "shellcheck", target: "a.sh", base: "/p", text: "a.sh:3:1: error: Couldn't parse this. [SC1073]" };
  assert.equal(gateFinding(parse, () => true, "/p/a.sh", DROP), null);
  const mixed = { ...parse, text: `${parse.text}\na.sh:5:1: note: y-marker [SC2086]` };
  assert.match(gateFinding(mixed, () => true, "/p/a.sh", DROP)?.text ?? "", /y-marker/);
  const foreign = { ...parse, text: "b.sh:3:1: error: Couldn't parse this. [SC1073]" };
  assert.ok(gateFinding(foreign, () => true, "/p/a.sh", DROP));
});

// ---- journal and supersession -------------------------------------------------------------------------------------

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

/** Make the scratch directories of one scenario and point the plugin data dir at them. */
function world() {
  const base = path.join(SCRATCH, String(worlds++));
  const data = path.join(base, "data");
  const proj = path.join(base, "proj");
  mkdirSync(proj, { recursive: true });
  process.env.CLAUDE_PLUGIN_DATA = data;
  process.env.UNIVERSAL_LINT_SETTLE_MS = "0";
  const file = path.join(proj, "a.sh");
  return { data, proj, file, journal: path.join(data, "settle"), real: realpathSync(proj) + "/a.sh" };
}

/** A shellcheck-style finding with one diagnostic per given 1-based line, plus optional extra paragraphs. */
const found = (proj: string, lines: number[], extra: string[] = []) => ({
  tool: "shellcheck",
  target: "a.sh",
  base: proj,
  text: [...lines.map((n) => `a.sh:${n}:6: note: m${n}-marker [SC2086]`), ...extra].join("\n\n"),
});

/**
 * Lay out one scenario: the file holds `SIX` and the lint's own record is written; every later edit rewrites the file
 * and records itself with its hunks (a sleep keeps the record names apart: same pid, same millisecond collides).
 *
 * @param w - The `world`.
 * @param later - The later edits in order: new file content and hunks (null = whole file).
 * @returns The own record, the digest of the content the linter read (SIX) and the digests after each later edit.
 */
async function lay(w: ReturnType<typeof world>, later: Array<{ content: string; hunks: unknown }>) {
  writeFileSync(w.file, SIX);
  const rec = recordEdit(w.file, w.real, null);
  assert.ok(rec);
  const after: string[] = [];
  for (const l of later) {
    await sleep(3);
    const before = after.at(-1) ?? digestOf(SIX);
    writeFileSync(w.file, l.content);
    assert.ok(recordEdit(w.file, w.real, l.hunks === null ? null : editHunks(edit(l.hunks)), l.hunks === null ? null : before));
    after.push(digestOf(l.content));
  }
  return { rec, d0: digestOf(SIX), after };
}

test("recordEdit writes <key>-<ms>-<pid>.json with the hunks and the digest, no temp file left", () => {
  const w = world();
  writeFileSync(w.file, SIX);
  const hunks = editHunks(edit(REPLACE_3));
  const rec = recordEdit(w.file, w.real, hunks);
  assert.ok(rec);
  assert.equal(rec.key, hashPath(w.real));
  assert.deepEqual(readdirSync(w.journal), [rec.name]);
  assert.match(rec.name, /^[0-9a-f]{64}-\d{15}-\d+\.json$/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(w.journal, rec.name), "utf8")), { hunks, digest: digestOf(SIX), before: null });
});

test("recordEdit prunes entries older than the hook timeout, also temp leftovers, and keeps fresh ones", () => {
  const w = world();
  writeFileSync(w.file, SIX);
  mkdirSync(w.journal, { recursive: true });
  const stamp = (ms: number) => String(ms).padStart(15, "0");
  const old = `${"a".repeat(64)}-${stamp(Date.now() - 91_000)}-1.json`;
  const oldTmp = `${"b".repeat(64)}-${stamp(Date.now() - 120_000)}-1.json.tmp`;
  const fresh = `${"c".repeat(64)}-${stamp(Date.now() - 10_000)}-1.json`;
  for (const n of [old, oldTmp, fresh]) writeFileSync(path.join(w.journal, n), "{}");
  const rec = recordEdit(w.file, w.real, null);
  assert.ok(rec);
  const byName = (a: string, b: string): number => a.localeCompare(b);
  assert.deepEqual(readdirSync(w.journal).sort(byName), [fresh, rec.name].sort(byName));
});

test("recordEdit also prunes a record dated far ahead (clock stepped back): it must not read as a later edit", async () => {
  const w = world();
  const { rec, d0 } = await lay(w, []);
  const hunks = [{ oldStart: 1, oldLines: 6, newStart: 1, newLines: 6, map: [-1, -1, -1, -1, -1, -1] }];
  const ahead = `${rec.key}-${String(Date.now() + 3_600_000).padStart(15, "0")}-1.json`;
  writeFileSync(path.join(w.journal, ahead), JSON.stringify({ hunks, digest: "stale" }));
  await sleep(3);
  const own = recordEdit(w.file, w.real, null);
  assert.ok(own);
  assert.ok(!readdirSync(w.journal).includes(ahead));
  const f = [found(w.proj, [3])];
  assert.equal(await settleFindings(f, w.file, own, d0, d0), f);
});

test("recordEdit fails open: an unusable data dir gives null", () => {
  const w = world();
  writeFileSync(w.file, SIX);
  process.env.CLAUDE_PLUGIN_DATA = w.file; // a regular file: mkdir below it fails
  assert.equal(recordEdit(w.file, w.real, null), null);
});

test("settleFindings: nothing to settle returns the findings at once", async () => {
  const w = world();
  const { rec, d0 } = await lay(w, [{ content: SIX.replace("l3", "L3"), hunks: REPLACE_3 }]);
  process.env.UNIVERSAL_LINT_SETTLE_MS = "400";
  const f = [found(w.proj, [3])];
  const t0 = Date.now();
  assert.deepEqual(await settleFindings([], w.file, rec, d0, d0), []);
  assert.equal(await settleFindings(f, w.file, null, d0, d0), f);
  assert.equal(await settleFindings(f, w.file, rec, null, null), f);
  assert.equal(await settleFindings(f, w.file, rec, d0, "changed during the lint"), f);
  assert.ok(Date.now() - t0 < 200, "none of these holds");
});

test("settleFindings: no later edit, the findings stand", async () => {
  const w = world();
  const { rec, d0 } = await lay(w, []);
  const f = [found(w.proj, [3])];
  assert.equal(await settleFindings(f, w.file, rec, d0, d0), f);
});

test("settleFindings: a later edit that replaced the finding's line drops it, other lines stay", async () => {
  const w = world();
  const { rec, d0 } = await lay(w, [{ content: SIX.replace("l3", "L3"), hunks: REPLACE_3 }]);
  const out = await settleFindings([found(w.proj, [3, 5])], w.file, rec, d0, d0);
  assert.equal(out.length, 1);
  assert.doesNotMatch(out[0].text, /m3-marker/);
  assert.match(out[0].text, /m5-marker/);
  assert.deepEqual(await settleFindings([found(w.proj, [3])], w.file, rec, d0, d0), []);
});

test("settleFindings: a later edit elsewhere drops nothing", async () => {
  const w = world();
  const { rec, d0 } = await lay(w, [{ content: SIX.replace("l6", "L6"), hunks: REPLACE_6 }]);
  const f = [found(w.proj, [3])];
  assert.deepEqual(await settleFindings(f, w.file, rec, d0, d0), f);
});

test("settleFindings: lines inserted above push the finding down, it is not touched", async () => {
  const w = world();
  const { rec, d0 } = await lay(w, [{ content: "l1\nn1\nn2\nl2\nl3\nl4\nl5\nl6\n", hunks: INSERT_AFTER_1 }]);
  const f = [found(w.proj, [3])];
  assert.deepEqual(await settleFindings(f, w.file, rec, d0, d0), f);
});

test("settleFindings: the line is carried through several later edits", async () => {
  const w = world();
  const second = [{ oldStart: 4, oldLines: 3, newStart: 4, newLines: 3, lines: [" l2", "-l3", "+L3", " l4"] }]; // l3 now sits on line 5
  const { rec, d0 } = await lay(w, [
    { content: "l1\nn1\nn2\nl2\nl3\nl4\nl5\nl6\n", hunks: INSERT_AFTER_1 },
    { content: "l1\nn1\nn2\nl2\nL3\nl4\nl5\nl6\n", hunks: second },
  ]);
  assert.deepEqual(await settleFindings([found(w.proj, [3])], w.file, rec, d0, d0), []);
});

test("settleFindings: a later whole-file edit drops the own-file diagnostics, foreign and unlocated ones stay", async () => {
  const w = world();
  const extra = ["/other/b.ts:1:1 error elsewhere-marker", "plain summary without a location"];
  const { rec, d0 } = await lay(w, [{ content: "rewritten\n", hunks: null }]);
  const out = await settleFindings([found(w.proj, [3], extra)], w.file, rec, d0, d0);
  assert.equal(out.length, 1);
  assert.doesNotMatch(out[0].text, /m3-marker/);
  assert.match(out[0].text, /elsewhere-marker/);
  assert.match(out[0].text, /plain summary/);
});

test("settleFindings: a partial later edit leaves foreign diagnostics alone too", async () => {
  const w = world();
  const extra = ["/other/b.ts:1:1 error elsewhere-marker"];
  const { rec, d0 } = await lay(w, [{ content: SIX.replace("l3", "L3"), hunks: REPLACE_3 }]);
  const out = await settleFindings([found(w.proj, [3], extra)], w.file, rec, d0, d0);
  assert.equal(out.length, 1);
  assert.match(out[0].text, /elsewhere-marker/);
  assert.doesNotMatch(out[0].text, /m3-marker/);
});

test("settleFindings: a parse error on a rewritten line does not survive", async () => {
  const w = world();
  const { rec, d0 } = await lay(w, [{ content: SIX.replace("l3", "L3"), hunks: REPLACE_3 }]);
  const parse = { tool: "shellcheck", target: "a.sh", base: w.proj, text: "a.sh:3:1: error: Couldn't parse this. [SC1073]" };
  assert.deepEqual(await settleFindings([parse], w.file, rec, d0, d0), []);
});

test("settleFindings: records the linter's state already contains are not applied (digest anchor)", async () => {
  const w = world();
  const edits = [
    { content: SIX.replace("l3", "L3"), hunks: REPLACE_3 },
    { content: SIX.replace("l3", "L3").replace("l6", "L6"), hunks: REPLACE_6 },
  ];
  const { rec, after } = await lay(w, edits);
  const f = [found(w.proj, [3])];
  // the linter read the state after the first later edit: only the second one counts, and it left line 3 alone
  assert.deepEqual(await settleFindings(f, w.file, rec, after[0], after[0]), f);
  // a state no record produced: nothing can be said, report
  assert.deepEqual(await settleFindings(f, w.file, rec, digestOf("unknown"), digestOf("unknown")), f);
});

test("settleFindings: a later Edit cut from content no record holds (unjournaled change in between) means report", async () => {
  const w = world();
  const { rec, d0 } = await lay(w, []);
  await sleep(3);
  writeFileSync(w.file, SIX.replace("l3", "L3"));
  assert.ok(recordEdit(w.file, w.real, editHunks(edit(REPLACE_3)), digestOf("shifted by sed -i")));
  const f = [found(w.proj, [3])];
  assert.equal(await settleFindings(f, w.file, rec, d0, d0), f);
  // the same Edit cut from the anchored content drops the finding
  const v = world();
  const chained = await lay(v, [{ content: SIX.replace("l3", "L3"), hunks: REPLACE_3 }]);
  assert.deepEqual(await settleFindings([found(v.proj, [3])], v.file, chained.rec, chained.d0, chained.d0), []);
});

test("settleFindings: an unreadable journal, a corrupt or an unreadable record means report", async () => {
  const w = world();
  const { rec, d0 } = await lay(w, [{ content: SIX.replace("l3", "L3"), hunks: REPLACE_3 }]);
  const f = [found(w.proj, [3])];
  const corrupt = path.join(w.journal, `${rec.key}-${"9".repeat(15)}-1.json`);
  writeFileSync(corrupt, "{");
  assert.equal(await settleFindings(f, w.file, rec, d0, d0), f);
  rmSync(corrupt);
  mkdirSync(corrupt); // a directory where a record should be: reading it throws
  assert.equal(await settleFindings(f, w.file, rec, d0, d0), f);
  rmSync(w.journal, { recursive: true });
  assert.equal(await settleFindings(f, w.file, rec, d0, d0), f);
});

test("settleFindings: a record with malformed hunks means report, never a lost finding", async () => {
  const w = world();
  const { rec, d0 } = await lay(w, []);
  writeFileSync(path.join(w.journal, `${rec.key}-${"9".repeat(15)}-2.json`), JSON.stringify({ hunks: [null], digest: "x" }));
  const f = [found(w.proj, [3])];
  assert.equal(await settleFindings(f, w.file, rec, d0, d0), f);
});

test("settleFindings: holds for the settle window when there is something to hold", async () => {
  const w = world();
  const { rec, d0 } = await lay(w, [{ content: SIX.replace("l6", "L6"), hunks: REPLACE_6 }]);
  process.env.UNIVERSAL_LINT_SETTLE_MS = "400";
  const t0 = Date.now();
  await settleFindings([found(w.proj, [3])], w.file, rec, d0, d0);
  assert.ok(Date.now() - t0 >= 380, "held");
});

test("settleFindings: findings the filter cannot drop (foreign file, unlocated) are not held; own-line and parse errors are", async () => {
  const w = world();
  const { rec, d0 } = await lay(w, [{ content: SIX.replace("l6", "L6"), hunks: REPLACE_6 }]);
  process.env.UNIVERSAL_LINT_SETTLE_MS = "400";
  const foreign = { tool: "tsc", target: "a.sh", base: w.proj, text: "/other/b.ts:1:1 error elsewhere-marker" };
  const unlocated = { tool: "tsc", target: "a.sh", base: w.proj, text: "plain summary without a location" };
  const t0 = Date.now();
  assert.deepEqual(await settleFindings([foreign, unlocated], w.file, rec, d0, d0), [foreign, unlocated]);
  assert.ok(Date.now() - t0 < 200, "no hold");
  const parse = { tool: "shellcheck", target: "a.sh", base: w.proj, text: "a.sh:3:1: error: Couldn't parse this. [SC1073]" };
  for (const f of [[found(w.proj, [3])], [parse], [found(w.proj, [3], ["/other/b.ts:1:1 error x"])]]) {
    const t1 = Date.now();
    await settleFindings(f, w.file, rec, d0, d0);
    assert.ok(Date.now() - t1 >= 380, "held");
  }
});
