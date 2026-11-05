// Tests for the built plugin/hooks/notice.mjs (Claude Code function-hooks module) on claude-engine-vitest, the
// workspace's vitest stand-in for the official `claude-code/testing` kit: stubs answer fs.exists (backed by node:fs),
// session.cwd, env.get, process.run and ui.toast, and mock.clock(on).settle() waits for the detached check. The
// first test records the registration list by hand (the kit does not expose it); the last two read the built file.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as plainTest, vi } from "vitest";
import { createKit } from "claude-engine-vitest";
import { register } from "../plugin/hooks/notice.mjs";
import { CONFIG_NAMES } from "../plugin/skills/dprint/config-names.mjs";

const { test, mock } = createKit({ module: new URL("../plugin/hooks/notice.mjs", import.meta.url), plugin: "dprint" });

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugin");
const HOME = "/home/u";
const HOME_DPRINT = `${HOME}/.dprint/bin/dprint`;
const PATH_ARGV = ["dprint", "--version"];
const NPX_ARGV = ["npx", "--yes", "dprint", "--version"];
const PROBE_INIT = { timeoutMs: 10000 };
const OK = { value: { exitCode: 0, stdout: "dprint 0.50.0\n", stderr: "" } };
const EXIT_1 = { value: { exitCode: 1, stdout: "", stderr: "" } };
const NOT_DPRINT = { value: { exitCode: 0, stdout: "not dprint\n", stderr: "" } };
// a deny rejects the mod's $.process.run: stands for "the program cannot start"
const DENY = { deny: "spawn ENOENT" };
const NEXT = "next-result";

/** A fresh dir holding a `.git` dir: the config walk stops there, so no stray config above os.tmpdir() leaks in. */
function repo() {
  const d = mkdtempSync(path.join(tmpdir(), "dprint-notice-"));
  mkdirSync(path.join(d, ".git"));
  return d;
}

/** Writes the dprint config `name` into `dir` and returns `dir`. */
function withConfig(dir, name = "dprint.json") {
  mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  writeFileSync(path.join(dir, name), "{}");
  return dir;
}

/** The toast text the module shows for `dir`. */
const toastText = (dir) =>
  `dprint: ${dir} has a dprint config but dprint cannot run here (no dprint on PATH or in ~/.dprint/bin, and npx --yes dprint failed), formatting is off; run /dprint:dprint init`;

/**
 * Registers every stub (before the test's first `$` call, as the kit requires) and returns what the module did.
 * `cwd`: session.cwd's answer, a string or a `{ deny }`; `exists(path)` and `run(argv)` return a stub result;
 * `home: null` leaves HOME unset, `home: { deny }` rejects env.get.
 */
function setup($, on, { cwd = "", exists = (p) => ({ value: existsSync(p) }), run = () => OK, home = HOME } = {}) {
  const toasts = [];
  const runs = [];
  on("fs.exists", (_$, e) => exists(e.path));
  on("session.cwd", () => (typeof cwd === "string" ? { value: cwd } : cwd));
  on("env.get", (_$, e) => (typeof home === "object" && home ? home : { value: e.name === "HOME" && home !== null ? home : undefined }));
  on("process.run", (_$, e) => {
    runs.push({ argv: [...e.argv], init: { ...e.init } });
    return run(e.argv);
  });
  on("ui.toast", (_$, e) => {
    toasts.push({ ...e });
    return { value: undefined };
  });
  on("session.start", () => NEXT);
  on("classic.CwdChanged", () => NEXT);
  on("tool.call", () => ({ result: NEXT }));
  const clock = mock.clock(on);
  /** Fires `event` as Claude Code, waits until the detached check has settled, resolves to the event's result. */
  const fire = async (event, e = {}) => {
    const [ns, name] = event.split(".");
    const r = await $[ns][name](e);
    await clock.settle();
    return r;
  };
  return { fire, toasts, runs };
}

plainTest("registers exactly session.start, classic.CwdChanged and tool.call for EnterWorktree/ExitWorktree", () => {
  const out = [];
  register((event, a, b) => out.push(b === undefined ? { event, matcher: undefined, hook: a } : { event, matcher: a, hook: b }));
  assert.deepEqual(
    out.map(({ event, matcher }) => ({ event, matcher })),
    [
      { event: "session.start", matcher: undefined },
      { event: "classic.CwdChanged", matcher: undefined },
      { event: "tool.call", matcher: { tool: "EnterWorktree" } },
      { event: "tool.call", matcher: { tool: "ExitWorktree" } },
    ],
  );
  for (const h of out) assert.equal(typeof h.hook, "function");
});

