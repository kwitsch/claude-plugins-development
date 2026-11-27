// Process tests of the built MCP server plugin/mcp/server.mjs: protocol, tools/list, session key, trust boundary, worktree scope base, owner identity.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "vitest";
import { FILE_CHANGED_SLOTS } from "../src/hooks/lint-core.ts";
import { type LintEnv, makeEnv, PLUGIN, SERVER, waitGone } from "./support/lint-hook.ts";

/** `_meta` of a 2026-07-28-era request. */
const MODERN = { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } };
/** The shellcheck stub's output: one finding in `a.sh`. */
const OUT = "a.sh:1:6: note: Double quote to prevent globbing. [SC2086]";
/** The five tools, in table order. */
const TOOLS = ["file_edited", "next_report", "stop", "file_changed", "prompt_submitted"];

/**
 * Env with a recording shellcheck stub that reports OUT (exit 1) and a file with that finding.
 *
 * @param extraEnv - Extra server environment.
 * @param e - The env to use; default a fresh one.
 * @param cwd - The server's working directory; default the env's project dir.
 * @returns The env, the finding file, the server client and payload helpers for `file_edited` and `stop` (session `s1`).
 */
function world(extraEnv: Record<string, string> = {}, e: LintEnv = makeEnv(), cwd?: string) {
  e.recStub("shellcheck", 1);
  const file = e.file("a.sh", "echo $1\n");
  const s = e.server({ out: OUT, env: extraEnv, cwd });
  const edit = (over: Record<string, unknown> = {}) => ({ cwd: e.cwd, session_id: "s1", tool_name: "Write", tool_input: { file_path: file, content: "echo $1\n" }, tool_response: {}, ...over });
  const stop = (over: Record<string, unknown> = {}) => s.call("stop", { hook_event_name: "Stop", cwd: e.cwd, session_id: "s1", agent_id: "", scratchpad_dir: "", stop_hook_active: "false", ...over });
  const changed = (f: string = file) => s.call("file_changed", { cwd: e.cwd, session_id: "s1", scratchpad_dir: "", file_path: f, event: "change" });
  return { e, file, s, edit, stop, changed };
}

/**
 * Runs git with the env's HOME and no system config, so user hooks and signing cannot interfere.
 *
 * @param e - The env.
 * @param cwd - Where git runs.
 * @param args - The git arguments.
 */
function git(e: LintEnv, cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, env: { ...process.env, HOME: e.home, GIT_CONFIG_NOSYSTEM: "1" }, stdio: "ignore" });
}

/**
 * Makes the env's project dir a git repo with one commit and a worktree under `.claude/worktrees/<name>`.
 *
 * @param e - The env.
 * @param names - The worktrees to add.
 * @returns The worktree paths.
 */
function gitWorld(e: LintEnv, ...names: string[]): string[] {
  git(e, e.cwd, "init", "-q");
  writeFileSync(path.join(e.cwd, "README"), "x\n");
  git(e, e.cwd, "add", "README");
  git(e, e.cwd, "commit", "-qm", "init");
  return names.map((n) => {
    git(e, e.cwd, "worktree", "add", "-q", path.join(".claude/worktrees", n));
    return path.join(e.cwd, ".claude/worktrees", n);
  });
}

test("initialize names the server lint with the plugin version; server/discover answers the modern era", async () => {
  const { s } = world();
  const version = (JSON.parse(readFileSync(path.join(PLUGIN, ".claude-plugin/plugin.json"), "utf8")) as { version: string }).version;
  const init = await s.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.deepEqual(init.result?.["serverInfo"], { name: "lint", version });
  const disc = await s.rpc("server/discover", MODERN);
  assert.equal(disc.result?.["resultType"], "complete");
  assert.deepEqual(disc.result?.["supportedVersions"], ["2026-07-28"]);
});

