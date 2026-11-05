// Tests for the built plugin/hooks/notice.mjs (Claude Code function-hooks module) on claude-engine-vitest, the
// workspace's vitest stand-in for the official `claude-code/testing` kit: stubs answer fs.exists (backed by node:fs),
// session.cwd, env.get, process.run and ui.toast, and mock.clock(on).settle() waits for the detached check. The
// first test records the registration list by hand (the kit does not expose it); the last three read the built file.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, test as plainTest, vi } from "vitest";
import { createKit } from "claude-engine-vitest";
import { register } from "../plugin/hooks/notice.mjs";
import { CONFIG_NAMES } from "../plugin/skills/dprint/config-names.mjs";

const { test, mock } = createKit({ module: new URL("../plugin/hooks/notice.mjs", import.meta.url), plugin: "dprint" });

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugin");
const HOME = "/home/u";
const HOME_DPRINT = `${HOME}/.dprint/bin/dprint`;
const PATH_DIRS = "/p1:/p2";
const PATH_DPRINT = "/p1/dprint";
const PATH_ARGV = [PATH_DPRINT, "--version"];
const NPX_ARGV = ["npx", "--no", "--prefer-offline", "--", "dprint", "--version"];
const PROBE_INIT = { cwd: HOME, timeoutMs: 10000 };
const ver = (stdout) => ({ value: { exitCode: 0, stdout, stderr: "" } });
const OK = ver("dprint 0.50.0\n");
const EXIT_1 = { value: { exitCode: 1, stdout: "", stderr: "" } };
const NOT_DPRINT = ver("not dprint\n");
// a deny rejects the mod's $.process.run: stands for "the program cannot start"
const DENY = { deny: "spawn ENOENT" };
const NEXT = "next-result";
const T0 = Date.UTC(2026, 10, 5, 12);
const NOT_INSTALLED_TEXT = "no dprint is installed (none on PATH, in ~/.dprint/bin or in the npx cache)";
const COULD_NOT_START = `${PATH_DPRINT} could not start or took over 10 s to answer --version`;

// Date is faked in every test so the 15 s toast window can be stepped past with vi.setSystemTime
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

const dirs = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A fresh dir holding a `.git` dir: the config walk stops there, so no stray config above os.tmpdir() leaks in. */
function repo() {
  const d = mkdtempSync(path.join(tmpdir(), "dprint-notice-"));
  dirs.push(d);
  mkdirSync(path.join(d, ".git"));
  return d;
}

/** Writes the dprint config `name` into `dir` and returns `dir`. */
function withConfig(dir, name = "dprint.json") {
  mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  writeFileSync(path.join(dir, name), "{}");
  return dir;
}

/** The toast text the module shows for `dir`; `problem` is the part after "but". */
const toastText = (dir, problem = NOT_INSTALLED_TEXT) => `dprint: ${dir} has a dprint config but ${problem}; run /dprint:dprint init`;

/**
 * Registers every stub (before the test's first `$` call, as the kit requires) and returns what the module did.
 * `cwd`: session.cwd's answer, a string or a `{ deny }`; `exists(path)` and `run(argv)` return a stub result;
 * `home: null` leaves HOME unset, `home: { deny }` rejects env.get; `path` is the env PATH (`null` = unset);
 * `bins` are the fake executables fs.exists reports (every other path is answered by node:fs).
 */