test("no config in the cwd or above (up to .git) -> no process.run and no toast on every hook path", async ($, on) => {
  const dir = repo();
  const { fire, runs, toasts } = setup($, on, { cwd: dir, run: () => DENY });
  assert.equal(await fire("session.start"), NEXT);
  assert.equal(await fire("classic.CwdChanged", { new_cwd: dir }), NEXT);
  assert.deepEqual(await fire("tool.call", { tool: "EnterWorktree" }), { result: NEXT });
  assert.deepEqual(await fire("tool.call", { tool: "ExitWorktree" }), { result: NEXT });
  assert.deepEqual(runs, []);
  assert.deepEqual(toasts, []);
});

for (const name of CONFIG_NAMES) {
  test(`config ${name} in the cwd -> probed with dprint --version first; dprint runs -> no toast`, async ($, on) => {
    const dir = withConfig(repo(), name);
    const { fire, runs, toasts } = setup($, on, { cwd: dir });
    await fire("session.start");
    assert.deepEqual(runs, [{ argv: PATH_ARGV, init: PROBE_INIT }]);
    assert.deepEqual(toasts, []);
  });
}

test("a config in an ancestor below the git root counts; above the git root it does not; a worktree is its own root", async ($, on) => {
  const outer = withConfig(repo()); // above the repo root: must not count
  const root = path.join(outer, "repo");
  mkdirSync(path.join(root, ".git"), { recursive: true });
  const sub = path.join(root, "pkg");
  const sub2 = path.join(root, "pkg2");
  mkdirSync(sub);
  mkdirSync(sub2);
  const wt = path.join(root, "wt");
  mkdirSync(path.join(wt, "src"), { recursive: true });
  writeFileSync(path.join(wt, ".git"), "gitdir: elsewhere\n");
  const { fire, runs, toasts } = setup($, on, { run: () => DENY });
  await fire("classic.CwdChanged", { new_cwd: sub });
  assert.deepEqual(runs, [], "config above the git root -> not probed");
  assert.deepEqual(toasts, []);
  withConfig(root); // at the repo root: counts for pkg2
  await fire("classic.CwdChanged", { new_cwd: sub2 });
  assert.equal(runs.length, 3, "config in an ancestor -> probed");
  assert.deepEqual(toasts.map((t) => t.text), [toastText(sub2)]);
  // the failed probe is cached, so a found config would toast again: no new toast proves the walk stopped at wt
  await fire("classic.CwdChanged", { new_cwd: path.join(wt, "src") });
  assert.equal(toasts.length, 1, "a worktree (.git file) is its own root");
});

test("dprint not on PATH, ~/.dprint/bin/dprint runs -> no toast; probed as $HOME/.dprint/bin/dprint --version", async ($, on) => {
  const dir = withConfig(repo());
  const { fire, runs, toasts } = setup($, on, { cwd: dir, run: (argv) => (argv[0] === HOME_DPRINT ? OK : DENY) });
  await fire("session.start");
  assert.deepEqual(runs.map((r) => r.argv), [PATH_ARGV, [HOME_DPRINT, "--version"]]);
  assert.deepEqual(toasts, []);
});

test("HOME unset -> the ~/.dprint/bin step is skipped and npx is tried next", async ($, on) => {
  const dir = withConfig(repo());
  const { fire, runs, toasts } = setup($, on, { cwd: dir, home: null, run: (argv) => (argv[0] === "npx" ? OK : DENY) });
  await fire("session.start");
  assert.deepEqual(runs.map((r) => r.argv), [PATH_ARGV, NPX_ARGV]);
  assert.deepEqual(toasts, []);
});

test("PATH and ~/.dprint/bin fail, npx --yes dprint runs -> no toast; every probe has a 10 s timeout", async ($, on) => {
  const dir = withConfig(repo());
  const { fire, runs, toasts } = setup($, on, { cwd: dir, run: (argv) => (argv[0] === "npx" ? OK : EXIT_1) });
  await fire("session.start");
  assert.deepEqual(runs, [
    { argv: PATH_ARGV, init: PROBE_INIT },
    { argv: [HOME_DPRINT, "--version"], init: PROBE_INIT },
    { argv: NPX_ARGV, init: PROBE_INIT },
  ]);
  assert.deepEqual(toasts, []);
});

test("all three probes fail (deny, exit 1, no dprint version) -> exactly one 15 s toast naming the dir and /dprint:dprint init", async ($, on) => {
  const dir = withConfig(repo());
  const results = { dprint: DENY, [HOME_DPRINT]: EXIT_1, npx: NOT_DPRINT };
  const { fire, runs, toasts } = setup($, on, { cwd: dir, run: (argv) => results[argv[0]] });
  await fire("session.start");
  assert.equal(runs.length, 3);
  assert.deepEqual(toasts, [{ text: toastText(dir), timeoutMs: 15000 }]);
  assert.ok(toasts[0].text.includes(dir));
  assert.ok(toasts[0].text.includes("/dprint:dprint init"));
});

