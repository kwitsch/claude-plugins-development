// Guard clauses and basic per-linter smoke tests (shellcheck/eslint/ruff/ktlint); ported from test/universal-lint/core.bats.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { hashPath } from "../src/hooks/lint-core.ts";
import { makeEnv, payload } from "./support/lint-hook.ts";

/** A 4-line shell script; the Edit tests below edit line 2. */
const SH4 = "echo a\necho $1\necho b\necho $2\n";
/** Edit tool_response replacing line 2 of SH4. */
const EDIT_L2 = { structuredPatch: [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: [" echo a", "-echo $x", "+echo $1", " echo b", " echo $2"] }] };
/** Edit tool_response deleting a line between lines 1 and 2 of SH4 (pure deletion). */
const DEL_L1 = { structuredPatch: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 4, lines: [" echo a", "-rm x", " echo $1", " echo b", " echo $2"] }] };

test("Edit: only findings on the edited line are reported (exit 2, line-2 text only)", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const r = e.run(e.file("a.sh", SH4), {
    toolName: "Edit",
    toolResponse: EDIT_L2,
    out: "a.sh:2:6: note: line2-marker [SC2086]\na.sh:4:6: note: line4-marker [SC2086]",
  });
  assert.equal(r.status, 2);
  assert.match(r.ctx, /line2-marker/);
  assert.doesNotMatch(r.ctx, /line4-marker/);
});

test("Edit: findings only outside the edited lines -> exit 0, no output", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const r = e.run(e.file("a.sh", SH4), { toolName: "Edit", toolResponse: EDIT_L2, out: "a.sh:4:6: note: line4-marker [SC2086]" });
  assert.equal(r.status, 0);
  assert.equal(r.ctx, "");
});

test("Edit: a pure deletion is linted; the lines around the deletion point count as edited", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const f = e.file("a.sh", SH4);
  assert.equal(e.run(f, { toolName: "Edit", toolResponse: DEL_L1, out: "a.sh:2:6: note: del-marker [SC2086]" }).status, 2);
  assert.equal(e.run(f, { toolName: "Edit", toolResponse: DEL_L1, out: "a.sh:4:6: note: far-marker [SC2086]" }).status, 0);
});

test("Edit: a parse error outside the edited lines is still reported (exit 2)", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const r = e.run(e.file("a.sh", SH4), { toolName: "Edit", toolResponse: EDIT_L2, out: "a.sh:4:1: error: Couldn't parse this. [SC1073]" });
  assert.equal(r.status, 2);
  assert.match(r.ctx, /SC1073/);
});

test("Edit without a structuredPatch: the whole file counts as edited", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  assert.equal(e.run(e.file("a.sh", SH4), { toolName: "Edit", out: "a.sh:4:6: note: x [SC2086]" }).status, 2);
});

test("shellcheck finds an issue: exit 2 (asyncRewake) with the stub's text on stderr", () => {
  const e = makeEnv();
  const f = e.file("a.sh", "echo $1\n");
  e.recStub("shellcheck", 1);
  const r = e.run(f, { out: "a.sh:1:6: note: Double quote to prevent globbing. [SC2086]" });
  assert.equal(r.status, 2);
  assert.match(r.ctx, /^universal-lint: shellcheck found issues/);
  assert.match(r.ctx, /SC2086/);
  assert.ok(e.lines().some((l) => l.startsWith("shellcheck ")));
  assert.equal(readFileSync(f, "utf8"), "echo $1\n"); // linter never modifies the file
});

test("shellcheck clean (exit 0) -> {} even though it printed text", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 0);
  assert.deepEqual(e.run(e.file("a.sh", "echo \"$1\"\n"), { out: "no problems" }).result, {});
});

test("no linter on PATH -> {}", () => {
  const e = makeEnv();
  assert.deepEqual(e.run(e.file("a.sh", "echo $1\n")).result, {});
});

test("non-target extension (.txt) -> linter never invoked", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  assert.deepEqual(e.run(e.file("a.txt", "hi\n"), { out: "issue" }).result, {});
  assert.deepEqual(e.lines(), []);
});

test("path outside cwd -> linter never invoked", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const outside = makeEnv().file("a.sh", "echo $1\n");
  assert.deepEqual(e.run(outside, { out: "issue" }).result, {});
  assert.deepEqual(e.lines(), []);
});

test("node_modules path -> linter never invoked", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  assert.deepEqual(e.run(e.file("node_modules/x/a.sh", "echo $1\n"), { out: "issue" }).result, {});
  assert.deepEqual(e.lines(), []);
});

test(".claude/worktrees path -> linter never invoked", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  assert.deepEqual(e.run(e.file(".claude/worktrees/foo/a.sh", "echo $1\n"), { out: "issue" }).result, {});
  assert.deepEqual(e.lines(), []);
});