test("tools/list: five tools; file_edited and next_report model-visible with schemas, the other three hook-only", async () => {
  const { s } = world();
  type T = { name: string; description: string; inputSchema: { required?: string[] }; _meta: unknown };
  const tools = (await s.rpc("tools/list")).result?.["tools"] as T[];
  assert.deepEqual(tools.map((t) => t.name), TOOLS);
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const [name, required] of [["file_edited", ["cwd", "session_id", "tool_name", "tool_input"]], ["next_report", ["session_id"]]] as const) {
    assert.deepEqual(by[name]._meta, { ui: { visibility: ["model", "app"] } });
    assert.deepEqual(by[name].inputSchema.required, required);
    assert.match(by[name].description, /^Internal: called by the universal-lint plugin/);
  }
  for (const name of ["stop", "file_changed", "prompt_submitted"]) {
    assert.deepEqual(by[name]._meta, { ui: { visibility: ["app"] } });
    assert.deepEqual(by[name].inputSchema, { type: "object", additionalProperties: true });
  }
  assert.equal(by["cwd_changed"], undefined);
});

test("server.mjs has the node shebang and is executable", () => {
  assert.ok(readFileSync(SERVER, "utf8").startsWith("#!/usr/bin/env node"));
  accessSync(SERVER, constants.X_OK);
});

test("an unknown tool is a -32602 error", async () => {
  const { s } = world();
  assert.equal((await s.rpc("tools/call", { name: "nope" })).error?.code, -32602);
});

for (const tool of TOOLS) {
  test(`${tool} with empty arguments answers an object, never isError or an error`, async () => {
    const { s } = world();
    const r = await s.rpc("tools/call", { name: tool, arguments: {} });
    assert.equal(r.error, undefined);
    assert.equal(r.result?.["isError"], undefined);
    assert.deepEqual(r.result?.["structuredContent"], tool === "next_report" ? { state: "busy" } : {});
  });
}

test("key issue: the first keyless call of a session gets { key, headless } and acts on nothing", async () => {
  const { e, s, edit, stop } = world();
  const first = await s.call("next_report", { session_id: "s1" });
  assert.deepEqual(Object.keys(first).sort(), ["headless", "key"]);
  assert.equal(typeof first["key"], "string");
  const other = await s.call("file_edited", edit({ session_id: "s2" }));
  assert.deepEqual(Object.keys(other).sort(), ["headless", "key"]);
  assert.deepEqual(e.lines(), []);
  assert.deepEqual(await stop({ session_id: "s2" }), {});
});

for (const [name, key] of [["keyless", undefined], ["wrong key", "nope"]] as const) {
  test(`file_edited ${name}: neutral answer, no lint, nothing journaled`, async () => {
    const { e, s, edit, stop } = world();
    await s.key("s1");
    assert.deepEqual(await s.call("file_edited", edit({ key })), {});
    assert.deepEqual(e.lines(), []);
    assert.deepEqual(await stop(), {});
  });
}

test("no rotation: stray keyless and wrong-key calls change no key state", async () => {
  const { s, edit, stop } = world();
  const k = await s.key("s1");
  await s.call("next_report", { session_id: "s1" });
  await s.call("next_report", { session_id: "s1", key: "nope" });
  await s.call("prompt_submitted", { cwd: "", session_id: "s1" });
  await stop();
  assert.deepEqual(await s.call("next_report", { session_id: "s1" }), { state: "busy" });
  assert.match(String((await s.call("file_edited", edit({ key: k })))["context"]), /SC2086/);
});

test("keyed inline edit answers the findings as context; the stop after it has nothing left", async () => {
  const { s, edit, stop } = world();
  const r = await s.call("file_edited", edit({ key: await s.key("s1") }));
  assert.match(String(r["context"]), /^universal-lint: shellcheck found issues in a\.sh/);
  assert.deepEqual(await stop(), {});
});

test("next_report is text-free: a FileChanged report is announced, the stop carries it", async () => {
  const { s, stop, changed } = world();
  const k = await s.key("s1");
  assert.deepEqual(await changed(), {});
  const keyless = await s.call("next_report", { session_id: "s1", wait_ms: 0 });
  const keyed = await s.call("next_report", { session_id: "s1", key: k, wait_ms: 0 });
  assert.deepEqual(keyless, { state: "busy" });
  assert.deepEqual(keyed, { state: "ready" });
  assert.ok(!JSON.stringify([keyless, keyed]).includes("SC2086"));
  const r = await stop();
  assert.equal(r["decision"], "block");
  assert.match(String(r["reason"]), /changed outside Write\/Edit/);
  assert.match(String(r["reason"]), /SC2086/);
});

