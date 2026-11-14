// File detection: SessionStart/CwdChanged watch list and FileChanged linting, against the built hook in a real git repo.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { FILE_CHANGED_SLOTS } from "../plugin/hooks/lint-file.mjs";
import { HOOK, makeEnv } from "./support/lint-hook.mts";
import type { LintEnv } from "./support/lint-hook.mts";

/**
 * Run the hermetic env's git in `dir`.
 *
 * @param e - Test environment (its `bin/git` and `childEnv`).
 * @param dir - Working directory.
 * @param args - git arguments.
 * @returns git's stdout.
 */
function git(e: LintEnv, dir: string, ...args: string[]): string {
  const r = spawnSync(path.join(e.bin, "git"), args, { cwd: dir, env: e.childEnv(), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

/**
 * git init `dir` and commit everything present that is not gitignored.
 *
 * @param e - Test environment.
 * @param dir - Repository root; default the env's cwd.
 */
function gitInit(e: LintEnv, dir = e.cwd): void {
  git(e, dir, "init", "-q");
  git(e, dir, "add", "-A");
  git(e, dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
}

test("SessionStart: watchPaths = tracked + untracked lintable in-scope files only", () => {
  const e = makeEnv();
  e.file(".gitignore", "c.sh\n");
  const a = e.file("a.sh", "echo a\n");
  gitInit(e);
  const b = e.file("b.sh", "echo b\n");
  e.file("c.sh", "echo c\n");
  e.file("node_modules/d.sh", "echo d\n");
  e.file("x.txt", "x\n");
  e.file("s/e.sh", "echo e\n");
  const r = e.runEvent({ hook_event_name: "SessionStart", source: "startup", cwd: e.cwd, scratchpad_dir: path.join(e.cwd, "s") });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(out.hookSpecificOutput.watchPaths.length, 2);
  assert.deepEqual(new Set(out.hookSpecificOutput.watchPaths), new Set([a, b]));
});

test("SessionStart: a tracked file under a directory replaced by a symlink pointing outside the cwd is not watched", () => {
  const e = makeEnv();
  const a = e.file("a.sh", "echo a\n");
  e.file("d/a.sh", "echo d\n");
  gitInit(e);
  rmSync(path.join(e.cwd, "d"), { recursive: true });
  const outside = path.join(e.cwd, "..", "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "a.sh"), "echo o\n");
  symlinkSync(outside, path.join(e.cwd, "d"));
  const r = e.runEvent({ hook_event_name: "SessionStart", source: "startup", cwd: e.cwd });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout).hookSpecificOutput.watchPaths, [a]);
});

test("SessionStart: a tracked file under a directory replaced by a symlink inside the cwd keeps its lexical path", () => {
  const e = makeEnv();
  e.file("d/a.sh", "echo d\n");
  gitInit(e);
  e.file("sub/a.sh", "echo s\n");
  rmSync(path.join(e.cwd, "d"), { recursive: true });
  symlinkSync(path.join(e.cwd, "sub"), path.join(e.cwd, "d"));
  const r = e.runEvent({ hook_event_name: "SessionStart", source: "startup", cwd: e.cwd });
  assert.equal(r.status, 0);
  const paths = JSON.parse(r.stdout).hookSpecificOutput.watchPaths;
  assert.equal(paths.length, 2);
  assert.deepEqual(new Set(paths), new Set([path.join(e.cwd, "d", "a.sh"), path.join(e.cwd, "sub", "a.sh")]));
});

test("SessionStart: escaping and dangling leaf links and a tracked file deleted from disk are not watched, an inside leaf link is", () => {
  const e = makeEnv();
  const t = e.file("t.sh", "echo t\n");
  const x = e.file("x.sh", "echo x\n");
  e.file("gone.sh", "echo g\n");
  gitInit(e);
  rmSync(path.join(e.cwd, "gone.sh"));
  const outside = path.join(e.cwd, "..", "o.sh");
  writeFileSync(outside, "echo o\n");
  symlinkSync(outside, path.join(e.cwd, "link.sh"));
  symlinkSync(path.join(e.cwd, "missing.sh"), path.join(e.cwd, "dl.sh"));
  symlinkSync(path.join(e.cwd, "x.sh"), path.join(e.cwd, "in.sh"));
  const r = e.runEvent({ hook_event_name: "SessionStart", source: "startup", cwd: e.cwd });
  assert.equal(r.status, 0);
  const paths = JSON.parse(r.stdout).hookSpecificOutput.watchPaths;
  assert.equal(paths.length, 3);
  assert.deepEqual(new Set(paths), new Set([t, x, path.join(e.cwd, "in.sh")]));
});

test("CwdChanged: the list is built for new_cwd only; a non-git new_cwd prints nothing", () => {
  const e = makeEnv();
  e.file("a.sh", "echo a\n");
  const f = e.file("sub/f.sh", "echo f\n");
  gitInit(e);
  const r = e.runEvent({ hook_event_name: "CwdChanged", cwd: e.cwd, old_cwd: e.cwd, new_cwd: path.join(e.cwd, "sub") });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "CwdChanged");
  assert.deepEqual(out.hookSpecificOutput.watchPaths, [f]);

  const n = makeEnv();
  n.file("a.sh", "echo a\n");
  const r2 = n.runEvent({ hook_event_name: "CwdChanged", cwd: n.cwd, old_cwd: n.cwd, new_cwd: n.cwd });
  assert.equal(r2.status, 0);
  assert.equal(r2.stdout, "");
});

test("SessionStart: above WATCH_LIMIT lintable files nothing is watched (stderr note)", () => {
  const e = makeEnv();
  for (let i = 1; i <= 5001; i++) writeFileSync(path.join(e.cwd, `f${i}.sh`), "");
  // Remove the git symlink first: writing the stub through it would overwrite the real git binary.
  rmSync(path.join(e.bin, "git"));
  e.stub("git", "for ((i=1; i<=5001; i++)); do printf 'f%d.sh\\0' \"$i\"; done");
  const r = e.runEvent({ hook_event_name: "SessionStart", source: "startup", cwd: e.cwd });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /more than 5000/);
});

test("SessionStart: a real repo with 5002 lintable files watches nothing (stderr note)", () => {
  const e = makeEnv();
  for (let i = 1; i <= 5002; i++) e.file(`f${i}.sh`);
  gitInit(e);
  const r = e.runEvent({ hook_event_name: "SessionStart", source: "startup", cwd: e.cwd });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /more than 5000/);
});

