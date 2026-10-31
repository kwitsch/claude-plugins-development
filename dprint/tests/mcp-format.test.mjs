// Unit tests for the pure helpers of the built plugin/mcp/format.mjs (no dprint, no spawn).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyEdit,
  formatPre,
  lineDiff,
  trimToEdit,
} from "../plugin/mcp/format.mjs";
import { applyTextEdits } from "../plugin/mcp/lsp.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const h = (aStart, aEnd, bStart, bEnd) => ({ aStart, aEnd, bStart, bEnd });

/** trimToEdit + the invariants every non-null result must satisfy. allKept: every diff hunk is expected to be kept. */
function trim(O, F, editLines, allKept) {
  const r = trimToEdit(O, F, editLines);
  if (r) {
    assert.notEqual(r.oldString, "");
    assert.notEqual(O.indexOf(r.oldString), -1);
    assert.equal(O.indexOf(r.oldString), O.lastIndexOf(r.oldString));
    // function replacer: a "$" in newString must not be read as a replacement pattern
    if (allKept)
      assert.equal(
        O.replace(r.oldString, () => r.newString),
        F,
      );
  }
  return r;
}

test("lineDiff: identical, insert, delete, replace", () => {
  assert.deepEqual(lineDiff(["a", "b"], ["a", "b"]), []);
  assert.deepEqual(lineDiff(["a", "c"], ["a", "b", "c"]), [h(1, 1, 1, 2)]);
  assert.deepEqual(lineDiff(["a", "b", "c"], ["a", "c"]), [h(1, 2, 1, 1)]);
  assert.deepEqual(lineDiff(["a", "b", "c"], ["a", "x", "c"]), [h(1, 2, 1, 2)]);
});

test("lineDiff: several ordered hunks around common lines", () => {
  assert.deepEqual(
    lineDiff(["a", "b", "c", "d", "e"], ["a", "B", "c", "d", "E"]),
    [h(1, 2, 1, 2), h(4, 5, 4, 5)],
  );
});

test("lineDiff: above the size guard throws (formatPre fails open)", () => {
  const many = (x) => Array.from({ length: 5001 }, () => x);
  assert.throws(
    () => lineDiff(["p", ...many("a"), "s"], ["p", ...many("b"), "s"]),
    /too large/,
  );
});

test("trimToEdit: keeps the edit hunk and an adjacent blank-line hunk, drops a hunk 20 lines away", () => {
  const L = Array.from({ length: 30 }, (_, i) => `l${i}`);
  const Oa = [...L];
  Oa[5] = "l5  ";
  Oa[26] = "l26 ";
  const Fa = [...L];
  Fa.splice(7, 0, "");
  const O = Oa.join("\n") + "\n";
  const F = Fa.join("\n") + "\n";
  const r = trim(O, F, [[5, 6]], false);
  assert.deepEqual(r, { oldString: "l5  \nl6\n", newString: "l5\nl6\n\n" });
  assert.ok(O.replace(r.oldString, () => r.newString).includes("l26 \n"));
});

test("trimToEdit: replace_all with two occurrences -> span covers both", () => {
  assert.deepEqual(
    trim(
      "a(1)\nmid\na(1)\nend\n",
      "a(2)\nmid\na(2)\nend\n",
      [
        [0, 0],
        [2, 2],
      ],
      true,
    ),
    {
      oldString: "a(1)\nmid\na(1)\n",
      newString: "a(2)\nmid\na(2)\n",
    },
  );
});

test("trimToEdit: formatted === original -> null", () => {
  assert.equal(trimToEdit("x\ny\n", "x\ny\n", [[0, 0]]), null);
});

test("trimToEdit: CRLF and missing trailing newline are preserved byte-exactly", () => {
  assert.deepEqual(trim("a\r\nb  \r\nc", "a\r\nb\r\nc", [[1, 1]], true), {
    oldString: "b  \r\n",
    newString: "b\r\n",
  });
  assert.deepEqual(trim("a\r\nb  ", "a\r\nb", [[1, 1]], true), {
    oldString: "b  ",
    newString: "b",
  });
});

test("trimToEdit: deleting a whitespace-only last line without trailing newline also drops the separator before it", () => {
  assert.deepEqual(trim("a\n\n   ", "a\n", [[2, 2]], true), {
    oldString: "\n   ",
    newString: "",
  });
});

test("trimToEdit (a): edited line unchanged + inserted blank line -> widened to the edited line", () => {
  assert.deepEqual(trim("a\n}\nb\n}\n", "a\n\n}\nb\n}\n", [[0, 0]], true), {
    oldString: "a\n",
    newString: "a\n\n",
  });
});

