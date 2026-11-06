// File detection: SessionStart/CwdChanged watch list and FileChanged linting, against the built hook in a real git repo.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { makeEnv } from "./support/lint-hook.mts";
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
  assert.match(r.stderr, /above 5000/);
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

test("FileChanged: outside a git repo the file is linted (git failure means lint)", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const a = e.file("a.sh", "echo $1\n");
  assert.equal(changed(e, a).status, 2);
  assert.equal(e.lines().length, 1);
});
