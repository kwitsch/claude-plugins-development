// Unit tests for the pure helpers of the built plugin/mcp/format.mjs (no dprint, no spawn).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { applyEdit, bashFinished, bashStarted, disposeLsp, fileChanged, formatPre, inScope, lineDiff, scopeOf, trimToEdit } from "../plugin/mcp/format.mjs";
import { applyTextEdits } from "../plugin/mcp/lsp.mjs";

const h = (aStart, aEnd, bStart, bEnd) => ({ aStart, aEnd, bStart, bEnd });

/** trimToEdit + the invariants every non-null result must satisfy. allKept: every diff hunk is expected to be kept. */
function trim(O, F, editLines, allKept) {
  const r = trimToEdit(O, F, editLines);
  if (r) {
    assert.notEqual(r.oldString, "");
    assert.notEqual(O.indexOf(r.oldString), -1);
    assert.equal(O.indexOf(r.oldString), O.lastIndexOf(r.oldString));
    // function replacer: a "$" in newString must not be read as a replacement pattern
    if (allKept) {
      assert.equal(
        O.replace(r.oldString, () => r.newString),
        F,
      );
    }
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

test("applyTextEdits: inserts at the same position land in array order", () => {
  const at = { line: 0, character: 1 };
  const ins = (newText) => ({ range: { start: at, end: at }, newText });
  assert.equal(applyTextEdits("ab", [ins("X"), ins("Y")]), "aXYb");
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
  const loneCr = path.join(dir, "lone-cr.ts");
  writeFileSync(loneCr, "const a = 1;\rconst b = 2;\n");
  assert.deepEqual(
    await formatPre({
      cwd: dir,
      tool_name: "Edit",
      tool_input: { file_path: loneCr, old_string: "1", new_string: "2  " },
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

// Needs a real dprint on PATH with its json plugin in the cache or reachable (CI has neither): skipped there, run locally.
const realDprint = spawnSync("dprint", ["--version"], { encoding: "utf8" }).status === 0;

test.skipIf(!realDprint)("format_pre: more concurrent roots than the client cap all format (a busy client is not evicted)", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "dprint-evict-"));
  const roots: string[] = [];
  for (let i = 0; i < 9; i++) {
    const r = path.join(tmp, `r${i}`);
    mkdirSync(path.join(r, ".git"), { recursive: true });
    writeFileSync(path.join(r, "dprint.json"), JSON.stringify({ json: {}, plugins: ["npm:@dprint/json@0.25.2"] }));
    roots.push(r);
  }
  try {
    const res = await Promise.all(roots.map((r, i) => formatPre({ cwd: r, agent_id: "", session_id: "ev" + i, scratchpad_dir: "", tool_name: "Write", tool_input: { file_path: path.join(r, "x.json"), content: "{\n\"a\": 1\n}\n" } })));
    res.forEach((x, i) => assert.ok("hookSpecificOutput" in x, `root ${i} was formatted`));
  } finally {
    disposeLsp();
    rmSync(tmp, { recursive: true, force: true });
  }
}, 60_000);

test("trimToEdit: a highly repetitive file jumps to the widest span after the step cap instead of blocking", () => {
  // 10 identical 2000-line blocks: no span under ~18000 lines is unique
  const block = Array.from({ length: 2000 }, (_, i) => `l${i}\n`).join("");
  const O = block.repeat(10);
  const L = O.split("\n");
  L[11_000] = "changed";
  const F = L.join("\n");
  const t0 = Date.now();
  assert.deepEqual(trimToEdit(O, F, [[11_000, 11_000]]), { oldString: O, newString: F });
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
});

test("watch list: an empty read (dprint missing) is retried after 5 minutes, not before", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "dprint-retry-"));
  const bin = path.join(tmp, "bin");
  const repo = path.join(tmp, "repo");
  mkdirSync(bin);
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  writeFileSync(path.join(repo, "dprint.json"), "{}");
  for (const t of ["bash", "node"]) {
    const src = spawnSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
    if (src) symlinkSync(src, path.join(bin, t));
  }
  const log = path.join(tmp, "listed.log");
  const oldPath = process.env.PATH;
  const oldHome = process.env.HOME;
  const oldInstall = process.env.DPRINT_INSTALL;
  process.env.PATH = bin;
  process.env.HOME = tmp;
  delete process.env.DPRINT_INSTALL; // the installer's directory is looked at before npx
  vi.useFakeTimers({ toFake: ["Date"] }); // only the clock: the spawned processes keep real timers
  const args = { cwd: repo, agent_id: "", session_id: "retry", scratchpad_dir: "" };
  const cycle = async (id: string) => {
    bashStarted({ ...args, tool_use_id: id });
    await bashFinished({ ...args, tool_use_id: id });
  };
  const listings = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0);
  try {
    await cycle("a"); // no dprint anywhere: the list is empty
    assert.equal(listings(), 0);
    writeFileSync(path.join(bin, "dprint"), `#!/usr/bin/env bash\necho listed >> "${log}"\n`);
    chmodSync(path.join(bin, "dprint"), 0o755);
    vi.setSystemTime(Date.now() + 4 * 60_000);
    await cycle("b");
    assert.equal(listings(), 0, "within 5 minutes the empty list is kept");
    vi.setSystemTime(Date.now() + 2 * 60_000);
    await cycle("c");
    assert.equal(listings(), 1, "after 5 minutes the list is read again and the installed dprint is found");
  } finally {
    vi.useRealTimers();
    process.env.PATH = oldPath;
    process.env.HOME = oldHome;
    if (oldInstall !== undefined) process.env.DPRINT_INSTALL = oldInstall;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("format_pre Edit: a file that grows over the cap while git check-ignore runs is skipped, not read", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "dprint-edit-cap-"));
  const bin = path.join(tmp, "bin");
  const repo = path.join(tmp, "repo");
  mkdirSync(bin);
  mkdirSync(repo);
  spawnSync("/usr/bin/git", ["init", "-q", repo]);
  writeFileSync(path.join(repo, "dprint.json"), "{}");
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  // the fake git sleeps 2 s on check-ignore, so the Edit is still waiting for git when the file grows
  writeFileSync(path.join(bin, "git"), `#!/bin/sh\ncase "$*" in *check-ignore*) sleep 2;; esac\nexec "${realGit}" "$@"\n`);
  chmodSync(path.join(bin, "git"), 0o755);
  for (const t of ["bash", "sleep"]) symlinkSync(spawnSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim(), path.join(bin, t));
  const file = path.join(repo, "e.json");
  writeFileSync(file, "{\"a\":   1}\n");
  const oldPath = process.env.PATH;
  const oldHome = process.env.HOME;
  process.env.PATH = bin;
  process.env.HOME = tmp;
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const call = formatPre({
      cwd: repo,
      agent_id: "",
      session_id: "editcap",
      scratchpad_dir: "",
      tool_name: "Edit",
      tool_input: { file_path: file, old_string: "1", new_string: "2" },
    });
    await new Promise((r) => setTimeout(r, 300)); // git check-ignore is still running
    writeFileSync(file, "{\"x\":[" + Array.from({ length: 150_000 }, (_, i) => `${i}  `).join(",") + "]}\n");
    assert.deepEqual(await call, {});
    const logged = stderr.mock.calls.map((c) => String(c[0])).join("");
    assert.match(logged, /format skipped \(over 1048576 bytes\): .*e\.json/, "the cap is checked again before the read");
    assert.doesNotMatch(logged, /format_pre failed open/, "the 2 MiB file never reaches the formatter");
  } finally {
    stderr.mockRestore();
    disposeLsp();
    process.env.PATH = oldPath;
    process.env.HOME = oldHome;
    rmSync(tmp, { recursive: true, force: true });
  }
}, 30_000);