test("SessionStart: exactly WATCH_LIMIT distinct lintable files are still watched, duplicate index stages counted once", () => {
  const e = makeEnv();
  for (let i = 1; i <= 5000; i++) e.file(`f${i}.sh`);
  // Remove the git symlink first: writing the stub through it would overwrite the real git binary.
  rmSync(path.join(e.bin, "git"));
  // Every name twice, as git lists unmerged index entries once per stage: 10000 raw lines, 5000 distinct files.
  e.stub("git", "for ((i=1; i<=5000; i++)); do printf 'f%d.sh\\0f%d.sh\\0' \"$i\" \"$i\"; done");
  const r = e.runEvent({ hook_event_name: "SessionStart", source: "startup", cwd: e.cwd });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.watchPaths.length, 5000);
  assert.doesNotMatch(r.stderr, /watch list/);
});

/** shellcheck output carrying one finding (the stub prints it and exits 1). */
const OUT = "a.sh:1:6: note: marker [SC2086]";

/**
 * Pipe one FileChanged payload for `file` into the hook.
 *
 * @param e - Test environment.
 * @param file - Changed file (absolute).
 * @param extra - Payload fields merged over the defaults.
 * @returns The run.
 */
const changed = (e: LintEnv, file: string, extra: Record<string, unknown> = {}) => e.runEvent({ hook_event_name: "FileChanged", cwd: e.cwd, file_path: file, event: "change", ...extra }, { out: OUT });