test(".claude/agent-memory path -> linter never invoked", () => {
  const e = makeEnv();
  e.recStub("yamllint", 1);
  assert.deepEqual(e.run(e.file(".claude/agent-memory/a.yaml", "a: 1\n"), { out: "issue" }).result, {});
  assert.deepEqual(e.lines(), []);
});

test("*.local.* file -> linter never invoked", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  assert.deepEqual(e.run(e.file("settings.local.sh", "echo $1\n"), { out: "issue" }).result, {});
  assert.deepEqual(e.lines(), []);
});

test(".claude/rules path (not worktrees/agent-memory) -> linter still invoked", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  e.run(e.file(".claude/rules/a.sh", "echo $1\n"), { out: "issue" });
  assert.ok(e.lines().some((l) => l.startsWith("shellcheck ")));
});

test("eslint exit 2 (config/internal error) -> {} even though it printed text (skip, not issues)", () => {
  const e = makeEnv();
  e.file("eslint.config.mjs", "export default [];\n");
  e.recStub("eslint", 2);
  assert.deepEqual(e.run(e.file("a.js", "let x = 1\n"), { out: "Oops! Something went wrong! :(" }).result, {});
});

test("eslint exit 1 -> issues surfaced", () => {
  const e = makeEnv();
  e.file("eslint.config.mjs", "export default [];\n");
  e.recStub("eslint", 1);
  const r = e.run(e.file("a.js", "let x = 1\n"), { out: "a.js: 1:1  error  x is assigned a value but never used  no-unused-vars" });
  assert.match(r.ctx, /no-unused-vars/);
});

test("ruff check: subcommand precedes the file in recorded argv", () => {
  const e = makeEnv();
  e.recStub("ruff", 1);
  e.run(e.file("a.py", "x=1\n"), { out: "a.py:1:1: E225 missing whitespace around operator" });
  assert.ok(e.lines().some((l) => l.includes("ruff check")));
});

test("ktlint clean (exit 0) -> {}; issues (exit 1) -> surfaced", () => {
  const clean = makeEnv();
  clean.recStub("ktlint", 0);
  assert.deepEqual(clean.run(clean.file("a.kt", "fun main(){}\n")).result, {});
  const bad = makeEnv();
  bad.recStub("ktlint", 1);
  const r = bad.run(bad.file("a.kt", "fun main(){}\n"), { out: "a.kt:1:1: Missing newline before \")\" (standard:parameter-list-wrapping)" });
  assert.match(r.ctx, /parameter-list-wrapping/);
});

test("json extension -> linter never invoked (deliberately uncovered)", () => {
  const e = makeEnv();
  e.recStub("eslint", 1);
  assert.deepEqual(e.run(e.file("a.json", "{\"a\":1}"), { out: "issue" }).result, {});
  assert.deepEqual(e.lines(), []);
});

test("PostToolUse records the written content digest under CLAUDE_PLUGIN_DATA/written", () => {
  const e = makeEnv();
  const f = e.file("a.sh", "echo hi\n");
  assert.equal(e.run(f).status, 0);
  const digestFile = path.join(e.data, "written", hashPath(realpathSync(f)));
  assert.equal(readFileSync(digestFile, "utf8"), createHash("sha256").update(readFileSync(f)).digest("base64"));
});

/** 512 KiB of ASCII padding for the F05 payloads: far above the pipe buffer (about 128-192 KB), so the wire payload is always larger than a pipe holds. */
const PAD = "x".repeat(512 * 1024);

// A late stdin writer (the old `runLate`) has no equivalent: the server reads JSON-RPC lines, so the F05 rows send the
// 512 KB payload as one keyed `file_edited` call.
// Edit payloads carry the whole `tool_response.originalFile`, Write payloads the whole `tool_input.content`.
test.each([["Edit", "tool_response", "originalFile"], ["Write", "tool_input", "content"]])("PostToolUse %s: a 512 KB payload sent to the server is linted and records its digest (F05)", async (toolName, holder, key) => {
  const e = makeEnv();
  e.recStub("shellcheck", 0);
  const f = e.file("a.sh", "echo hi\n");
  const p = JSON.parse(payload(f, e.cwd, { toolName })) as Record<string, Record<string, unknown>>;
  p[holder][key] = PAD;
  // the Edit turns the padding into the file's content, so the payload carries what was written
  if (toolName === "Edit") p.tool_response.structuredPatch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`-${PAD}`, "\\ No newline at end of file", "+echo hi"] }];
  const srv = e.server();
  await srv.call("file_edited", { ...p, session_id: "s1", key: await srv.key("s1") });
  assert.ok(e.lines().some((l) => l.startsWith("shellcheck ")));
  assert.equal(readFileSync(path.join(e.data, "written", hashPath(realpathSync(f))), "utf8"), createHash("sha256").update(toolName === "Edit" ? "echo hi\n" : PAD).digest("base64"));
});