test("every process.run rejecting counts as 'cannot run' -> toast", async ($, on) => {
  const dir = withConfig(repo());
  const { fire, runs, toasts } = setup($, on, { cwd: dir, run: () => DENY });
  assert.deepEqual(await fire("tool.call", { tool: "ExitWorktree" }), { result: NEXT });
  assert.equal(runs.length, 3);
  assert.deepEqual(toasts, [{ text: toastText(dir), timeoutMs: 15000 }]);
});

test("the same dir within 15 s is toasted once across hooks; a trailing separator does not bypass the dedupe", async ($, on) => {
  const dir = withConfig(repo());
  const { fire, toasts } = setup($, on, { cwd: dir, run: () => DENY });
  await fire("tool.call", { tool: "EnterWorktree" });
  await fire("classic.CwdChanged", { new_cwd: dir });
  await fire("classic.CwdChanged", { new_cwd: dir + "/" });
  assert.equal(toasts.length, 1);
});

test("worktree tools check the dir their result names; CwdChanged checks new_cwd and does nothing without one", async ($, on) => {
  const stale = withConfig(repo()); // the session cwd: has a config, must never be the dir checked
  const bare = repo();
  const restored = withConfig(repo());
  const moved = withConfig(repo());
  const { fire, runs, toasts } = setup($, on, { cwd: stale, run: () => DENY });
  await fire("tool.call", { tool: "EnterWorktree", tool_response: { worktreePath: bare } });
  assert.deepEqual(runs, []);
  assert.deepEqual(toasts, []);
  await fire("tool.call", { tool: "ExitWorktree", tool_response: { restoredCwd: restored } });
  assert.deepEqual(toasts.map((t) => t.text), [toastText(restored)]);
  await fire("classic.CwdChanged", { new_cwd: bare });
  await fire("classic.CwdChanged", {});
  assert.equal(toasts.length, 1);
  await fire("classic.CwdChanged", { new_cwd: moved });
  assert.deepEqual(toasts.map((t) => t.text), [toastText(restored), toastText(moved)]);
});

test("a successful probe is cached: a second config dir spawns nothing", async ($, on) => {
  const a = withConfig(repo());
  const b = withConfig(repo());
  const { fire, runs, toasts } = setup($, on);
  await fire("classic.CwdChanged", { new_cwd: a });
  await fire("classic.CwdChanged", { new_cwd: b });
  assert.equal(runs.length, 1);
  assert.deepEqual(toasts, []);
});

test("a failed probe is cached for 30 s (the new dir still gets its toast), then re-probed", async ($, on) => {
  // kit test bodies get ($, on), not vitest's context: restore the clock in finally
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const T0 = Date.UTC(2026, 10, 5, 12);
    vi.setSystemTime(T0);
    const a = withConfig(repo());
    const b = withConfig(repo());
    const c = withConfig(repo());
    let result = DENY;
    const { fire, runs, toasts } = setup($, on, { run: () => result });
    await fire("classic.CwdChanged", { new_cwd: a });
    assert.equal(runs.length, 3);
    vi.setSystemTime(T0 + 10_000);
    await fire("classic.CwdChanged", { new_cwd: b });
    assert.equal(runs.length, 3, "within 30 s: no re-probe");
    assert.deepEqual(toasts.map((t) => t.text), [toastText(a), toastText(b)]);
    vi.setSystemTime(T0 + 31_000);
    result = OK;
    await fire("classic.CwdChanged", { new_cwd: c });
    assert.equal(runs.length, 4, "after 31 s: re-probed, dprint on PATH runs");
    assert.equal(toasts.length, 2);
  } finally {
    vi.useRealTimers();
  }
});

test("concurrent events share one in-flight probe", async ($, on) => {
  const dir = withConfig(repo());
  const { toasts, runs } = setup($, on, { cwd: dir, run: () => DENY });
  const clock = mock.clock(on);
  await Promise.all([$.session.start({}), $.classic.CwdChanged({ new_cwd: dir })]);
  await clock.settle();
  assert.equal(runs.length, 3, "one probe (3 argvs), not two");
  assert.equal(toasts.length, 1);
});