test("trimToEdit (b): insertion-only hunk at EOF", () => {
  assert.deepEqual(trim("x\n", "x\ny\n", [[0, 0]], true), {
    oldString: "x\n",
    newString: "x\ny\n",
  });
});

test("trimToEdit (c): deletion-only hunk -> empty newString", () => {
  const r = trim("keep\nL1\nL2\nend\n", "keep\nend\n", [[1, 2]], true);
  assert.deepEqual(r, { oldString: "L1\nL2\n", newString: "" });
});

test("trimToEdit (d): edited lone } line is widened with the preceding line", () => {
  assert.deepEqual(trim("a\n}\nb\n}\n", "a\n}\nb\n};\n", [[2, 3]], true), {
    oldString: "b\n}\n",
    newString: "b\n};\n",
  });
});

test("trimToEdit (e): insertion hemmed in by a non-kept hunk and EOF without unique context -> null", () => {
  assert.equal(
    trimToEdit("}\n}\nw \n}\n}\n", "}\n}\nw\n}\n}\ny\n", [[4, 4]]),
    null,
  );
});

test("applyEdit: null cases, old === new, replaceAll", () => {
  assert.equal(applyEdit("abc", "", "x", false), null);
  assert.equal(applyEdit("abc", "z", "x", false), null);
  assert.equal(applyEdit("aXa", "a", "b", false), null);
  assert.equal(applyEdit("abc", "b", "b", false), "abc");
  assert.equal(applyEdit("abc", "b", "B", false), "aBc");
  assert.equal(applyEdit("aXa", "a", "b", true), "bXb");
  assert.equal(applyEdit("abc", "z", "x", true), null);
});

test("applyTextEdits: several edits applied back to front regardless of array order", () => {
  const edits = [
    {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
      newText: "X",
    },
    {
      range: {
        start: { line: 2, character: 1 },
        end: { line: 2, character: 2 },
      },
      newText: "YY",
    },
  ];
  assert.equal(applyTextEdits("abc\ndef\nghi", edits), "Xbc\ndef\ngYYi");
});

test("applyTextEdits: multi-line replacement", () => {
  const edits = [
    {
      range: {
        start: { line: 0, character: 1 },
        end: { line: 2, character: 0 },
      },
      newText: " B\n",
    },
  ];
  assert.equal(applyTextEdits("a\nb\nc\n", edits), "a B\nc\n");
});

test("applyTextEdits: end past the last line / line length is clamped (whole-document edit)", () => {
  const whole = [
    {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 99, character: 0 },
      },
      newText: "x\n",
    },
  ];
  assert.equal(applyTextEdits("x  \n\n", whole), "x\n");
  const pastLineEnd = [
    {
      range: {
        start: { line: 0, character: 1 },
        end: { line: 0, character: 50 },
      },
      newText: "",
    },
  ];
  assert.equal(applyTextEdits("ab\ncd", pastLineEnd), "a\ncd");
});

test("formatPre guards fail open with {} before touching dprint", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dprint-fmt-"));
  const file = path.join(dir, "a.ts");
  writeFileSync(file, "const a = 1;\n");
  assert.deepEqual(await formatPre({ tool_name: "Write", tool_input: {} }), {});
  assert.deepEqual(
    await formatPre({
      tool_name: "Write",
      tool_input: { file_path: "rel.ts", content: "x" },
    }),
    {},
  );
  assert.deepEqual(
    await formatPre({
      cwd: dir,
      tool_name: "Read",
      tool_input: { file_path: file },
    }),
    {},
  );
  assert.deepEqual(
    await formatPre({
      cwd: dir,
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(dir, "missing.ts"),
        old_string: "a",
        new_string: "b",
      },
    }),
    {},
  );
  assert.deepEqual(
    await formatPre({
      cwd: dir,
      tool_name: "Edit",
      tool_input: {
        file_path: file,
        old_string: "zzz",
        new_string: "b",
        replace_all: "false",
      },
    }),
    {},
  );
  assert.deepEqual(await formatPre(undefined), {});
});

test("applyTextEdits: a position past the end of a CRLF line clamps before the \\r", () => {
  assert.equal(
    applyTextEdits("a  \r\nb\r\n", [
      {
        range: {
          start: { line: 0, character: 1 },
          end: { line: 0, character: 99 },
        },
        newText: "",
      },
    ]),
    "a\r\nb\r\n",
  );
});