test("file_changed: a file that grows over the cap while it waits for a slot is skipped, not read", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "dprint-cap-"));
  const bin = path.join(tmp, "bin");
  const repo = path.join(tmp, "repo");
  mkdirSync(bin);
  mkdirSync(repo);
  spawnSync("/usr/bin/git", ["init", "-q", repo]);
  writeFileSync(path.join(repo, "dprint.json"), "{}");
  // the fake git sleeps 2 s, so the ninth event waits for one of the eight slots
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(path.join(bin, "git"), `#!/bin/sh\ncase "$*" in *status*|*check-ignore*) sleep 2;; esac\nexec "${realGit}" "$@"\n`);
  chmodSync(path.join(bin, "git"), 0o755);
  for (const t of ["bash", "sleep"]) symlinkSync(spawnSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim(), path.join(bin, t));
  for (let i = 1; i <= 9; i++) writeFileSync(path.join(repo, `f${i}.json`), "{\"a\":   1}\n");
  const oldPath = process.env.PATH;
  const oldHome = process.env.HOME;
  process.env.PATH = bin;
  process.env.HOME = tmp;
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const args = (i: number) => ({
    cwd: repo,
    agent_id: "",
    session_id: "cap",
    scratchpad_dir: "",
    file_path: path.join(repo, `f${i}.json`),
    event: "change",
  });
  try {
    const calls: Promise<unknown>[] = [];
    for (let i = 1; i <= 9; i++) calls.push(fileChanged(args(i)));
    await new Promise((r) => setTimeout(r, 300)); // the ninth event is now waiting for a slot
    writeFileSync(path.join(repo, "f9.json"), "{\"x\":[" + Array.from({ length: 150_000 }, (_, i) => `${i}  `).join(",") + "]}\n");
    await Promise.all(calls);
    const logged = stderr.mock.calls.map((c) => String(c[0])).join("");
    assert.match(logged, /format skipped \(over 1048576 bytes\): .*f9\.json/, "the cap is checked again after the slot wait");
  } finally {
    stderr.mockRestore();
    disposeLsp();
    process.env.PATH = oldPath;
    process.env.HOME = oldHome;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("inScope: a lexical scratchpad hit is out of scope before any real-path call; a sibling prefix and an empty scratchpad_dir are not", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "dprint-scratch-"));
  try {
    mkdirSync(path.join(repo, "scratch"));
    mkdirSync(path.join(repo, "scratch-x"));
    writeFileSync(path.join(repo, "a.json"), "{}\n");
    // real path a.json lies outside the scratchpad: only the lexical test rejects this spelling
    symlinkSync(path.join(repo, "a.json"), path.join(repo, "scratch", "link.json"));
    const sc = scopeOf({ cwd: repo, scratchpad_dir: path.join(repo, "scratch") });
    assert.ok(sc);
    assert.equal(inScope(sc, path.join(repo, "scratch", "x.json")), null);
    assert.equal(inScope(sc, "scratch/x.json"), null);
    assert.equal(inScope(sc, path.join(repo, "scratch")), null);
    assert.equal(inScope(sc, path.join(repo, "scratch", "link.json")), null);
    assert.equal(inScope(sc, path.join(repo, "scratch-x", "x.json"))?.fp, path.join(repo, "scratch-x", "x.json"));
    const none = scopeOf({ cwd: repo, scratchpad_dir: "" });
    assert.ok(none);
    assert.equal(inScope(none, path.join(repo, "scratch", "x.json"))?.fp, path.join(repo, "scratch", "x.json"));
    assert.equal(inScope(none, path.join(repo, "scratch", "link.json"))?.fp, path.join(repo, "scratch", "link.json"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test.skipIf(!realDprint)("format_pre: a file inside scratchpad_dir is skipped; a sibling-prefix dir and an empty scratchpad_dir are formatted", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "dprint-scratch-fmt-"));
  mkdirSync(path.join(repo, ".git"));
  mkdirSync(path.join(repo, "scratch"));
  mkdirSync(path.join(repo, "scratch-x"));
  writeFileSync(path.join(repo, "dprint.json"), JSON.stringify({ json: {}, plugins: ["npm:@dprint/json@0.25.2"] }));
  const call = (file: string, scratchpad_dir: string) => formatPre({ cwd: repo, agent_id: "", session_id: "scratch-fmt", scratchpad_dir, tool_name: "Write", tool_input: { file_path: file, content: "{\n\"a\": 1\n}\n" } });
  try {
    assert.deepEqual(await call(path.join(repo, "scratch", "x.json"), path.join(repo, "scratch")), {});
    assert.ok("hookSpecificOutput" in (await call(path.join(repo, "scratch-x", "x.json"), path.join(repo, "scratch"))), "sibling prefix dir is formatted");
    assert.ok("hookSpecificOutput" in (await call(path.join(repo, "scratch", "x.json"), "")), "empty scratchpad_dir excludes nothing");
  } finally {
    disposeLsp();
    rmSync(repo, { recursive: true, force: true });
  }
}, 60_000);
