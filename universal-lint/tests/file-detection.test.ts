// File detection: SessionStart/CwdChanged watch list (built watch-paths hook) and FileChanged linting (built server) in a real git repo.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "vitest";
import { FILE_CHANGED_SLOTS } from "../src/hooks/lint-core.ts";
import { makeEnv, WATCH } from "./support/lint-hook.ts";
import type { LintEnv } from "./support/lint-hook.ts";

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

// F05: Claude Code writes the payload after it spawned the hook, so fd 0 is a non-blocking pipe and a synchronous read throws EAGAIN;
// `runEvent` feeds the payload at spawn time (`spawnSync` input) and cannot show it
test("SessionStart: a payload written 100 ms after the spawn (a late stdin writer, F05) still yields the watch list", async () => {
  const e = makeEnv();
  const a = e.file("a.sh", "echo a\n");
  gitInit(e);
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [WATCH], { env: e.childEnv(), stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.on("error", reject);
    child.on("close", () => resolve(out));
    child.stdin.on("error", () => {}); // EPIPE when a broken hook exits before the write: the assertion reports it
    setTimeout(() => child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: e.cwd })), 100);
  });
  assert.deepEqual((JSON.parse(stdout) as { hookSpecificOutput: { watchPaths: string[] } }).hookSpecificOutput.watchPaths, [a]);
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

/** One server of a test (`LintEnv.server`). */
type Server = ReturnType<LintEnv["server"]>;

/**
 * Send one FileChanged payload per file to one server, all at once, then read its reports once at the end.
 *
 * @remarks
 * The slot cap and the project-check lock live in the server's memory, so concurrent calls on one server share them.
 * The reports are read with `prompt_submitted`, which drains them without a sweep (a `stop` would lint the other
 * events' pending files again).
 *
 * @param s - The server (`UNIVERSAL_LINT_SETTLE_MS` 0: every call awaits its lint).
 * @param e - Test environment.
 * @param files - Changed files (absolute).
 * @returns The report texts of all events ("" when none).
 */
async function changedConcurrent(s: Server, e: LintEnv, files: string[]): Promise<string> {
  await Promise.all(files.map((f) => s.call("file_changed", { hook_event_name: "FileChanged", cwd: e.cwd, file_path: f, event: "change", session_id: "harness" })));
  const r = await s.call("prompt_submitted", { cwd: e.cwd, session_id: "harness" });
  return (r["hookSpecificOutput"] as { additionalContext?: string } | undefined)?.additionalContext ?? "";
}

/**
 * Recorded stub calls whose line starts with `prefix`.
 *
 * @param e - Test environment.
 * @param prefix - Line prefix, e.g. `"tsc "`.
 * @returns The count.
 */
const calls = (e: LintEnv, prefix: string): number => e.lines().filter((l) => l.startsWith(prefix)).length;

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

test("FileChanged: a modified file reached through a committed symlinked dir (cwd through the link) is linted", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  mkdirSync(path.join(e.cwd, "real"), { recursive: true });
  const a = e.file("real/a.sh", "echo a\n");
  symlinkSync("real", path.join(e.cwd, "link"));
  gitInit(e);
  writeFileSync(a, "echo $1\n");
  const link = path.join(e.cwd, "link");
  const r = changed(e, path.join(link, "a.sh"), { cwd: link });
  assert.equal(r.status, 2);
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

/**
 * One server for the Write/Edit calls and the FileChanged calls of a session: the digest store lives in its memory.
 *
 * @param e - Test environment (its stub reports OUT).
 * @returns The server, the session key and `change`, which runs one FileChanged and answers the report state.
 */
async function session(e: LintEnv) {
  const s = e.server({ out: OUT });
  const key = await s.key("s1");
  const change = async (f: string): Promise<unknown> => {
    await s.call("file_changed", { cwd: e.cwd, session_id: "s1", scratchpad_dir: "", file_path: f, event: "change" });
    return (await s.call("next_report", { session_id: "s1", key, wait_ms: 0 }))["state"];
  };
  return { s, key, change };
}

test("FileChanged: skipped while the content matches the Write/Edit digest, linted after a further change", async () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const a = e.file("a.sh", "echo a\n");
  gitInit(e);
  writeFileSync(a, "echo $1\n");
  const { s, key, change } = await session(e);
  await s.call("file_edited", { cwd: e.cwd, session_id: "s1", key, tool_name: "Write", tool_input: { file_path: a, content: "echo $1\n" }, tool_response: {} });
  assert.equal(e.lines().length, 1);
  assert.equal(await change(a), "timeout");
  assert.equal(e.lines().length, 1);
  writeFileSync(a, "echo $2\n");
  assert.equal(await change(a), "ready");
  assert.equal(e.lines().length, 2);
  // the stale digest is gone: an outside restore of the written bytes lints
  writeFileSync(a, "echo $1\n");
  assert.equal(await change(a), "ready");
  assert.equal(e.lines().length, 3);
});