test("session isolation: another session's key is no key; its next_report and stop see nothing of s1", async () => {
  const { e, s, stop, changed } = world();
  const kA = await s.key("s1");
  const issue = await s.call("next_report", { session_id: "sB", key: kA, wait_ms: 0 });
  const kB = issue["key"];
  assert.equal(typeof kB, "string");
  assert.notEqual(kB, kA);
  assert.deepEqual(e.lines(), []);
  await changed();
  assert.deepEqual(await s.call("next_report", { session_id: "sB", key: kB, wait_ms: 0 }), { state: "timeout" });
  assert.deepEqual(await stop({ session_id: "sB" }), {});
  const r = await stop();
  assert.equal(r["decision"], "block");
  assert.match(String(r["reason"]), /SC2086/);
});

test("subagent edit: journaled, not linted, no answer; only its own SubagentStop reports it", async () => {
  const { e, s, edit, stop } = world();
  assert.deepEqual(await s.call("file_edited", edit({ key: await s.key("s1"), agent_id: "X" })), {});
  assert.deepEqual(e.lines(), []);
  assert.deepEqual(await stop({ hook_event_name: "SubagentStop", agent_id: "Y" }), {});
  const r = await stop({ hook_event_name: "SubagentStop", agent_id: "X" });
  assert.equal(r["decision"], "block");
  assert.match(String(r["reason"]), /SC2086/);
});

for (const [name, entry] of [["sdk-cli", true], ["cli", false]] as const) {
  test(`headless flag: CLAUDE_CODE_ENTRYPOINT=${name} answers headless ${entry}`, async () => {
    const { s } = world({ CLAUDE_CODE_ENTRYPOINT: name });
    assert.equal((await s.call("next_report", { session_id: "s1", wait_ms: 0 }))["headless"], entry);
  });
}

/** Trust-boundary rows: each keyed `file_edited` must answer `{}` and start no lint. */
const boundary: Array<[string, (w: ReturnType<typeof world>) => Promise<Record<string, unknown>>]> = [
  ["relative cwd", async (w) => w.edit({ cwd: "rel/dir" })],
  ["missing cwd", async (w) => w.edit({ cwd: path.join(w.e.cwd, "missing") })],
  ["cwd is a file", async (w) => w.edit({ cwd: w.file })],
  ["cwd is the filesystem root", async (w) => w.edit({ cwd: "/" })],
  ["file outside the cwd", async (w) => {
    const out = path.join(path.dirname(w.e.cwd), "out.sh");
    writeFileSync(out, "echo $1\n");
    return w.edit({ tool_input: { file_path: out, content: "echo $1\n" } });
  }],
  ["file under node_modules", async (w) => w.edit({ tool_input: { file_path: w.e.file("node_modules/x/a.sh", "echo $1\n"), content: "echo $1\n" } })],
  ["file inside the learned scratchpad", async (w) => {
    await w.s.call("prompt_submitted", { cwd: w.e.cwd, session_id: "s1", scratchpad_dir: path.join(w.e.cwd, "scratch") });
    return w.edit({ tool_input: { file_path: w.e.file("scratch/a.sh", "echo $1\n"), content: "echo $1\n" } });
  }],
  ["tool_input missing", async (w) => w.edit({ tool_input: undefined })],
  ["Edit that changed nothing", async (w) => w.edit({ tool_name: "Edit", tool_response: { structuredPatch: [], originalFile: "echo $1\n" } })],
];
for (const [name, build] of boundary) {
  test(`trust boundary: ${name} is not linted`, async () => {
    const w = world();
    const k = await w.s.key("s1");
    assert.deepEqual(await w.s.call("file_edited", { ...(await build(w)), key: k }), {});
    assert.deepEqual(w.e.lines(), []);
  });
}

// the plan listed a malformed structuredPatch as a trust-boundary row; lint-core checks such an Edit whole (fail open: report more, never less)
test("Edit with a malformed structuredPatch is checked whole", async () => {
  const { s, edit } = world();
  const r = await s.call("file_edited", edit({ key: await s.key("s1"), tool_name: "Edit", tool_response: { structuredPatch: "x", originalFile: "echo $1\n" } }));
  assert.match(String(r["context"]), /SC2086/);
});