/**
 * Pipe one FileChanged payload for `file` into the hook without blocking (spawn, not spawnSync), so several overlap.
 *
 * @param e - Test environment.
 * @param file - Changed file (absolute).
 * @returns The hook's exit status once it closes.
 */
function changedAsync(e: LintEnv, file: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { env: e.childEnv({ out: OUT }), stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("close", resolve);
    child.stdin.on("error", () => {}); // EPIPE when a broken hook exits before the write: let the assertions report it
    child.stdin.end(JSON.stringify({ hook_event_name: "FileChanged", cwd: e.cwd, file_path: file, event: "change" }));
  });
}

test("FileChanged: a tracked, modified file is linted whole and labelled", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const a = e.file("a.sh", "echo a\n");
  gitInit(e);
  writeFileSync(a, "echo $1\n");
  const r = changed(e, a);
  assert.equal(r.status, 2);
  assert.match(r.ctx, /^universal-lint \(changed outside Write\/Edit\): /);
  assert.match(e.lines()[0], /^shellcheck /);
});

test("FileChanged: skips unchanged, ignored, unlink, outside-cwd, escaping/dangling links and scratchpad files", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  e.file(".gitignore", "ign.sh\n");
  const tracked = e.file("t.sh", "echo t\n");
  gitInit(e);
  const ign = e.file("ign.sh", "echo i\n");
  const mod = e.file("t.sh", "echo $1\n");
  const outside = path.join(e.cwd, "..", "o.sh");
  writeFileSync(outside, "echo o\n");
  symlinkSync(outside, path.join(e.cwd, "link.sh"));
  symlinkSync(path.join(e.cwd, "missing.sh"), path.join(e.cwd, "dl.sh"));
  mkdirSync(path.join(e.cwd, "s"), { recursive: true });
  const scratch = e.file("s/e.sh", "echo e\n");
  const unchanged = e.file("u.sh", "echo u\n");
  git(e, e.cwd, "add", "u.sh");
  git(e, e.cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "u");
  assert.equal(tracked, mod);
  const runs = [
    changed(e, unchanged),
    changed(e, ign),
    changed(e, mod, { event: "unlink" }),
    changed(e, outside),
    changed(e, path.join(e.cwd, "link.sh")),
    changed(e, path.join(e.cwd, "dl.sh")),
    changed(e, scratch, { scratchpad_dir: path.join(e.cwd, "s") }),
  ];
  for (const r of runs) assert.equal(r.status, 0);
  assert.deepEqual(e.lines(), []);
});

test("FileChanged: a glob-like name unchanged against HEAD is skipped while a file it would match is modified", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const glob = e.file("[ab].sh", "echo g\n");
  const a = e.file("a.sh", "echo a\n");
  gitInit(e);
  writeFileSync(a, "echo $1\n");
  const r = changed(e, glob);
  assert.equal(r.status, 0);
  assert.deepEqual(e.lines(), []);
});

test("FileChanged: skipped while the content matches the Write/Edit digest, linted after a further change", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const a = e.file("a.sh", "echo a\n");
  gitInit(e);
  writeFileSync(a, "echo $1\n");
  assert.equal(e.run(a, { out: OUT }).status, 2);
  assert.equal(e.lines().length, 1);
  assert.equal(changed(e, a).status, 0);
  assert.equal(e.lines().length, 1);
  writeFileSync(a, "echo $2\n");
  assert.equal(changed(e, a).status, 2);
  assert.equal(e.lines().length, 2);
});