function setup($, on, { cwd = "", exists, run = () => OK, home = HOME, path: pathVar = PATH_DIRS, bins = [PATH_DPRINT] } = {}) {
  const exist = exists ?? ((p) => ({ value: bins.includes(p) || existsSync(p) }));
  const toasts = [];
  const runs = [];
  const envGets = [];
  on("fs.exists", (_$, e) => exist(e.path));
  on("session.cwd", () => (typeof cwd === "string" ? { value: cwd } : cwd));
  on("env.get", (_$, e) => {
    envGets.push(e.name);
    if (typeof home === "object" && home) return home;
    const value = e.name === "HOME" ? (home ?? undefined) : e.name === "PATH" ? (pathVar ?? undefined) : undefined;
    return { value };
  });
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
  return { fire, clock, toasts, runs, envGets };
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
  test(`config ${name} in the cwd -> the PATH dprint is probed with --version; it runs -> no toast`, async ($, on) => {
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
  assert.equal(runs.length, 1, "config in an ancestor -> probed (the one pick)");
  assert.deepEqual(toasts.map((t) => t.text), [toastText(sub2, COULD_NOT_START)]);
  // the failed probe is cached and the toast window is over, so a found config would toast again: no new toast
  // proves the walk stopped at wt
  vi.setSystemTime(T0 + 16_000);
  await fire("classic.CwdChanged", { new_cwd: path.join(wt, "src") });
  assert.equal(toasts.length, 1, "a worktree (.git file) is its own root");
});

test("nothing on PATH, ~/.dprint/bin/dprint exists -> it is the pick: probed as $HOME/.dprint/bin/dprint --version, no toast", async ($, on) => {
  const dir = withConfig(repo());
  const { fire, runs, toasts } = setup($, on, { cwd: dir, bins: [HOME_DPRINT] });
  await fire("session.start");
  assert.deepEqual(runs.map((r) => r.argv), [[HOME_DPRINT, "--version"]]);
  assert.deepEqual(toasts, []);
});

test("HOME unset -> the ~/.dprint/bin step is skipped, npx is probed; probes run in /", async ($, on) => {
  const dir = withConfig(repo());
  const { fire, runs, toasts } = setup($, on, { cwd: dir, home: null, bins: [] });
  await fire("session.start");
  assert.deepEqual(runs, [{ argv: NPX_ARGV, init: { cwd: "/", timeoutMs: 10000 } }]);
  assert.deepEqual(toasts, []);
});

test("no PATH or ~/.dprint/bin dprint, a cached npx dprint runs (--no: never downloads) -> no toast; probed in HOME with a 10 s timeout", async ($, on) => {
  const dir = withConfig(repo());
  const { fire, runs, toasts } = setup($, on, { cwd: dir, bins: [] });
  await fire("session.start");
  assert.deepEqual(runs, [{ argv: NPX_ARGV, init: PROBE_INIT }]);
  assert.deepEqual(toasts, []);
});

const REASONS = [
  ["cannot start or times out", DENY, COULD_NOT_START],
  ["exits non-zero", EXIT_1, `${PATH_DPRINT} --version exited 1`],
  ["prints no dprint version", NOT_DPRINT, `${PATH_DPRINT} --version printed no dprint version`],
  ["is 0.49.0", ver("dprint 0.49.0\n"), `${PATH_DPRINT} is dprint 0.49.0, the plugin needs >= 0.50.0`],
  ["is 0.50.0-rc.1 (prerelease of the minimum)", ver("dprint 0.50.0-rc.1\n"), `${PATH_DPRINT} is dprint 0.50.0-rc.1, the plugin needs >= 0.50.0`],
  ["prints a bare major version", ver("dprint 1\n"), `${PATH_DPRINT} --version printed no dprint version`],
];
for (const [label, result, problem] of REASONS) {
  test(`the PATH pick ${label} -> one 15 s toast with that cause`, async ($, on) => {
    const dir = withConfig(repo());
    const { fire, runs, toasts } = setup($, on, { cwd: dir, run: () => result });
    await fire("session.start");
    assert.deepEqual(runs.map((r) => r.argv), [PATH_ARGV]);
    assert.deepEqual(toasts, [{ text: toastText(dir, problem), timeoutMs: 15000 }]);
  });
}

for (const out of ["dprint 0.50.0", "dprint 1.0.0", "\n dprint 0.50.0\n"]) {
  test(`the PATH pick prints ${JSON.stringify(out)} -> usable, no toast`, async ($, on) => {
    const dir = withConfig(repo());
    const { fire, toasts } = setup($, on, { cwd: dir, run: () => ver(out) });
    await fire("session.start");
    assert.deepEqual(toasts, []);
  });
}

const NPX_CASES = [
  ["a failing npx", EXIT_1, NOT_INSTALLED_TEXT],
  ["a non-starting or timed-out npx", DENY, "npx could not start or took over 10 s to answer --version"],
  ["a cached dprint printing no version", NOT_DPRINT, "npx --version printed no dprint version"],
  ["an old cached dprint", ver("dprint 0.49.0\n"), "npx is dprint 0.49.0, the plugin needs >= 0.50.0"],
];
for (const [label, result, problem] of NPX_CASES) {
  test(`npx leg: ${label} -> toast "${problem}"`, async ($, on) => {
    const dir = withConfig(repo());
    const { fire, runs, toasts } = setup($, on, { cwd: dir, bins: [], run: () => result });
    await fire("session.start");
    assert.deepEqual(runs.map((r) => r.argv), [NPX_ARGV]);
    assert.deepEqual(toasts, [{ text: toastText(dir, problem), timeoutMs: 15000 }]);
  });
}

test("a broken PATH dprint is judged alone: no fall-through to a working ~/.dprint/bin one (what findDprint would pick)", async ($, on) => {
  const dir = withConfig(repo());
  const { fire, runs, toasts } = setup($, on, {
    cwd: dir,
    bins: [PATH_DPRINT, HOME_DPRINT],
    run: (argv) => (argv[0] === PATH_DPRINT ? EXIT_1 : OK),
  });
  await fire("session.start");
  assert.deepEqual(runs.map((r) => r.argv), [PATH_ARGV]);
  assert.deepEqual(toasts, [{ text: toastText(dir, `${PATH_DPRINT} --version exited 1`), timeoutMs: 15000 }]);
});

const PICK_CASES = [
  ["/p0:/p1", [PATH_DPRINT], "/p1/dprint", "the first existing entry"],
  ["/p0:/p1", ["/p0/dprint", PATH_DPRINT], "/p0/dprint", "the earlier entry wins"],
  ["relative:/p1", ["relative/dprint", PATH_DPRINT], "/p1/dprint", "a relative entry is skipped"],
  ["::/p1", [PATH_DPRINT], "/p1/dprint", "empty entries are skipped"],
  ["/p1/", [PATH_DPRINT], "/p1/dprint", "a trailing slash is stripped"],
];
for (const [pathVar, bins, pick, label] of PICK_CASES) {
  test(`PATH pick order: ${label} (PATH=${pathVar})`, async ($, on) => {
    const dir = withConfig(repo());
    const { fire, runs } = setup($, on, { cwd: dir, path: pathVar, bins, run: () => EXIT_1 });
    await fire("session.start");
    assert.deepEqual(runs.map((r) => r.argv), [[pick, "--version"]]);
  });
}

test("PATH unset -> no PATH candidates, the ~/.dprint/bin step decides", async ($, on) => {
  const dir = withConfig(repo());
  const { fire, runs } = setup($, on, { cwd: dir, path: null, bins: [HOME_DPRINT, PATH_DPRINT] });
  await fire("session.start");
  assert.deepEqual(runs.map((r) => r.argv), [[HOME_DPRINT, "--version"]]);
});

test("one toast per 15 s across hooks and dirs (the cause is machine-wide), the next one after 15 s", async ($, on) => {
  const dir = withConfig(repo());
  const other = withConfig(repo());
  const { fire, toasts } = setup($, on, { cwd: dir, run: () => DENY });
  await fire("tool.call", { tool: "EnterWorktree" });
  await fire("classic.CwdChanged", { new_cwd: dir });
  await fire("classic.CwdChanged", { new_cwd: other });
  assert.equal(toasts.length, 1);
  vi.setSystemTime(T0 + 16_000);
  await fire("classic.CwdChanged", { new_cwd: other });
  assert.deepEqual(toasts.map((t) => t.text), [toastText(dir, COULD_NOT_START), toastText(other, COULD_NOT_START)]);
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
  assert.deepEqual(toasts.map((t) => t.text), [toastText(restored, COULD_NOT_START)]);
  await fire("classic.CwdChanged", { new_cwd: bare });
  await fire("classic.CwdChanged", {});
  assert.equal(toasts.length, 1);
  vi.setSystemTime(T0 + 16_000); // past the toast window
  await fire("classic.CwdChanged", { new_cwd: moved });
  assert.deepEqual(toasts.map((t) => t.text), [toastText(restored, COULD_NOT_START), toastText(moved, COULD_NOT_START)]);
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
  const a = withConfig(repo());
  const b = withConfig(repo());
  const c = withConfig(repo());
  let result = DENY;
  const { fire, runs, toasts } = setup($, on, { run: () => result });
  await fire("classic.CwdChanged", { new_cwd: a });
  assert.equal(runs.length, 1);
  vi.setSystemTime(T0 + 16_000);
  await fire("classic.CwdChanged", { new_cwd: b });
  assert.equal(runs.length, 1, "within 30 s: no re-probe");
  assert.deepEqual(toasts.map((t) => t.text), [toastText(a, COULD_NOT_START), toastText(b, COULD_NOT_START)]);
  vi.setSystemTime(T0 + 31_000);
  result = OK;
  await fire("classic.CwdChanged", { new_cwd: c });
  assert.equal(runs.length, 2, "after 31 s: re-probed, the PATH dprint runs");
  assert.equal(toasts.length, 2);
});

test("concurrent events share one in-flight probe", async ($, on) => {
  const dir = withConfig(repo());
  const { clock, toasts, runs } = setup($, on, { cwd: dir, run: () => DENY });
  await Promise.all([$.session.start({}), $.classic.CwdChanged({ new_cwd: dir })]);
  await clock.settle();
  assert.equal(runs.length, 1, "one probe (1 argv), not two");
  assert.equal(toasts.length, 1);
});

test("a rejecting env.get is cached as a failed probe for 30 s, then re-probed; no toast", async ($, on) => {
  const a = withConfig(repo());
  const b = withConfig(repo());
  const { fire, runs, toasts, envGets } = setup($, on, { home: { deny: "boom" }, run: () => DENY });
  await fire("classic.CwdChanged", { new_cwd: a });
  assert.equal(envGets.length, 2, "HOME and PATH are read together and both reject before any probe");
  vi.setSystemTime(T0 + 10_000);
  await fire("classic.CwdChanged", { new_cwd: b });
  assert.equal(envGets.length, 2, "within 30 s: no re-probe");
  vi.setSystemTime(T0 + 31_000);
  await fire("classic.CwdChanged", { new_cwd: b });
  assert.equal(envGets.length, 4, "after 31 s: re-probed");
  assert.deepEqual(runs, []);
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
  const src = readFileSync(path.join(PLUGIN, "hooks/notice.mjs"), "utf8");
  const m = /CONFIG_NAMES=(\[[^\]]*\])/.exec(src);
  assert.ok(m, "inlined CONFIG_NAMES");
  assert.deepEqual(JSON.parse(m[1]), [...CONFIG_NAMES]);
  assert.doesNotMatch(src, /^import/m);
});