test("FileChanged: a write by another program that landed before the Edit's hook ran is still linted", async () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const a = e.file("a.sh", "echo a\necho b\n");
  gitInit(e);
  writeFileSync(a, "echo A\necho $2\n"); // the Edit changed line 1, a formatter/editor then line 2, all before the hook
  const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-echo a", "+echo A"] }];
  const { s, key, change } = await session(e);
  await s.call("file_edited", { cwd: e.cwd, session_id: "s1", key, tool_name: "Edit", tool_input: { file_path: a }, tool_response: { originalFile: "echo a\necho b\n", structuredPatch: patch } });
  const before = e.lines().length;
  assert.equal(await change(a), "ready");
  assert.equal(e.lines().length, before + 1);
});

test("FileChanged: outside a git repo the file is linted (git failure means lint)", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const a = e.file("a.sh", "echo $1\n");
  assert.equal(changed(e, a).status, 2);
  assert.equal(e.lines().length, 1);
});

/** git identity for commits, merges and ref updates (the hermetic HOME has no git config). */
const ID = ["-c", "user.email=t@t", "-c", "user.name=t"];

/**
 * Stage everything in `dir` and commit it.
 *
 * @param e - Test environment.
 * @param dir - Repository or worktree directory.
 * @param msg - Commit message.
 */
function commitAll(e: LintEnv, dir: string, msg: string): void {
  git(e, dir, "add", "-A");
  git(e, dir, ...ID, "commit", "-qm", msg);
}

/**
 * A recording shellcheck stub (reports OUT, exit 1) and a committed repo with `a.sh`, `c.sh`, `m.sh`, `x.sh` (`echo <name>`).
 *
 * @param e - Test environment.
 */
function seed(e: LintEnv): void {
  e.recStub("shellcheck", 1);
  for (const n of ["a", "c", "m", "x"]) e.file(`${n}.sh`, `echo ${n}\n`);
  gitInit(e);
}

/**
 * One server started in `dir` with FileChanged and Stop calls of session s1, so both act for one owner (the main conversation).
 *
 * @param e - Test environment (its stub reports OUT).
 * @param dir - Server cwd and payload cwd.
 * @returns The server, `change` (one `file_changed` call) and `stop` (one Stop, which sweeps the owner's pending records).
 */
function gitSession(e: LintEnv, dir: string) {
  const s = e.server({ out: OUT, cwd: dir });
  const change = (f: string) => s.call("file_changed", { hook_event_name: "FileChanged", cwd: dir, session_id: "s1", scratchpad_dir: "", file_path: f, event: "change" });
  const stop = () => s.call("stop", { hook_event_name: "Stop", cwd: dir, session_id: "s1", agent_id: "", scratchpad_dir: "", stop_hook_active: "false" });
  return { s, change, stop };
}

/**
 * Commits a change of `a.sh` on a new branch `other` in `dir`, switches back and to `other` again, then runs FileChanged
 * for `a.sh` and a Stop through one server: neither may lint (F41).
 *
 * @param e - Test environment (`seed` ran; no linter call recorded yet).
 * @param dir - Repository or linked-worktree directory holding the committed `a.sh` (`echo a`).
 */