test("FileChanged: a write by another program that landed before the Edit's hook ran is still linted", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const a = e.file("a.sh", "echo a\necho b\n");
  gitInit(e);
  writeFileSync(a, "echo A\necho $2\n"); // the Edit changed line 1, a formatter/editor then line 2, all before the hook
  const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-echo a", "+echo A"] }];
  e.run(a, { toolName: "Edit", toolResponse: { originalFile: "echo a\necho b\n", structuredPatch: patch } });
  const before = e.lines().length;
  assert.equal(changed(e, a).status, 2);
  assert.equal(e.lines().length, before + 1);
});

test("FileChanged: outside a git repo the file is linted (git failure means lint)", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const a = e.file("a.sh", "echo $1\n");
  assert.equal(changed(e, a).status, 2);
  assert.equal(e.lines().length, 1);
});

test("FileChanged: 20 concurrent events lint at most FILE_CHANGED_SLOTS at a time, all 20 linted, slots released (F10)", async () => {
  const e = makeEnv();
  // Appends a sub-ms wall-clock start/end around a 300 ms sleep (date and sleep are not on the hermetic PATH).
  e.stub(
    "shellcheck",
    `node -e 'const fs = require("fs"), t = () => (performance.timeOrigin + performance.now()).toFixed(3); fs.appendFileSync(process.env.RECORD, "start " + t() + "\\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); fs.appendFileSync(process.env.RECORD, "end " + t() + "\\n");'`,
    "printf '%s\\n' \"$OUT\"",
    "exit 1",
  );
  const files = Array.from({ length: 20 }, (_, i) => e.file(`f${i}.sh`, "echo a\n"));
  gitInit(e);
  for (const f of files) writeFileSync(f, "echo $1\n");
  const statuses = await Promise.all(files.map((f) => changedAsync(e, f)));
  assert.deepEqual(statuses, files.map(() => 2));
  const events = e.lines()
    .filter((l) => l.startsWith("start ") || l.startsWith("end "))
    .map((l) => ({ t: Number(l.split(" ")[1]), d: l.startsWith("start ") ? 1 : -1 }));
  assert.equal(events.filter((x) => x.d === 1).length, 20);
  assert.equal(events.filter((x) => x.d === -1).length, 20);
  events.sort((a, b) => a.t - b.t || a.d - b.d); // ends before starts on ties
  let cur = 0;
  let max = 0;
  for (const x of events) {
    cur += x.d;
    max = Math.max(max, cur);
  }
  assert.ok(max <= FILE_CHANGED_SLOTS, `max overlap ${max} > FILE_CHANGED_SLOTS ${FILE_CHANGED_SLOTS}`);
  assert.deepEqual(readdirSync(path.join(e.data, "fc-slots")), []);
});

test("FileChanged: an unusable slot dir lints without a slot (fail open, F10)", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const a = e.file("a.sh", "echo a\n");
  gitInit(e);
  writeFileSync(a, "echo $1\n");
  writeFileSync(e.data, ""); // a regular file: mkdirSync(<data>/fc-slots) throws ENOTDIR
  assert.equal(changed(e, a).status, 2);
  assert.equal(e.lines().filter((l) => l.startsWith("shellcheck ")).length, 1);
});

test("FileChanged: with every slot held a .ts file gives up at uptime 10 s with a stderr note, exit 0, slots untouched (F10)", () => {
  // Costs about 10 s on purpose: the deadline is process-uptime based and has no test seam (do not add one).
  const e = makeEnv();
  const a = e.file("a.ts", "export const a = 1;\n");
  gitInit(e);
  writeFileSync(a, "export const a = 2;\n");
  const dir = path.join(e.data, "fc-slots");
  mkdirSync(dir, { recursive: true });
  // The vitest worker pid is alive, so slotStale keeps every slot held.
  for (let i = 0; i < FILE_CHANGED_SLOTS; i++) writeFileSync(path.join(dir, String(i)), String(process.pid));
  const t0 = Date.now();
  const r = changed(e, a);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^universal-lint: FileChanged: no lint slot free in time, .*a\.ts not linted\n$/);
  assert.ok(Date.now() - t0 >= 9500, `gave up after ${Date.now() - t0} ms, expected about 10 s`);
  assert.equal(readdirSync(dir).length, FILE_CHANGED_SLOTS);
  for (let i = 0; i < FILE_CHANGED_SLOTS; i++) assert.equal(readFileSync(path.join(dir, String(i)), "utf8"), String(process.pid));
});

