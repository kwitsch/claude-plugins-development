// Unit tests of the function-hooks module (src/hooks/register.ts) on claude-engine-vitest, the workspace's vitest
// stand-in for the official `claude-code/testing` kit: stubs answer fs.exists (backed by node:fs), session.cwd, env.get,
// process.run and ui.toast, and mock.clock(on).settle() waits for the detached check. The first test records the
// registration list by hand (the kit does not expose it); one test reads the built register.js.
import { createKit } from "claude-engine-vitest";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, test as plainTest, vi } from "vitest";
import { CONFIG_NAMES as PROBE_CONFIG_NAMES } from "../src/hooks/probe.ts";
import { register } from "../src/hooks/register.ts";
import { CONFIG_NAMES } from "../src/skills/dprint/config-names.ts";

const { test, mock } = createKit({ module: new URL("../src/hooks/register.ts", import.meta.url), plugin: "dprint" });

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
const NOT_INSTALLED_TEXT = "no dprint is installed (none on PATH, in $DPRINT_INSTALL/bin (default ~/.dprint/bin) or in the npx cache)";
const COULD_NOT_START = `${PATH_DPRINT} could not start or took over 10 s to answer --version`;

// Date is faked in every test so the 15 s toast window can be stepped past with vi.setSystemTime
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A fresh dir holding a `.git` dir: the config walk stops there, so no stray config above os.tmpdir() leaks in. */
function repo() {
  const d = mkdtempSync(path.join(tmpdir(), "dprint-notice-"));
  dirs.push(d);
  mkdirSync(path.join(d, ".git"));
  return d;
}

/** Writes the dprint config `name` into `dir` and returns `dir`. */
function withConfig(dir: string, name = "dprint.json") {
  mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  writeFileSync(path.join(dir, name), "{}");
  return dir;
}

/** The toast text the module shows for `dir`; `problem` is the part after "but". */
const toastText = (dir, problem = NOT_INSTALLED_TEXT) => `dprint: ${dir} (or a parent up to the git root) has a dprint config but ${problem}; run /dprint:dprint init`;

/** What `setup` stubs; see its comment. */
interface SetupOptions {
  /** session.cwd's initial answer: a string or a `{ deny }`; `bashIn` changes it. */
  cwd?: unknown;
  /** fs.exists' stub result for a path. */
  exists?: (p: string) => unknown;
  /** process.run's stub result for an argv. */
  run?: (argv: string[]) => unknown;
  /** HOME: `null` = unset, `{ deny }` rejects env.get. */
  home?: unknown;
  /** The env PATH (`null` = unset). */
  path?: string | null;
  /** The fake executables fs.exists reports. */
  bins?: string[];
  /** A tool's output as the engine hands it back in the chain's `{ result }`; default: the plain next result. */
  toolResult?: (e: Record<string, unknown>) => unknown;
  /** DPRINT_INSTALL (default unset). */
  install?: string;
}

/**
 * Registers every stub (before the test's first `$` call, as the kit requires) and returns what the module did.
 * `cwd`: session.cwd's initial answer, a string or a `{ deny }` (read at call time, so `bashIn` can move it);
 * `exists(path)` and `run(argv)` return a stub result; `home: null` leaves HOME unset, `home: { deny }` rejects
 * env.get; `path` is the env PATH (`null` = unset); `bins` are the fake executables fs.exists reports (every other
 * path is answered by node:fs). `cwdReads()` and `existsCalls()` count the session.cwd and fs.exists calls so far.
 */