test("unknown scratchpad: no scratchpad exclusion, a file under scratchpad/ is linted", async () => {
  const { e, s, edit } = world();
  const f = e.file("scratchpad/a.sh", "echo $1\n");
  const r = await s.call("file_edited", edit({ key: await s.key("s1"), tool_input: { file_path: f, content: "echo $1\n" } }));
  assert.match(String(r["context"]), /SC2086/);
});

test("next_report clamps: wait_ms 0 and -5 answer timeout; a missing session_id answers busy", async () => {
  const { s } = world();
  const k = await s.key("s1");
  assert.deepEqual(await s.call("next_report", { session_id: "s1", key: k, wait_ms: 0 }), { state: "timeout" });
  assert.deepEqual(await s.call("next_report", { session_id: "s1", key: k, wait_ms: -5 }), { state: "timeout" });
  assert.deepEqual(await s.call("next_report", { key: k }), { state: "busy" });
});

test("stop_hook_active is text: \"true\" after a blocked stop lets it through, \"false\" blocks again", async () => {
  const { e, file, s, stop, changed } = world();
  await s.key("s1");
  await changed();
  assert.equal((await stop())["decision"], "block");
  e.file("a.sh", "echo $2\n");
  await changed(file);
  assert.deepEqual(await stop({ stop_hook_active: "true" }), {});
  const r = await stop({ stop_hook_active: "false" });
  assert.equal(r["decision"], "block");
  assert.match(String(r["reason"]), /SC2086/);
});

test("worktree scope base (a): an edit with the worktree as cwd is linted", async () => {
  const e = makeEnv();
  const [w1] = gitWorld(e, "w1");
  const w = world({}, e);
  const f = path.join(w1, "a.sh");
  writeFileSync(f, "echo $1\n");
  const r = await w.s.call("file_edited", w.edit({ key: await w.s.key("s1"), cwd: w1, tool_input: { file_path: f, content: "echo $1\n" } }));
  assert.match(String(r["context"]), /SC2086/);
});

test("worktree scope base (b): the same file with the project root as cwd is not linted", async () => {
  const e = makeEnv();
  const [w1] = gitWorld(e, "w1");
  const w = world({}, e);
  const f = path.join(w1, "a.sh");
  writeFileSync(f, "echo $1\n");
  assert.deepEqual(await w.s.call("file_edited", w.edit({ key: await w.s.key("s1"), tool_input: { file_path: f, content: "echo $1\n" } })), {});
  assert.deepEqual(await w.stop(), {});
});

test("worktree scope base (c): a subagent's edit in a worktree is reported by its SubagentStop there", async () => {
  const e = makeEnv();
  const [w1] = gitWorld(e, "w1");
  const w = world({}, e);
  const f = path.join(w1, "a.sh");
  writeFileSync(f, "echo $1\n");
  assert.deepEqual(await w.s.call("file_edited", w.edit({ key: await w.s.key("s1"), agent_id: "A", cwd: w1, tool_input: { file_path: f, content: "echo $1\n" } })), {});
  const r = await w.stop({ hook_event_name: "SubagentStop", agent_id: "A", cwd: w1 });
  assert.equal(r["decision"], "block");
  assert.match(String(r["reason"]), /SC2086/);
});

test("worktree scope base (d): a server started inside a worktree accepts a subagent in another worktree", async () => {
  const e = makeEnv();
  const [w1, w2] = gitWorld(e, "w1", "w2");
  const w = world({}, e, w1);
  const f = path.join(w2, "a.sh");
  writeFileSync(f, "echo $1\n");
  assert.deepEqual(await w.s.call("file_edited", w.edit({ key: await w.s.key("s1"), agent_id: "B", cwd: w2, tool_input: { file_path: f, content: "echo $1\n" } })), {});
  const r = await w.stop({ hook_event_name: "SubagentStop", agent_id: "B", cwd: w2 });
  assert.equal(r["decision"], "block");
  assert.match(String(r["reason"]), /SC2086/);
});