/** A tsconfig.json governing `*.ts` in the project root. */
const TSCONFIG = "{\"compilerOptions\":{\"noEmit\":true},\"include\":[\"*.ts\"]}";

/**
 * Drop a bash stub that sleeps `ms` (node + Atomics.wait: no `sleep` on the hermetic PATH), records `<name> <argv>`,
 * prints `out` and exits with `code`.
 *
 * @param e - Test environment.
 * @param name - Stub name (tsc, go, cargo).
 * @param ms - Sleep before recording, in milliseconds.
 * @param out - stdout line (no single quotes).
 * @param code - Exit status.
 */
function slowStub(e: LintEnv, name: string, ms: number, out: string, code: number): void {
  e.stub(
    name,
    `node -e "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms})"`,
    `printf "%s %s\\n" ${name} "$*" >> "$RECORD"`,
    `printf '%s\\n' '${out}'`,
    `exit ${code}`,
  );
}

/**
 * Pipe one FileChanged payload for `file` into the hook without blocking, keeping its stderr.
 *
 * @param e - Test environment.
 * @param file - Changed file (absolute).
 * @returns The hook's exit status and stderr once it closes.
 */
function changedAsyncRun(e: LintEnv, file: string): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { env: e.childEnv({ out: OUT }), stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stderr }));
    child.stdin.on("error", () => {}); // EPIPE when a broken hook exits before the write: let the assertions report it
    child.stdin.end(JSON.stringify({ hook_event_name: "FileChanged", cwd: e.cwd, file_path: file, event: "change" }));
  });
}

/**
 * Block the test thread for `ms` milliseconds.
 *
 * @param ms - Milliseconds to wait.
 */
const waitMs = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Recorded stub calls whose line starts with `prefix`.
 *
 * @param e - Test environment.
 * @param prefix - Line prefix, e.g. `"tsc "`.
 * @returns The count.
 */
const calls = (e: LintEnv, prefix: string): number => e.lines().filter((l) => l.startsWith(prefix)).length;

test("FileChanged: 10 concurrent .ts events run tsc once, the finding is reported once (F13)", async () => {
  const e = makeEnv();
  e.file("tsconfig.json", TSCONFIG);
  // No eslint/oxlint config: the chain is skipped, tsc is the only spawn.
  slowStub(e, "tsc", 1000, "f0.ts(1,1): error TS2322: marker", 2);
  const files = Array.from({ length: 10 }, (_, i) => e.file(`f${i}.ts`, `export const f${i} = ${i};\n`));
  gitInit(e);
  for (const [i, f] of files.entries()) writeFileSync(f, `export const f${i} = ${i + 1};\n`);
  const runs = await Promise.all(files.map((f) => changedAsyncRun(e, f)));
  // Deterministic count: late arrivals are covered by .last (their ctime precedes the holder's start) and lock
  // waiters re-check .last after the claim; the 1 s sleep only exercises the waiter path, the count does not need it.
  assert.equal(calls(e, "tsc "), 1);
  assert.equal(runs.filter((r) => r.status === 2).length, 1);
  assert.equal(runs.filter((r) => r.status === 0).length, 9);
  const reporters = runs.filter((r) => r.stderr.includes("TS2322: marker"));
  assert.equal(reporters.length, 1);
  assert.equal(reporters[0].status, 2);
  for (const r of runs) if (r !== reporters[0]) assert.equal(r.stderr, "");
  const locks = readdirSync(path.join(e.data, "fc-locks"));
  assert.equal(locks.filter((n) => n.endsWith(".last")).length, 1);
  assert.equal(locks.filter((n) => n.endsWith(".lock")).length, 0);
});