async function assertBranchSwitchSkipped(e: LintEnv, dir: string): Promise<void> {
  const a = path.join(dir, "a.sh");
  git(e, dir, "checkout", "-q", "-b", "other");
  writeFileSync(a, "echo $1\n");
  commitAll(e, dir, "other");
  git(e, dir, "checkout", "-q", "-");
  assert.equal(readFileSync(a, "utf8"), "echo a\n");
  git(e, dir, "checkout", "-q", "other");
  assert.equal(readFileSync(a, "utf8"), "echo $1\n");
  const { change, stop } = gitSession(e, dir);
  assert.deepEqual(await change(a), {});
  assert.deepEqual(await stop(), {});
  assert.deepEqual(e.lines(), []);
}

/**
 * Leaves `dir` in a pull stopped on a conflict (`UU c.sh`, auto-merged `M  m.sh`) plus an outside edit (` M x.sh`), then:
 * FileChanged for c.sh and m.sh and a Stop lint nothing; FileChanged for x.sh lints it (F41).
 *
 * @param e - Test environment (`seed` ran; no linter call recorded yet).
 * @param dir - Repository or linked-worktree directory of the env's repo.
 */
async function assertStoppedPullSkipped(e: LintEnv, dir: string): Promise<void> {
  const up = path.join(e.cwd, "..", `up-${path.basename(dir)}`);
  git(e, e.cwd, "clone", "-q", e.cwd, up);
  writeFileSync(path.join(up, "c.sh"), "echo up\n");
  writeFileSync(path.join(up, "m.sh"), "echo $2\n");
  commitAll(e, up, "up");
  const c = path.join(dir, "c.sh");
  const m = path.join(dir, "m.sh");
  const x = path.join(dir, "x.sh");
  writeFileSync(c, "echo mine\n");
  commitAll(e, dir, "mine");
  const pull = spawnSync(path.join(e.bin, "git"), [...ID, "pull", "-q", "--no-rebase", up, "HEAD"], { cwd: dir, env: e.childEnv(), encoding: "utf8" });
  assert.notEqual(pull.status, 0, `the pull stops on the conflict: ${pull.stderr}`);
  writeFileSync(x, "echo $3\n");
  const st = git(e, dir, "status", "--porcelain");
  assert.match(st, /^UU c\.sh$/m);
  assert.match(st, /^M {2}m\.sh$/m);
  assert.match(st, /^ M x\.sh$/m);
  const { change, stop } = gitSession(e, dir);
  assert.deepEqual(await change(c), {});
  assert.deepEqual(await change(m), {});
  assert.deepEqual(await stop(), {});
  assert.deepEqual(e.lines(), []);
  await change(x);
  assert.equal(e.lines().length, 1);
  assert.match(e.lines()[0], /^shellcheck .*x\.sh/);
}

test("FileChanged: a file a branch switch rewrote is linted neither inline nor by the Stop sweep (F41)", async () => {
  const e = makeEnv();
  seed(e);
  await assertBranchSwitchSkipped(e, e.cwd);
});

test("FileChanged: a file a fast-forward pull rewrote is linted neither inline nor by the Stop sweep (F41)", async () => {
  const e = makeEnv();
  seed(e);
  const a = path.join(e.cwd, "a.sh");
  const up = path.join(e.cwd, "..", "up");
  git(e, e.cwd, "clone", "-q", e.cwd, up);
  writeFileSync(path.join(up, "a.sh"), "echo $1\n");
  commitAll(e, up, "up");
  git(e, e.cwd, ...ID, "pull", "-q", "--ff-only", up, "HEAD");
  assert.equal(readFileSync(a, "utf8"), "echo $1\n");
  const { change, stop } = gitSession(e, e.cwd);
  assert.deepEqual(await change(a), {});
  assert.deepEqual(await stop(), {});
  assert.deepEqual(e.lines(), []);
});