test("a rejecting env.get is cached as a failed probe for 30 s, then re-probed; no toast", async ($, on) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const T0 = Date.UTC(2026, 10, 5, 12);
    vi.setSystemTime(T0);
    const a = withConfig(repo());
    const b = withConfig(repo());
    const { fire, runs, toasts } = setup($, on, { home: { deny: "boom" }, run: () => DENY });
    await fire("classic.CwdChanged", { new_cwd: a });
    assert.equal(runs.length, 1, "PATH probe, then env.get rejects");
    vi.setSystemTime(T0 + 10_000);
    await fire("classic.CwdChanged", { new_cwd: b });
    assert.equal(runs.length, 1, "within 30 s: no re-probe");
    vi.setSystemTime(T0 + 31_000);
    await fire("classic.CwdChanged", { new_cwd: b });
    assert.equal(runs.length, 2, "after 31 s: re-probed");
    assert.deepEqual(toasts, []);
  } finally {
    vi.useRealTimers();
  }
});

test("dprint --version output with leading whitespace still counts as dprint", async ($, on) => {
  const dir = withConfig(repo());
  const { fire, toasts } = setup($, on, { cwd: dir, run: () => ({ value: { exitCode: 0, stdout: "\n dprint 0.50.0\n", stderr: "" } }) });
  await fire("session.start");
  assert.deepEqual(toasts, []);
});

test("the hook returns next's result unchanged; a rejecting fs.exists -> no throw, no probe, no toast", async ($, on) => {
  const dir = repo();
  const { fire, runs, toasts } = setup($, on, { cwd: dir, exists: () => ({ deny: "boom" }), run: () => DENY });
  assert.equal(await fire("session.start"), NEXT);
  assert.equal(await fire("classic.CwdChanged", { new_cwd: dir }), NEXT);
  assert.deepEqual(await fire("tool.call", { tool: "EnterWorktree" }), { result: NEXT });
  assert.deepEqual(await fire("tool.call", { tool: "ExitWorktree" }), { result: NEXT });
  assert.deepEqual(runs, []);
  assert.deepEqual(toasts, []);
});

test("a rejecting session.cwd -> next's result unchanged, no throw, no toast", async ($, on) => {
  const { fire, toasts } = setup($, on, { cwd: { deny: "boom" }, run: () => DENY });
  assert.equal(await fire("session.start"), NEXT);
  assert.deepEqual(await fire("tool.call", { tool: "EnterWorktree" }), { result: NEXT });
  assert.deepEqual(await fire("tool.call", { tool: "ExitWorktree" }), { result: NEXT });
  assert.deepEqual(toasts, []);
});

plainTest("the module's inlined config names equal the shared CONFIG_NAMES; no imports", () => {
  assert.equal(CONFIG_NAMES.length, 6);
  const src = readFileSync(path.join(PLUGIN, "hooks/notice.mjs"), "utf8");
  const m = /CONFIG_NAMES=(\[[^\]]*\])/.exec(src);
  assert.ok(m, "inlined CONFIG_NAMES");
  assert.deepEqual(JSON.parse(m[1]), [...CONFIG_NAMES]);
  assert.doesNotMatch(src, /^import/m);
});

plainTest("the probe constants and version regex equal find-dprint's", () => {
  const read = (f) => readFileSync(path.join(PLUGIN, "..", "src", f), "utf8");
  const notice = read("hooks/notice.mts");
  const find = read("skills/dprint/find-dprint.mts");
  const num = (src, name) => new RegExp(`const ${name} = ([\\d_]+);`).exec(src)?.[1];
  assert.ok(num(find, "NPX_PROBE_TIMEOUT_MS"));
  assert.equal(num(notice, "PROBE_TIMEOUT_MS"), num(find, "NPX_PROBE_TIMEOUT_MS"));
  assert.ok(num(find, "NPX_RETRY_MS"));
  assert.equal(num(notice, "PROBE_RETRY_MS"), num(find, "NPX_RETRY_MS"));
  assert.ok(find.includes("/^dprint \\d/") && notice.includes("/^dprint \\d/"), "version regex");
  assert.ok(find.includes('["--yes", "dprint"]') && notice.includes('["npx", "--yes", "dprint", "--version"]'), "npx argv");
  assert.ok(find.includes('join(homedir(), ".dprint", "bin", "dprint")') && notice.includes("${home}/.dprint/bin/dprint"), "home path");
});

plainTest("built module keeps the names Claude Code's static check needs (no mangling)", () => {
  const src = readFileSync(path.join(PLUGIN, "hooks/notice.mjs"), "utf8");
  assert.match(src, /export const register=on=>/);
  assert.match(src, /async function onSessionCwd\(\$,e,next\)/);
  assert.match(src, /async function onCwdChanged\(\$,e,next\)/);
  assert.match(src, /\$\.fs\.exists\(/);
  assert.match(src, /\$\.ui\.toast\(/);
  assert.match(src, /\$\.session\.cwd\(\)/);
  assert.match(src, /\$\.process\.run\(/);
  assert.match(src, /\$\.env\.get\("HOME"\)/);
});