test("FileChanged: 5 concurrent .go events run go vet once (F13)", async () => {
  const e = makeEnv();
  slowStub(e, "go", 500, "pkg/a0.go:1:1: vet marker", 1);
  const files = Array.from({ length: 5 }, (_, i) => e.file(`pkg/a${i}.go`, "package pkg\n"));
  gitInit(e);
  for (const f of files) writeFileSync(f, "package pkg\n\n// changed\n");
  const runs = await Promise.all(files.map((f) => changedAsyncRun(e, f)));
  assert.equal(calls(e, "go vet"), 1);
  assert.equal(runs.filter((r) => r.status === 2).length, 1);
  assert.equal(runs.filter((r) => r.status === 0).length, 4);
});

test("FileChanged: 5 concurrent .rs events run cargo check once (F13)", async () => {
  const e = makeEnv();
  e.file("Cargo.toml", "[package]\nname = \"x\"\n");
  slowStub(e, "cargo", 500, "error: cargo marker", 101);
  const files = Array.from({ length: 5 }, (_, i) => e.file(`src/m${i}.rs`, "fn f() {}\n"));
  gitInit(e);
  for (const f of files) writeFileSync(f, "fn f() {}\n// changed\n");
  const runs = await Promise.all(files.map((f) => changedAsyncRun(e, f)));
  assert.equal(calls(e, "cargo check"), 1);
  assert.equal(runs.filter((r) => r.status === 2).length, 1);
  assert.equal(runs.filter((r) => r.status === 0).length, 4);
});

test("FileChanged: a change after the last completed check runs tsc again, a newer stamp covers it (F13)", () => {
  const e = makeEnv();
  e.file("tsconfig.json", TSCONFIG);
  slowStub(e, "tsc", 0, "a.ts(1,1): error TS2322: marker", 2);
  const a = e.file("a.ts", "export const a = 1;\n");
  gitInit(e);
  writeFileSync(a, "export const a = 2;\n");
  assert.equal(changed(e, a).status, 2);
  assert.equal(calls(e, "tsc "), 1);
  waitMs(50); // coarse kernel clock: the rewrite's ctime must land past the first run's .last
  writeFileSync(a, "export const a = 3;\n");
  assert.equal(changed(e, a).status, 2);
  assert.equal(calls(e, "tsc "), 2);
  waitMs(50); // coarse kernel clock: keep this rewrite's ctime clear of the second run's .last
  writeFileSync(a, "export const a = 4;\n");
  waitMs(20); // coarse kernel clock: the forced stamp below must be newer than this rewrite's ctime
  const dir = path.join(e.data, "fc-locks");
  const lasts = readdirSync(dir).filter((n) => n.endsWith(".last"));
  assert.equal(lasts.length, 1);
  writeFileSync(path.join(dir, lasts[0]), String(Date.now()));
  const r = changed(e, a);
  assert.equal(r.status, 0);
  assert.equal(calls(e, "tsc "), 2);
});

test("FileChanged: an unusable fc-locks dir runs tsc unlocked (fail open, F13)", () => {
  const e = makeEnv();
  e.file("tsconfig.json", TSCONFIG);
  slowStub(e, "tsc", 0, "a.ts(1,1): error TS2322: marker", 2);
  const a = e.file("a.ts", "export const a = 1;\n");
  gitInit(e);
  writeFileSync(a, "export const a = 2;\n");
  mkdirSync(e.data, { recursive: true });
  writeFileSync(path.join(e.data, "fc-locks"), ""); // a regular file: mkdirSync(<data>/fc-locks) throws
  assert.equal(changed(e, a).status, 2);
  assert.equal(calls(e, "tsc "), 1);
});
