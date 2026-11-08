// Guard clauses and basic per-linter smoke tests (shellcheck/eslint/ruff/ktlint); ported from test/universal-lint/core.bats.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { hashPath } from "../plugin/hooks/lint-file.mjs";
import { HOOK, type LintEnv, makeEnv, payload } from "./support/lint-hook.mts";

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

test("PostToolUse records the on-disk content digest under CLAUDE_PLUGIN_DATA/written", () => {
  const e = makeEnv();
  const f = e.file("a.sh", "echo hi\n");
  assert.equal(e.run(f).status, 0);
  const digestFile = path.join(e.data, "written", hashPath(realpathSync(f)));
  assert.equal(readFileSync(digestFile, "utf8"), createHash("sha256").update(readFileSync(f)).digest("base64"));
});

/** 512 KiB of ASCII padding for the F05 payloads: far above the pipe buffer (about 128-192 KB), so the wire payload is always larger than a pipe holds. */
const PAD = "x".repeat(512 * 1024);

/**
 * Spawn the built hook with a stdin pipe and write `input` only 100 ms later (a late writer, F05).
 *
 * @param env - Child environment (`makeEnv().childEnv()`).
 * @param input - The payload JSON.
 * @returns The exit status once the hook has closed.
 */
function runLate(env: Record<string, string>, input: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { env, stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("close", resolve);
    child.stdin.on("error", () => {}); // EPIPE when a broken hook exits before the write: let the assertions report it
    setTimeout(() => child.stdin.end(input), 100);
  });
}

// Edit payloads carry the whole `tool_response.originalFile`, Write payloads the whole `tool_input.content`.
test.each([["Edit", "tool_response", "originalFile"], ["Write", "tool_input", "content"]])("PostToolUse %s: a 512 KB payload written 100 ms late is linted and records its digest (F05)", async (toolName, holder, key) => {
  const e = makeEnv();
  e.recStub("shellcheck", 0);
  const f = e.file("a.sh", "echo hi\n");
  const p = JSON.parse(payload(f, e.cwd, { toolName })) as Record<string, Record<string, unknown>>;
  p[holder][key] = PAD;
  assert.equal(await runLate(e.childEnv(), JSON.stringify(p)), 0);
  assert.ok(e.lines().some((l) => l.startsWith("shellcheck ")));
  assert.ok(existsSync(path.join(e.data, "written", hashPath(realpathSync(f)))));
});

test("PostToolUse with success false records no digest", () => {
  const e = makeEnv();
  const f = e.file("a.sh", "echo hi\n");
  e.run(f, { toolResponse: { success: false } });
  assert.equal(existsSync(path.join(e.data, "written")), false);
});

/** shellcheck output that makes a recording stub's exit 1 a finding. */
const SC_OUT = "a.sh:1:6: note: Double quote to prevent globbing. [SC2086]";

/** Shape of the onPath probe store file (F11). */
type ProbeFile = { hits: Record<string, string>; misses: Record<string, number> };

/**
 * Probe file of an env for a PATH string (default: the env's own PATH, its bin dir).
 *
 * @param e - The environment.
 * @param PATH - PATH string the hook ran with.
 * @returns Absolute path of `probe-<hashPath(PATH)>.json` under the env's data dir.
 */
const probeFile = (e: LintEnv, PATH = e.bin): string => path.join(e.data, `probe-${hashPath(PATH)}.json`);

/**
 * Read and parse a probe file.
 *
 * @param f - Probe file path.
 * @returns The parsed store.
 */
const readProbe = (f: string): ProbeFile => JSON.parse(readFileSync(f, "utf8")) as ProbeFile;

/**
 * Write a probe file by hand (creates the data dir, which makeEnv does not).
 *
 * @param e - The environment.
 * @param store - Store to write.
 */