test("cancel: notifications/cancelled kills the running lint and leaves no answer", async () => {
  const e = makeEnv();
  const pidfile = path.join(path.dirname(e.cwd), "sleep.pid");
  // node, not sleep: the server's PATH holds only bash/node/git, so a `sleep` stub would exit at once and prove nothing.
  e.stub("shellcheck", `printf "shellcheck %s\\n" "$*" >> "$RECORD"`, `node -e "setTimeout(() => {}, 30000)" & echo $! > "${pidfile}"`, "wait");
  const file = e.file("a.sh", "echo $1\n");
  const s = e.server({ out: OUT });
  const k = await s.key("s1");
  const p = s.call("file_edited", { cwd: e.cwd, session_id: "s1", tool_name: "Write", tool_input: { file_path: file, content: "echo $1\n" }, tool_response: {}, key: k });
  // observed, not awaited: the cancelled call must stay unanswered, and its rejection when the server closes is expected
  const outcome = p.then(() => "answered", () => "closed");
  const until = Date.now() + 10_000;
  while (!existsSync(pidfile) || readFileSync(pidfile, "utf8").trim() === "") {
    assert.ok(Date.now() < until, "the shellcheck stub never started");
    await sleep(50);
  }
  const pid = Number(readFileSync(pidfile, "utf8"));
  s.notify("notifications/cancelled", { requestId: p.id });
  await s.rpc("ping");
  const linesAtCancel = e.lines().length;
  // stderr and stdout are separate pipes: poll for the cancel line instead of assuming it arrived before the ping answer
  while (!s.stderr().includes(`cancelled tools/call ${p.id} (file_edited)`)) {
    assert.ok(Date.now() < until, `no cancel line in stderr: ${s.stderr()}`);
    await sleep(50);
  }
  assert.ok(await waitGone(pid, 2000), `linter child ${pid} survived the cancel`);
  assert.equal(e.lines().length, linesAtCancel);
  assert.equal(await Promise.race([outcome, sleep(500).then(() => "silent")]), "silent", "a cancelled call gets no reply for its id");
});

/**
 * Env whose shellcheck stub hangs on its first run (the test cancels that call) and reports `OUT` on every later run.
 *
 * @returns The env, the file `a.sh`, the stub's pid file and the server client.
 */
function hangingFirstRun() {
  const e = makeEnv();
  const pidfile = path.join(path.dirname(e.cwd), "sleep.pid");
  const mark = path.join(path.dirname(e.cwd), "first-run");
  e.stub("shellcheck", `printf "shellcheck %s\\n" "$*" >> "$RECORD"`, `if [ ! -e "${mark}" ]; then : > "${mark}"; node -e "setTimeout(() => {}, 30000)" & echo $! > "${pidfile}"; wait; else printf '%s\\n' "$OUT"; exit 1; fi`);
  const file = e.file("a.sh", "echo $1\n");
  return { e, file, pidfile, s: e.server({ out: OUT }) };
}

/**
 * Cancels the call `p` once the hanging linter runs and waits until the linter is gone.
 *
 * @param w - The `hangingFirstRun` world.
 * @param p - The pending call.
 */
async function cancelWhenLinting(w: ReturnType<typeof hangingFirstRun>, p: Promise<unknown> & { id: number }): Promise<void> {
  void p.catch(() => undefined);
  const until = Date.now() + 10_000;
  while (!existsSync(w.pidfile) || readFileSync(w.pidfile, "utf8").trim() === "") {
    assert.ok(Date.now() < until, "the shellcheck stub never started");
    await sleep(50);
  }
  const pid = Number(readFileSync(w.pidfile, "utf8"));
  w.s.notify("notifications/cancelled", { requestId: p.id });
  assert.ok(await waitGone(pid, 5000), `linter child ${pid} survived the cancel`);
}

test("a cancelled file_edited keeps its journal record: the next stop lints the file and reports it", async () => {
  const w = hangingFirstRun();
  const k = await w.s.key("s1");
  await cancelWhenLinting(w, w.s.call("file_edited", { cwd: w.e.cwd, session_id: "s1", tool_name: "Write", tool_input: { file_path: w.file, content: "echo $1\n" }, tool_response: {}, key: k }));
  const r = await w.s.call("stop", { hook_event_name: "Stop", cwd: w.e.cwd, session_id: "s1", agent_id: "", scratchpad_dir: "", stop_hook_active: "false" });
  assert.equal(r["decision"], "block");
  assert.match(String(r["reason"]), /SC2086/);
});