function setup($, on, { cwd = "", exists, run = () => OK, home = HOME, path: pathVar = PATH_DIRS, bins = [PATH_DPRINT], toolResult = () => NEXT, install }: SetupOptions = {}) {
  const exist = exists ?? ((p) => ({ value: p === HOME || bins.includes(p) || existsSync(p) }));
  const toasts: { text: string; timeoutMs?: number }[] = [];
  const runs: { argv: string[]; init: Record<string, unknown> }[] = [];
  const envGets: string[] = [];
  let current: unknown = cwd;
  let cwdCount = 0;
  let existsCount = 0;
  on("fs.exists", (_$, e) => {
    existsCount++;
    return exist(e.path);
  });
  on("session.cwd", () => {
    cwdCount++;
    return typeof current === "string" ? { value: current } : current;
  });
  on("env.get", (_$, e) => {
    envGets.push(e.name);
    if (typeof home === "object" && home) return home;
    const value = e.name === "HOME" ? (home ?? undefined) : e.name === "PATH" ? (pathVar ?? undefined) : e.name === "DPRINT_INSTALL" ? install : undefined;
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
  on("tool.call", (_$, e) => ({ result: toolResult(e) }));
  const clock = mock.clock(on);
  /** Fires `event` as Claude Code, waits until the detached check has settled, resolves to the event's result. */
  const fire = async (event, e = {}) => {
    const [ns, name] = event.split(".");
    const r = await $[ns][name](e);
    await clock.settle();
    return r;
  };
  /** A Bash call that leaves the session in `dir` (session.cwd answers it from now on); resolves to the call's result. */
  const bashIn = (dir: unknown) => {
    current = dir;
    return fire("tool.call", { tool: "Bash", command: "cd somewhere" });
  };
  return { fire, bashIn, clock, toasts, runs, envGets, cwdReads: () => cwdCount, existsCalls: () => existsCount };
}

plainTest("registers exactly session.start and tool.call for Bash, EnterWorktree and ExitWorktree", () => {
  const out: { event: string; matcher: unknown; hook: unknown }[] = [];
  register((event: string, a: unknown, b?: unknown) => {
    out.push(b === undefined ? { event, matcher: undefined, hook: a } : { event, matcher: a, hook: b });
  });
  assert.deepEqual(
    out.map(({ event, matcher }) => ({ event, matcher })),
    [
      { event: "session.start", matcher: undefined },
      { event: "tool.call", matcher: { tool: "Bash" } },
      { event: "tool.call", matcher: { tool: "EnterWorktree" } },
      { event: "tool.call", matcher: { tool: "ExitWorktree" } },
    ],
  );
  for (const h of out) assert.equal(typeof h.hook, "function");
});

test("no config in the cwd or above (up to .git) -> no process.run and no toast on every hook path", async ($, on) => {
  const dir = repo();
  const { fire, bashIn, runs, toasts } = setup($, on, { cwd: dir, run: () => DENY });
  assert.equal(await fire("session.start"), NEXT);
  assert.deepEqual(await bashIn(dir), { result: NEXT });
  assert.deepEqual(await fire("tool.call", { tool: "EnterWorktree" }), { result: NEXT });
  assert.deepEqual(await fire("tool.call", { tool: "ExitWorktree" }), { result: NEXT });
  assert.deepEqual(runs, []);
  assert.equal(toasts.length, 0);
});

for (const name of CONFIG_NAMES) {
  test(`config ${name} in the cwd -> the PATH dprint is probed with --version; it runs -> no toast`, async ($, on) => {
    const dir = withConfig(repo(), name);
    const { fire, runs, toasts } = setup($, on, { cwd: dir });
    await fire("session.start");
    assert.deepEqual(runs, [{ argv: PATH_ARGV, init: PROBE_INIT }]);
    assert.equal(toasts.length, 0);
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
  const { bashIn, runs, toasts } = setup($, on, { run: () => DENY });
  await bashIn(sub);
  assert.deepEqual(runs, [], "config above the git root -> not probed");
  assert.equal(toasts.length, 0);
  withConfig(root); // at the repo root: counts for pkg2
  await bashIn(sub2);
  assert.equal(runs.length, 1, "config in an ancestor -> probed (the one pick)");
  assert.deepEqual(toasts.map((t) => t.text), [toastText(sub2, COULD_NOT_START)]);
  // the failed probe is cached and the toast window is over, so a found config would toast again: no new toast
  // proves the walk stopped at wt
  vi.setSystemTime(T0 + 16_000);
  await bashIn(path.join(wt, "src"));
  assert.equal(toasts.length, 1, "a worktree (.git file) is its own root");
});

test("nothing on PATH, ~/.dprint/bin/dprint exists -> it is the pick: probed as $HOME/.dprint/bin/dprint --version, no toast", async ($, on) => {
  const dir = withConfig(repo());
  const { fire, runs, toasts } = setup($, on, { cwd: dir, bins: [HOME_DPRINT] });
  await fire("session.start");
  assert.deepEqual(runs.map((r) => r.argv), [[HOME_DPRINT, "--version"]]);
  assert.equal(toasts.length, 0);
});

test("HOME unset -> the ~/.dprint/bin step is skipped, npx is probed; probes run in /", async ($, on) => {
  const dir = withConfig(repo());
  const { fire, runs, toasts } = setup($, on, { cwd: dir, home: null, bins: [] });
  await fire("session.start");
  assert.deepEqual(runs, [{ argv: NPX_ARGV, init: { cwd: "/", timeoutMs: 10000 } }]);
  assert.equal(toasts.length, 0);
});

test("HOME set to a dir that does not exist -> probes run in /, not in the missing HOME", async ($, on) => {
  const dir = withConfig(repo());
  const { fire, runs, toasts } = setup($, on, { cwd: dir, home: "/nonexistent-dprint-home" });
  await fire("session.start");
  assert.deepEqual(runs, [{ argv: [PATH_DPRINT, "--version"], init: { cwd: "/", timeoutMs: 10000 } }]);
  assert.equal(toasts.length, 0);
});

test("no PATH or ~/.dprint/bin dprint, a cached npx dprint runs (--no: never downloads) -> no toast; probed in HOME with a 10 s timeout", async ($, on) => {
  const dir = withConfig(repo());
  const { fire, runs, toasts } = setup($, on, { cwd: dir, bins: [] });
  await fire("session.start");
  assert.deepEqual(runs, [{ argv: NPX_ARGV, init: PROBE_INIT }]);
  assert.equal(toasts.length, 0);
});

const REASONS: [string, unknown, string][] = [
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
    assert.equal(toasts.length, 0);
  });
}

const NPX_CASES: [string, unknown, string][] = [
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

const PICK_CASES: [string, string[], string, string][] = [
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
  const third = withConfig(repo());
  const { fire, bashIn, toasts } = setup($, on, { cwd: dir, run: () => DENY });
  await fire("tool.call", { tool: "EnterWorktree" });
  await bashIn(dir); // already checked by EnterWorktree: no-op
  // other is recorded as handled during the window and not re-checked later (accepted: the cause was just toasted)
  await bashIn(other);
  assert.equal(toasts.length, 1);
  vi.setSystemTime(T0 + 16_000);
  await bashIn(third);
  assert.deepEqual(toasts.map((t) => t.text), [toastText(dir, COULD_NOT_START), toastText(third, COULD_NOT_START)]);
});

test("worktree tools check the dir their result names; Bash checks the session cwd", async ($, on) => {
  const stale = withConfig(repo()); // the session cwd: has a config, must never be the dir checked
  const bare = repo();
  const restored = withConfig(repo());
  const moved = withConfig(repo());
  const { fire, bashIn, runs, toasts } = setup($, on, { cwd: stale, run: () => DENY });
  await fire("tool.call", { tool: "EnterWorktree", tool_response: { worktreePath: bare } });
  assert.deepEqual(runs, []);
  assert.equal(toasts.length, 0);
  await fire("tool.call", { tool: "ExitWorktree", tool_response: { restoredCwd: restored } });
  assert.deepEqual(toasts.map((t) => t.text), [toastText(restored, COULD_NOT_START)]);
  await bashIn(bare);
  assert.deepEqual(await bashIn({ deny: "boom" }), { result: NEXT }, "a refused session.cwd leaves the Bash result unchanged");
  assert.equal(runs.length, 1);
  assert.equal(toasts.length, 1);
  vi.setSystemTime(T0 + 16_000); // past the toast window
  await bashIn(moved);
  assert.deepEqual(toasts.map((t) => t.text), [toastText(restored, COULD_NOT_START), toastText(moved, COULD_NOT_START)]);
});

for (const tool of ["EnterWorktree", "ExitWorktree"]) {
  test(`${tool} without a dir in its result falls back to the session cwd`, async ($, on) => {
    const dir = withConfig(repo());
    const { fire, toasts } = setup($, on, { cwd: dir, run: () => DENY });
    await fire("tool.call", { tool });
    assert.deepEqual(toasts.map((t) => t.text), [toastText(dir, COULD_NOT_START)]);
  });
}

test("a successful probe is cached: a second config dir spawns nothing", async ($, on) => {
  const a = withConfig(repo());
  const b = withConfig(repo());
  const { bashIn, runs, toasts } = setup($, on);
  await bashIn(a);
  await bashIn(b);
  assert.equal(runs.length, 1);
  assert.equal(toasts.length, 0);
});

test("a failed probe is cached for 30 s (the new dir still gets its toast), then re-probed", async ($, on) => {
  const a = withConfig(repo());
  const b = withConfig(repo());
  const c = withConfig(repo());
  let result: unknown = DENY;
  const { bashIn, runs, toasts } = setup($, on, { run: () => result });
  await bashIn(a);
  assert.equal(runs.length, 1);
  vi.setSystemTime(T0 + 16_000);
  await bashIn(b);
  assert.equal(runs.length, 1, "within 30 s: no re-probe");
  assert.deepEqual(toasts.map((t) => t.text), [toastText(a, COULD_NOT_START), toastText(b, COULD_NOT_START)]);
  vi.setSystemTime(T0 + 31_000);
  result = OK;
  await bashIn(c);
  assert.equal(runs.length, 2, "after 31 s: re-probed, the PATH dprint runs");
  assert.equal(toasts.length, 2);
});

test("concurrent events share one in-flight probe", async ($, on) => {
  const dir = withConfig(repo());
  const { clock, toasts, runs } = setup($, on, { cwd: dir, run: () => DENY });
  // both hooks always check (a Bash call could skip on lastDir and leave the shared probe unexercised)
  await Promise.all([$.session.start({}), $.tool.call({ tool: "EnterWorktree", tool_response: { worktreePath: dir } })]);
  await clock.settle();
  assert.equal(runs.length, 1, "one probe (1 argv), not two");
  assert.equal(toasts.length, 1);
});

test("a rejecting env.get is cached as a failed probe for 30 s, then re-probed; no toast", async ($, on) => {
  const a = withConfig(repo());
  const b = withConfig(repo());
  const c = withConfig(repo());
  const { bashIn, runs, toasts, envGets } = setup($, on, { home: { deny: "boom" }, run: () => DENY });
  await bashIn(a);
  assert.equal(envGets.length, 3, "HOME, PATH and DPRINT_INSTALL are read together and both reject before any probe");
  vi.setSystemTime(T0 + 10_000);
  await bashIn(b);
  assert.equal(envGets.length, 3, "within 30 s: no re-probe");
  vi.setSystemTime(T0 + 31_000);
  await bashIn(c);
  assert.equal(envGets.length, 6, "after 31 s: re-probed");
  assert.deepEqual(runs, []);
  assert.equal(toasts.length, 0);
});

test("the hook returns next's result unchanged; a rejecting fs.exists -> no throw, no probe, no toast", async ($, on) => {
  const dir = repo();
  const { fire, bashIn, runs, toasts } = setup($, on, { cwd: dir, exists: () => ({ deny: "boom" }), run: () => DENY });
  assert.equal(await fire("session.start"), NEXT);
  // a fresh dir, so the walk with the rejecting fs.exists really runs
  assert.deepEqual(await bashIn(repo()), { result: NEXT });
  assert.deepEqual(await fire("tool.call", { tool: "EnterWorktree" }), { result: NEXT });
  assert.deepEqual(await fire("tool.call", { tool: "ExitWorktree" }), { result: NEXT });
  assert.deepEqual(runs, []);
  assert.equal(toasts.length, 0);
});

test("a rejecting session.cwd -> next's result unchanged, no throw, no toast", async ($, on) => {
  const { fire, toasts } = setup($, on, { cwd: { deny: "boom" }, run: () => DENY });
  assert.equal(await fire("session.start"), NEXT);
  assert.deepEqual(await fire("tool.call", { tool: "EnterWorktree" }), { result: NEXT });
  assert.deepEqual(await fire("tool.call", { tool: "ExitWorktree" }), { result: NEXT });
  assert.equal(toasts.length, 0);
});

test("a Bash call in the dir already checked does no filesystem work", async ($, on) => {
  const dir = repo(); // .git, no config: no toast, dprintRuns stays false
  const { fire, bashIn, runs, toasts, existsCalls } = setup($, on, { cwd: dir, run: () => DENY });
  await fire("session.start");
  const before = existsCalls();
  assert.ok(before > 0, "session.start walked the dir");
  await bashIn(dir);
  assert.equal(existsCalls(), before, "same dir as the last check: no walk");
  assert.deepEqual(runs, []);
  assert.equal(toasts.length, 0);
});

test("a Bash call after a cd checks the new dir", async ($, on) => {
  const bare = repo();
  const configDir = withConfig(repo());
  const { fire, bashIn, runs, toasts } = setup($, on, { cwd: bare, run: () => DENY });
  await fire("session.start");
  assert.deepEqual(runs, []);
  await bashIn(configDir);
  assert.equal(runs.length, 1);
  assert.deepEqual(toasts.map((t) => t.text), [toastText(configDir, COULD_NOT_START)]);
});

test("same dir after the toast window is not re-checked, another dir is", async ($, on) => {
  const a = withConfig(repo());
  const b = withConfig(repo());
  const { bashIn, toasts, existsCalls } = setup($, on, { run: () => DENY });
  await bashIn(a);
  assert.deepEqual(toasts.map((t) => t.text), [toastText(a, COULD_NOT_START)]);
  vi.setSystemTime(T0 + 16_000);
  const before = existsCalls();
  await bashIn(a);
  assert.equal(existsCalls(), before, "same dir: no walk");
  assert.equal(toasts.length, 1);
  await bashIn(b);
  assert.deepEqual(toasts.map((t) => t.text), [toastText(a, COULD_NOT_START), toastText(b, COULD_NOT_START)]);
});

test("after a successful probe a Bash call makes no engine call", async ($, on) => {
  const a = withConfig(repo());
  const b = withConfig(repo());
  const { bashIn, runs, toasts, cwdReads, existsCalls } = setup($, on);
  await bashIn(a);
  assert.equal(runs.length, 1);
  const reads = cwdReads();
  const walked = existsCalls();
  await bashIn(b);
  assert.equal(cwdReads(), reads, "no session.cwd read once dprint runs");
  assert.equal(existsCalls(), walked);
  assert.equal(toasts.length, 0);
});

plainTest("the module's own config names equal the shared CONFIG_NAMES", () => {
  assert.deepEqual([...PROBE_CONFIG_NAMES], [...CONFIG_NAMES]);
});

plainTest("the probe constants, MIN_VERSION and version regex equal the shared sources'", () => {
  const read = (f) => readFileSync(path.join(PLUGIN, "..", "src", f), "utf8");
  const notice = read("hooks/probe.ts");
  const find = read("skills/dprint/find-dprint.ts");
  const check = read("skills/dprint/check-dprint.ts");
  const num = (src, name) => new RegExp(`const ${name} = ([\\d_]+);`).exec(src)?.[1];
  assert.ok(num(find, "NPX_PROBE_TIMEOUT_MS"));
  assert.equal(num(notice, "PROBE_TIMEOUT_MS"), num(find, "NPX_PROBE_TIMEOUT_MS"));
  assert.ok(num(find, "NPX_RETRY_MS"));
  assert.equal(num(notice, "PROBE_RETRY_MS"), num(find, "NPX_RETRY_MS"));
  const min = (src) => /^(?:export )?const MIN_VERSION = "([0-9.]+)";$/m.exec(src)?.[1];
  assert.ok(min(check));
  assert.equal(min(notice), min(check));
  const versionRe = "/^dprint (\\d+)\\.(\\d+)\\.(\\d+)(-\\S+)?/";
  assert.ok(check.includes(versionRe) && notice.includes(versionRe), "version regex");
  assert.ok(find.includes("[\"--yes\", \"dprint\"]") && notice.includes("[\"npx\", \"--no\", \"--prefer-offline\", \"--\", \"dprint\", \"--version\"]"), "npx argv (notice never downloads)");
  assert.ok(find.includes("join(homedir(), \".dprint\")") && notice.includes("${home}/.dprint/bin/dprint") && find.includes("process.env.DPRINT_INSTALL") && notice.includes("DPRINT_INSTALL"), "home path");
});

plainTest("the built register.js is one self-contained module that keeps the names Claude Code's static check needs", () => {
  const built = readFileSync(path.join(PLUGIN, "hooks/register.js"), "utf8");
  assert.doesNotMatch(built, /(?:^|[;}\s])import\s*[{*"'`(]/, "no import of any kind");
  assert.ok(!built.startsWith("#!"));
  assert.match(built, /\bregister\b/);
  assert.match(built, /\$\.fs\.exists\(/);
  assert.match(built, /\$\.ui\.toast\(/);
  assert.match(built, /\$\.session\.cwd\(\)/);
  assert.match(built, /\$\.process\.run\(/);
  assert.match(built, /\$\.env\.get\(["'`]HOME["'`]\)/);
  assert.match(built, /\$\.env\.get\(["'`]PATH["'`]\)/);
  for (const gone of ["hooks/register.mjs", "hooks/lib.mjs", "shared"]) assert.ok(!existsSync(path.join(PLUGIN, gone)), gone);
});

test("worktree tool output in the engine's { result } shape: ExitWorktree checks restoredCwd, never the worktree it left", async ($, on) => {
  const left = withConfig(repo()); // ExitWorktree's output also names the worktree just left
  const restored = withConfig(repo());
  const entered = withConfig(repo());
  const { fire, toasts } = setup($, on, {
    cwd: "",
    run: () => DENY,
    toolResult: (e) => (e.tool === "ExitWorktree" ? { worktreePath: left, restoredCwd: restored } : { worktreePath: entered }),
  });
  await fire("tool.call", { tool: "ExitWorktree" });
  assert.deepEqual(toasts.map((t) => t.text), [toastText(restored, COULD_NOT_START)]);
  vi.setSystemTime(T0 + 16_000);
  await fire("tool.call", { tool: "EnterWorktree" });
  assert.deepEqual(toasts.map((t) => t.text), [toastText(restored, COULD_NOT_START), toastText(entered, COULD_NOT_START)]);
});

test("DPRINT_INSTALL/bin/dprint is the fallback when set (and ~/.dprint/bin is then not looked at)", async ($, on) => {
  const dir = withConfig(repo());
  const install = "/opt/dprint-install/";
  const probed: string[] = [];
  const { fire, runs, toasts } = setup($, on, {
    cwd: dir,
    install,
    bins: [],
    exists: (p) => {
      probed.push(p);
      return { value: p === HOME || p === "/opt/dprint-install/bin/dprint" || existsSync(p) };
    },
    run: () => OK,
  });
  await fire("session.start", {});
  assert.deepEqual(runs.map((r) => r.argv), [["/opt/dprint-install/bin/dprint", "--version"]]);
  assert.equal(toasts.length, 0);
  assert.ok(!probed.includes(`${HOME}/.dprint/bin/dprint`), probed.join(","));
});