function writeProbe(e: LintEnv, store: ProbeFile): void {
  mkdirSync(e.data, { recursive: true });
  writeFileSync(probeFile(e), JSON.stringify(store));
}

test("probe file: a persisted miss is served without a PATH scan, then expires after PROBE_MISS_TTL_MS", () => {
  const e = makeEnv();
  const f = e.file("a.sh", "echo $1\n");
  assert.deepEqual(e.run(f, { out: SC_OUT }).result, {});
  const first = readProbe(probeFile(e));
  assert.equal(typeof first.misses.shellcheck, "number");
  e.recStub("shellcheck", 1);
  assert.deepEqual(e.run(f, { out: SC_OUT }).result, {}); // persisted miss answered: the new stub is not seen
  assert.deepEqual(e.lines(), []);
  const expired = readProbe(probeFile(e));
  expired.misses.shellcheck = Date.now() - 11 * 60 * 1000;
  writeFileSync(probeFile(e), JSON.stringify(expired));
  assert.equal(e.run(f, { out: SC_OUT }).status, 2);
  assert.ok(e.lines().some((l) => l.startsWith("shellcheck ")));

  const future = makeEnv();
  writeProbe(future, { hits: {}, misses: { shellcheck: Date.now() + 60_000 } });
  future.recStub("shellcheck", 1);
  assert.equal(future.run(future.file("a.sh", "echo $1\n"), { out: SC_OUT }).status, 2); // future-dated miss = expired
});

test("probe file: a persisted hit is re-validated and replaced by a miss once the tool is gone", () => {
  const e = makeEnv();
  const f = e.file("a.sh", "echo $1\n");
  e.recStub("shellcheck", 1);
  assert.equal(e.run(f, { out: SC_OUT }).status, 2);
  assert.equal(readProbe(probeFile(e)).hits.shellcheck, e.bin);
  rmSync(path.join(e.bin, "shellcheck"));
  assert.deepEqual(e.run(f, { out: SC_OUT }).result, {});
  const after = readProbe(probeFile(e));
  assert.equal("shellcheck" in after.hits, false);
  assert.equal(typeof after.misses.shellcheck, "number");
});

test("probe file: a PATH change uses another probe file", () => {
  const e = makeEnv();
  const f = e.file("a.sh", "echo $1\n");
  assert.deepEqual(e.run(f, { out: SC_OUT }).result, {});
  assert.equal(typeof readProbe(probeFile(e)).misses.shellcheck, "number");
  const extra = path.join(e.data, "..", "extra-bin");
  mkdirSync(extra, { recursive: true });
  const stub = path.join(extra, "shellcheck");
  writeFileSync(stub, ["#!/usr/bin/env bash", `printf "%s %s\\n" "shellcheck" "$*" >> "$RECORD"`, "printf '%s\\n' \"$OUT\"", "exit 1", ""].join("\n"));
  chmodSync(stub, 0o755);
  const PATH = [e.bin, extra].join(path.delimiter);
  assert.equal(e.run(f, { out: SC_OUT, env: { PATH } }).status, 2);
  assert.ok(existsSync(probeFile(e)));
  assert.equal(readProbe(probeFile(e, PATH)).hits.shellcheck, extra);
});

test("probe file: a corrupt store or an unusable data dir fails open", () => {
  const e = makeEnv();
  mkdirSync(e.data, { recursive: true });
  writeFileSync(probeFile(e), "{not json");
  e.recStub("shellcheck", 1);
  assert.equal(e.run(e.file("a.sh", "echo $1\n"), { out: SC_OUT }).status, 2);
  assert.equal(readProbe(probeFile(e)).hits.shellcheck, e.bin);

  const file = makeEnv();
  writeFileSync(file.data, ""); // CLAUDE_PLUGIN_DATA is a regular file: nothing can be persisted
  file.recStub("shellcheck", 1);
  assert.equal(file.run(file.file("a.sh", "echo $1\n"), { out: SC_OUT }).status, 2);
});