test("a cancelled sweep also puts back the records of a file that had finished: the next stop reports every file", async () => {
  const e = makeEnv();
  const pidfile = path.join(path.dirname(e.cwd), "sleep.pid");
  const mark = path.join(path.dirname(e.cwd), "h-first-run");
  // the first run on h.sh hangs (the test cancels the sweep then), every other run reports at once
  e.stub("shellcheck", `printf "shellcheck %s\\n" "$*" >> "$RECORD"`, `case "\${@: -1}" in *h.sh) if [ ! -e "${mark}" ]; then : > "${mark}"; node -e "setTimeout(() => {}, 30000)" & echo $! > "${pidfile}"; wait; fi;; esac`, `printf '%s\\n' "$OUT"`, "exit 1");
  // h.sh holds one lane for good, so the other lanes lint the FILE_CHANGED_SLOTS + 1 quick files one after another: the last one starts only after an earlier one has left its sweepFile
  const quick = Array.from({ length: FILE_CHANGED_SLOTS + 1 }, (_, i) => `q${i}.sh`);
  const files = ["h.sh", ...quick].map((n) => e.file(n, "echo $1\n"));
  const s = e.server({ out: OUT });
  const k = await s.key("s1");
  for (const f of files) assert.deepEqual(await s.call("file_edited", { cwd: e.cwd, session_id: "s1", agent_id: "X", tool_name: "Write", tool_input: { file_path: f, content: "echo $1\n" }, tool_response: {}, key: k }), {});
  const stop = { hook_event_name: "SubagentStop", cwd: e.cwd, session_id: "s1", agent_id: "X", scratchpad_dir: "", stop_hook_active: "false" };
  const p = s.call("stop", stop);
  const until = Date.now() + 10_000;
  // every quick file linted and h.sh running: a finished file's lane has taken the next file, so its records are claimed and cleared and its finding is not delivered yet
  while (!existsSync(pidfile) || readFileSync(pidfile, "utf8").trim() === "" || !quick.every((n) => e.lines().some((l) => l.includes(n)))) {
    assert.ok(Date.now() < until, `every quick file and the hanging h.sh should have run: ${e.lines().join(" | ")}`);
    await sleep(50);
  }
  void p.catch(() => undefined);
  s.notify("notifications/cancelled", { requestId: p.id });
  assert.ok(await waitGone(Number(readFileSync(pidfile, "utf8")), 5000));
  const r = await s.call("stop", stop);
  assert.equal(r["decision"], "block");
  for (const f of files) assert.ok(String(r["reason"]).includes(path.basename(f)), `${path.basename(f)} is reported: ${String(r["reason"])}`);
});

test("a cancelled SubagentStop sweep puts its claimed records back and blocks nothing: the next stop reports them", async () => {
  const w = hangingFirstRun();
  const k = await w.s.key("s1");
  assert.deepEqual(await w.s.call("file_edited", { cwd: w.e.cwd, session_id: "s1", agent_id: "X", tool_name: "Write", tool_input: { file_path: w.file, content: "echo $1\n" }, tool_response: {}, key: k }), {});
  const stop = { hook_event_name: "SubagentStop", cwd: w.e.cwd, session_id: "s1", agent_id: "X", scratchpad_dir: "", stop_hook_active: "false" };
  await cancelWhenLinting(w, w.s.call("stop", stop));
  const r = await w.s.call("stop", stop);
  assert.equal(r["decision"], "block");
  assert.match(String(r["reason"]), /SC2086/);
});

test("digest store: a keyed edit leaves no written/ directory (the digest lives in the server's memory)", async () => {
  const w = world();
  await w.s.call("file_edited", { ...w.edit(), key: await w.s.key("s1") });
  assert.equal(existsSync(path.join(w.e.data, "written")), false);
});

test("journal and stop marker: a subagent edit and a blocked stop leave no settle/ directory (both live in the server's memory)", async () => {
  const w = world();
  assert.deepEqual(await w.s.call("file_edited", w.edit({ key: await w.s.key("s1"), agent_id: "X" })), {});
  assert.equal((await w.stop({ hook_event_name: "SubagentStop", agent_id: "X" }))["decision"], "block");
  assert.equal(existsSync(path.join(w.e.data, "settle")), false);
});