test("FileChanged: during a pull stopped on a conflict the conflicted and the auto-merged file are skipped, an outside edit is linted (F41)", async () => {
  const e = makeEnv();
  seed(e);
  await assertStoppedPullSkipped(e, e.cwd);
});

test("FileChanged: a staged-only change outside a merge or rebase is linted (F41)", async () => {
  const e = makeEnv();
  seed(e);
  const m = path.join(e.cwd, "m.sh");
  writeFileSync(m, "echo $2\n");
  git(e, e.cwd, "add", "m.sh");
  assert.equal(git(e, e.cwd, "status", "--porcelain", "--", "m.sh"), "M  m.sh\n");
  const { change } = gitSession(e, e.cwd);
  await change(m);
  assert.equal(e.lines().length, 1);
  assert.match(e.lines()[0], /^shellcheck /);
});

test("FileChanged: in a linked worktree (.git is a gitdir: file) a branch switch and a stopped pull are skipped (F41)", async () => {
  const e = makeEnv();
  seed(e);
  const wt = path.join(e.cwd, "..", "wt");
  git(e, e.cwd, "worktree", "add", "-q", wt);
  assert.match(readFileSync(path.join(wt, ".git"), "utf8"), /^gitdir: /);
  await assertBranchSwitchSkipped(e, wt);
  // MERGE_HEAD lies in <repo>/.git/worktrees/wt: the auto-merged m.sh is skipped only when gitDirOf follows the gitdir: line
  await assertStoppedPullSkipped(e, wt);
});

test("FileChanged: while index.lock exists git status waits; the state git commits after it is clean, so nothing is linted (F41)", async () => {
  const e = makeEnv();
  seed(e);
  const a = path.join(e.cwd, "a.sh");
  const dotGit = path.join(e.cwd, ".git");
  const c1 = git(e, e.cwd, "rev-parse", "HEAD").trim();
  writeFileSync(a, "echo $1\n");
  commitAll(e, e.cwd, "c2");
  const c2 = git(e, e.cwd, "rev-parse", "HEAD").trim();
  copyFileSync(path.join(dotGit, "index"), path.join(dotGit, "next-index"));
  // back to the moment git is still writing: HEAD and index at c1, the worktree already holds c2's bytes
  git(e, e.cwd, ...ID, "reset", "-q", c1);
  assert.equal(git(e, e.cwd, "status", "--porcelain", "--", "a.sh"), " M a.sh\n");
  renameSync(path.join(dotGit, "next-index"), path.join(dotGit, "index.lock"));
  // the server's git spawns are recorded, then the real git runs (remove the symlink first: writing through it would overwrite git)
  const realGit = readlinkSync(path.join(e.bin, "git"));
  rmSync(path.join(e.bin, "git"));
  e.stub("git", `printf 'git %s\\n' "$*" >> "$RECORD"`, `exec ${JSON.stringify(realGit)} "$@"`);
  const { s, change, stop } = gitSession(e, e.cwd);
  await s.key("s1"); // the server is up before the event arrives
  const pending = change(a);
  await sleep(300);
  // git's last steps: HEAD moves, then the new index replaces the lock in one rename
  git(e, e.cwd, ...ID, "update-ref", "HEAD", c2);
  appendFileSync(e.record, "released\n");
  renameSync(path.join(dotGit, "index.lock"), path.join(dotGit, "index"));
  assert.deepEqual(await pending, {});
  assert.deepEqual(await stop(), {});
  const lines = e.lines();
  const status = lines.findIndex((l) => l.startsWith("git --no-optional-locks"));
  assert.ok(status > lines.indexOf("released"), `git status ran only after the lock was released: ${lines.join(" | ")}`);
  assert.equal(lines.filter((l) => l.startsWith("shellcheck")).length, 0);
});