test("PostToolUse Edit records the digest of what the Edit wrote, not of a later write already on disk", () => {
  const e = makeEnv();
  const f = e.file("a.sh", "echo A\necho b\necho $d\n"); // the Edit wrote line 1, another writer then line 3
  const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-echo a", "+echo A"] }];
  assert.equal(e.run(f, { toolName: "Edit", toolResponse: { originalFile: "echo a\necho b\necho d\n", structuredPatch: patch } }).status, 0);
  assert.equal(readFileSync(path.join(e.data, "written", hashPath(realpathSync(f))), "utf8"), createHash("sha256").update("echo A\necho b\necho d\n").digest("base64"));
});

test("PostToolUse with success false records no digest", () => {
  const e = makeEnv();
  const f = e.file("a.sh", "echo hi\n");
  e.run(f, { toolResponse: { success: false } });
  assert.equal(existsSync(path.join(e.data, "written")), false);
});

/** shellcheck output that makes a recording stub's exit 1 a finding. */
const SC_OUT = "a.sh:1:6: note: Double quote to prevent globbing. [SC2086]";

test("probe memo: a miss is trusted on the next call of the same server (no PATH scan), a hit is used", async () => {
  const e = makeEnv();
  const f = e.file("a.sh", "echo $1\n");
  const s = e.server({ out: SC_OUT });
  const k = await s.key("s1");
  const lint = () => s.call("file_edited", { cwd: e.cwd, session_id: "s1", key: k, tool_name: "Write", tool_input: { file_path: f, content: "echo $1\n" }, tool_response: {} });
  assert.deepEqual(await lint(), {});
  e.recStub("shellcheck", 1);
  assert.deepEqual(await lint(), {}); // the miss is memoized in the server: the stub added since is not seen
  assert.deepEqual(e.lines(), []);

  const h = makeEnv();
  const g = h.file("a.sh", "echo $1\n");
  h.recStub("shellcheck", 1);
  const hs = h.server({ out: SC_OUT });
  const hk = await hs.key("s1");
  const hlint = () => hs.call("file_edited", { cwd: h.cwd, session_id: "s1", key: hk, tool_name: "Write", tool_input: { file_path: g, content: "echo $1\n" }, tool_response: {} });
  assert.ok("context" in (await hlint()));
  assert.ok("context" in (await hlint()));
  assert.equal(h.lines().filter((l) => l.startsWith("shellcheck ")).length, 2);
});

test("probe memo: a hit is re-validated and replaced by a miss once the tool is gone", async () => {
  const e = makeEnv();
  const f = e.file("a.sh", "echo $1\n");
  e.recStub("shellcheck", 1);
  const s = e.server({ out: SC_OUT });
  const k = await s.key("s1");
  const lint = () => s.call("file_edited", { cwd: e.cwd, session_id: "s1", key: k, tool_name: "Write", tool_input: { file_path: f, content: "echo $1\n" }, tool_response: {} });
  assert.match(String((await lint())["context"]), /SC2086/);
  rmSync(path.join(e.bin, "shellcheck"));
  assert.deepEqual(await lint(), {});
});

test("probe memo: no file is written under CLAUDE_PLUGIN_DATA", async () => {
  const e = makeEnv();
  const f = e.file("a.sh", "echo $1\n");
  e.recStub("shellcheck", 1);
  const s = e.server({ out: SC_OUT });
  const k = await s.key("s1");
  assert.match(String((await s.call("file_edited", { cwd: e.cwd, session_id: "s1", key: k, tool_name: "Write", tool_input: { file_path: f, content: "echo $1\n" }, tool_response: {} }))["context"]), /SC2086/);
  assert.ok(!existsSync(e.data) || readdirSync(e.data).every((n) => !n.startsWith("probe-")));
});

test("PostToolUse: a file inside the payload's scratchpad_dir -> linter never invoked (also a symlink there to an in-cwd file)", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const scratch = path.join(e.cwd, "scratch");
  const inside = e.file("scratch/a.sh", "echo $1\n");
  const target = e.file("b.sh", "echo $1\n");
  const link = path.join(scratch, "link.sh");
  symlinkSync(target, link);
  for (const file of [inside, link]) {
    const r = e.runEvent({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: file, content: "echo $1\n" }, tool_response: { success: true }, cwd: e.cwd, scratchpad_dir: scratch }, { out: "issue" });
    assert.deepEqual(r.result, {}, file);
  }
  assert.deepEqual(e.lines(), []);
});
