// Settle window (F34): findings are held for a few seconds and dropped when a later edit rewrote the line they sit on.
import assert from "node:assert/strict";
import { test } from "vitest";
import { carryLine, editHunks, gateFinding, settleWaitMs } from "../plugin/hooks/lint-file.mjs";

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