plainTest("the probe constants, MIN_VERSION and version regex equal the shared sources'", () => {
  const read = (f) => readFileSync(path.join(PLUGIN, "..", "src", f), "utf8");
  const notice = read("hooks/notice.mts");
  const find = read("skills/dprint/find-dprint.mts");
  const check = read("skills/dprint/check-dprint.mts");
  const num = (src, name) => new RegExp(`const ${name} = ([\\d_]+);`).exec(src)?.[1];
  assert.ok(num(find, "NPX_PROBE_TIMEOUT_MS"));
  assert.equal(num(notice, "PROBE_TIMEOUT_MS"), num(find, "NPX_PROBE_TIMEOUT_MS"));
  assert.ok(num(find, "NPX_RETRY_MS"));
  assert.equal(num(notice, "PROBE_RETRY_MS"), num(find, "NPX_RETRY_MS"));
  const min = (src) => /^const MIN_VERSION = "([0-9.]+)";$/m.exec(src)?.[1];
  assert.ok(min(check));
  assert.equal(min(notice), min(check));
  const versionRe = "/^dprint (\\d+)\\.(\\d+)\\.(\\d+)(-\\S+)?/";
  assert.ok(check.includes(versionRe) && notice.includes(versionRe), "version regex");
  assert.ok(find.includes('["--yes", "dprint"]') && notice.includes('["npx", "--no", "--prefer-offline", "--", "dprint", "--version"]'), "npx argv (notice never downloads)");
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
  assert.match(src, /\$\.env\.get\("PATH"\)/);
});