// real wall-clock time on purpose (spec test 6): no clock seam exists, and one only for this test is not justified
test("FileChanged: an index.lock that never goes away ends the wait at GIT_TIMEOUT_MS and the file is linted (fail open, F41)", { timeout: 20_000 }, async () => {
  const e = makeEnv();
  seed(e);
  const a = path.join(e.cwd, "a.sh");
  writeFileSync(a, "echo $1\n");
  writeFileSync(path.join(e.cwd, ".git", "index.lock"), "");
  const { s, change } = gitSession(e, e.cwd);
  await s.key("s1");
  const t0 = Date.now();
  await change(a);
  assert.ok(Date.now() - t0 >= 9_000, "the call waited for the lock up to GIT_TIMEOUT_MS");
  assert.equal(e.lines().length, 1);
  assert.match(e.lines()[0], /^shellcheck /);
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
  const extra = e.file("g.sh", "echo a\n");
  gitInit(e);
  for (const f of [...files, extra]) writeFileSync(f, "echo $1\n");
  const s = e.server({ out: OUT });
  assert.match(await changedConcurrent(s, e, files), /marker/);
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
  // every slot was released: one more event lints
  assert.match(await changedConcurrent(s, e, [extra]), /marker/);
  assert.equal(calls(e, "start "), 21);
});

// Removed: "an unusable slot dir lints without a slot" (no slot directory left to fail; the slots live in the server's memory).

/**
 * Drop a shellcheck stub that records `start`, then blocks until the file `$REL` exists, then exits 0.
 *
 * @param e - Test environment.
 */
function blockingStub(e: LintEnv): void {
  e.stub(
    "shellcheck",
    "printf 'start\\n' >> \"$RECORD\"",
    `node -e 'const fs = require("fs"); const w = () => { if (!fs.existsSync(process.env.REL)) setTimeout(w, 20); }; w();'`,
    "exit 0",
  );
}

// Removed with slotStale: the planted stale slot and the dead-pid slot cases.
test("FileChanged: with every slot held a .ts file gives up after 10 s of call time with a stderr note while the held lints run on (F10)", { timeout: 30_000 }, async () => {
  const e = makeEnv();
  const rel = path.join(path.dirname(e.cwd), "release");
  blockingStub(e);
  const files = Array.from({ length: FILE_CHANGED_SLOTS }, (_, i) => e.file(`b${i}.sh`, "echo a\n"));
  const a = e.file("a.ts", "export const a = 1;\n");
  gitInit(e);
  for (const f of files) writeFileSync(f, "echo $1\n");
  writeFileSync(a, "export const a = 2;\n");
  const s = e.server({ env: { REL: rel } });
  const held = Promise.all(files.map((f) => s.call("file_changed", { cwd: e.cwd, session_id: "s1", scratchpad_dir: "", file_path: f, event: "change" })));
  let heldDone = false;
  void held.then(() => (heldDone = true));
  await expect.poll(() => calls(e, "start"), { interval: 20, timeout: 10_000 }).toBe(FILE_CHANGED_SLOTS);
  assert.deepEqual(await s.call("file_changed", { cwd: e.cwd, session_id: "s1", scratchpad_dir: "", file_path: a, event: "change" }), {});
  assert.equal(heldDone, false, "the K lints still hold their slots");
  assert.match(s.stderr(), /universal-lint: FileChanged: no lint slot free in time, .*a\.ts not linted\n/);
  writeFileSync(rel, "");
  await held;
  assert.equal(calls(e, "start"), FILE_CHANGED_SLOTS);
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

test("FileChanged: 10 concurrent .ts events run tsc once, the finding is reported once (F13)", async () => {
  const e = makeEnv();
  e.file("tsconfig.json", TSCONFIG);
  // No eslint/oxlint config: the chain is skipped, tsc is the only spawn.
  slowStub(e, "tsc", 1000, "f0.ts(1,1): error TS2322: marker", 2);
  const files = Array.from({ length: 10 }, (_, i) => e.file(`f${i}.ts`, `export const f${i} = ${i};\n`));
  gitInit(e);
  for (const [i, f] of files.entries()) writeFileSync(f, `export const f${i} = ${i + 1};\n`);
  const text = await changedConcurrent(e.server({ out: OUT }), e, files);
  // Deterministic count: every file's ctime precedes the holder's start, so the lock waiters are covered once it ends.
  assert.equal(calls(e, "tsc "), 1, "the tsc stub recorded exactly one run");
  assert.equal(text.split("TS2322: marker").length - 1, 1, "the finding is reported once");
});

test("FileChanged: 5 concurrent .go events run go vet once (F13)", async () => {
  const e = makeEnv();
  slowStub(e, "go", 500, "pkg/a0.go:1:1: vet marker", 1);
  const files = Array.from({ length: 5 }, (_, i) => e.file(`pkg/a${i}.go`, "package pkg\n"));
  gitInit(e);
  for (const f of files) writeFileSync(f, "package pkg\n\n// changed\n");
  const text = await changedConcurrent(e.server({ out: OUT }), e, files);
  assert.equal(calls(e, "go vet"), 1);
  assert.equal(text.split("vet marker").length - 1, 1, "the finding is reported once");
});

test("FileChanged: 5 concurrent .rs events run cargo check once (F13)", async () => {
  const e = makeEnv();
  e.file("Cargo.toml", "[package]\nname = \"x\"\n");
  slowStub(e, "cargo", 500, "error: cargo marker", 101);
  const files = Array.from({ length: 5 }, (_, i) => e.file(`src/m${i}.rs`, "fn f() {}\n"));
  gitInit(e);
  for (const f of files) writeFileSync(f, "fn f() {}\n// changed\n");
  const text = await changedConcurrent(e.server({ out: OUT }), e, files);
  assert.equal(calls(e, "cargo check"), 1);
  assert.equal(text.split("cargo marker").length - 1, 1, "the finding is reported once");
});

/**
 * One FileChanged call for `file` on server `s`.
 *
 * @param s - The server.
 * @param e - Test environment.
 * @param file - Changed file (absolute).
 * @param session_id - The payload's session id.
 * @returns The call's answer.
 */
const fileChanged = (s: Server, e: LintEnv, file: string, session_id = "s1") => s.call("file_changed", { cwd: e.cwd, session_id, scratchpad_dir: "", file_path: file, event: "change" });

// Removed: the planted newer `.last` stamp (the stamp lives in the server's memory); "a second event without a rewrite does not" replaces it.
test("FileChanged: a change after the last completed check runs tsc again, a second event without a rewrite does not (F13)", async () => {
  const e = makeEnv();
  e.file("tsconfig.json", TSCONFIG);
  slowStub(e, "tsc", 0, "a.ts(1,1): error TS2322: marker", 2);
  const a = e.file("a.ts", "export const a = 1;\n");
  gitInit(e);
  writeFileSync(a, "export const a = 2;\n");
  await sleep(20); // coarse kernel clock: the run's start must lie past the rewrite's ctime
  const s = e.server({ out: OUT });
  await fileChanged(s, e, a);
  assert.equal(calls(e, "tsc "), 1);
  await sleep(50); // coarse kernel clock: the rewrite's ctime must land past the first run's start
  writeFileSync(a, "export const a = 3;\n");
  await sleep(20);
  await fileChanged(s, e, a);
  assert.equal(calls(e, "tsc "), 2);
  await fileChanged(s, e, a);
  assert.equal(calls(e, "tsc "), 2);
});

test("FileChanged: the payload's session_id keys the coverage stamp, another session runs tsc again (F13)", async () => {
  const e = makeEnv();
  e.file("tsconfig.json", TSCONFIG);
  slowStub(e, "tsc", 0, "a.ts(1,1): error TS2322: marker", 2);
  const a = e.file("a.ts", "export const a = 1;\n");
  gitInit(e);
  writeFileSync(a, "export const a = 2;\n");
  await sleep(20);
  const s = e.server({ out: OUT });
  for (const [i, session_id] of ["A", "B"].entries()) {
    await fileChanged(s, e, a, session_id);
    assert.equal(calls(e, "tsc "), i + 1);
  }
  await fileChanged(s, e, a, "A");
  assert.equal(calls(e, "tsc "), 2);
});

// Removed: "an unusable fc-locks dir runs tsc unlocked" (no lock directory left to fail; the lock lives in the server's memory).
