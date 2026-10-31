// Unit tests for the built plugin/hooks/notice.mjs (Claude Code function-hooks module): a fake `on` records
// the registered hooks, a fake `$` backs fs.exists with node:fs and records ui.toast calls. The last test
// checks the build keeps the module's names (Claude Code's static module check needs `$`, `on` and named hooks).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "../plugin/hooks/notice.mjs";
import { CONFIG_NAMES } from "../plugin/skills/init-dprint/config-names.mjs";

const PLUGIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../plugin",
);

let dir, other;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "dprint-notice-test-"));
  other = mkdtempSync(path.join(tmpdir(), "dprint-notice-other-"));
});

/** register the module; returns the recorded hooks as [{ event, matcher, hook }] */
function hooks() {
  const out = [];
  register((event, a, b) =>
    out.push(
      b === undefined
        ? { event, matcher: undefined, hook: a }
        : { event, matcher: a, hook: b },
    ),
  );
  return out;
}

/** fake engine: session cwd is `cwd`; `exists` overrides fs.exists */
function engine(cwd, exists = async (p) => existsSync(p)) {
  const toasts = [];
  const $ = {
    fs: { exists },
    ui: { toast: (text, options) => toasts.push({ text, options }) },
    session: { cwd: async () => cwd },
  };
  return { $, toasts };
}

/** the detached check runs after the hook resolves; let it settle */
const settle = () => new Promise((r) => setImmediate(r));

/** run the hook registered for `event` (and tool matcher) and wait for its detached check */
async function fire(event, tool, $, e = {}) {
  const h = hooks().find(
    (x) => x.event === event && (tool === undefined || x.matcher?.tool === tool),
  );
  assert.ok(h, `${event} ${tool ?? ""}`);
  const r = await h.hook($, e, async () => "next-result");
  await settle();
  return r;
}

test("registers exactly session.start, classic.CwdChanged and tool.call for EnterWorktree/ExitWorktree", () => {
  assert.deepEqual(
    hooks().map(({ event, matcher }) => ({ event, matcher })),
    [
      { event: "session.start", matcher: undefined },
      { event: "classic.CwdChanged", matcher: undefined },
      { event: "tool.call", matcher: { tool: "EnterWorktree" } },
      { event: "tool.call", matcher: { tool: "ExitWorktree" } },
    ],
  );
  for (const h of hooks()) assert.equal(typeof h.hook, "function");
});

test("session.start in a config-less dir -> exactly one 15 s toast naming the dir and dprint.json", async () => {
  const { $, toasts } = engine(dir);
  await fire("session.start", undefined, $);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].options.timeoutMs, 15000);
  assert.ok(toasts[0].text.includes(dir), toasts[0].text);
  assert.ok(toasts[0].text.includes("dprint.json"), toasts[0].text);
});

test("each of the six config names in the cwd -> no toast", async () => {
  assert.equal(CONFIG_NAMES.length, 6);
  for (const n of CONFIG_NAMES) {
    const d = mkdtempSync(path.join(tmpdir(), "dprint-notice-cfg-"));
    mkdirSync(path.dirname(path.join(d, n)), { recursive: true });
    writeFileSync(path.join(d, n), "{}");
    const { $, toasts } = engine(d);
    await fire("session.start", undefined, $);
    assert.deepEqual(toasts, [], n);
  }
});

test("EnterWorktree and ExitWorktree check the session cwd after the tool ran", async () => {
  for (const [tool, d] of [["EnterWorktree", dir], ["ExitWorktree", other]]) {
    const { $, toasts } = engine(d);
    await fire("tool.call", tool, $);
    assert.equal(toasts.length, 1, tool);
    assert.ok(toasts[0].text.includes(d), tool);
  }
});

test("a config in an ancestor of the cwd -> no toast", async () => {
  writeFileSync(path.join(dir, "dprint.json"), "{}");
  const sub = path.join(dir, "packages", "foo");
  mkdirSync(sub, { recursive: true });
  const { $, toasts } = engine(sub);
  await fire("session.start", undefined, $);
  assert.deepEqual(toasts, []);
});

test("the search for a config stops at the git repo root and at a worktree root", async () => {
  writeFileSync(path.join(dir, "dprint.json"), "{}"); // above the repo root: must not count
  const repoRoot = path.join(dir, "repo");
  const sub = path.join(repoRoot, "pkg");
  mkdirSync(sub, { recursive: true });
  mkdirSync(path.join(repoRoot, ".git"));
  const { $, toasts } = engine(sub);
  await fire("session.start", undefined, $);
  assert.equal(toasts.length, 1);
  writeFileSync(path.join(repoRoot, "dprint.json"), "{}"); // at the repo root: counts
  const sub2 = path.join(repoRoot, "pkg2");
  mkdirSync(sub2);
  const { $: $2, toasts: t2 } = engine(sub2);
  await fire("session.start", undefined, $2);
  assert.deepEqual(t2, []);
  // a worktree (".git" is a file) is its own root even inside a repo that has a config
  const wt = path.join(repoRoot, "wt");
  mkdirSync(path.join(wt, "src"), { recursive: true });
  writeFileSync(path.join(wt, ".git"), "gitdir: elsewhere\n");
  const { $: $3, toasts: t3 } = engine(path.join(wt, "src"));
  await fire("session.start", undefined, $3);
  assert.equal(t3.length, 1);
});

test("the same dir within 15 s is toasted once even when several hooks fire", async () => {
  const { $, toasts } = engine(dir);
  await fire("tool.call", "EnterWorktree", $);
  await fire("classic.CwdChanged", undefined, $, { new_cwd: dir });
  assert.equal(toasts.length, 1);
});

test("worktree tools check the directory their result names, not a stale session cwd", async () => {
  writeFileSync(path.join(dir, "dprint.json"), "{}");
  const { $, toasts } = engine(dir); // stale session cwd has a config, the worktree has none
  await fire("tool.call", "EnterWorktree", $, { tool_response: { worktreePath: other } });
  assert.equal(toasts.length, 1);
  assert.ok(toasts[0].text.includes(other), toasts[0].text);
  const { $: $2, toasts: t2 } = engine(other); // stale cwd has none, restoredCwd has a config
  await fire("tool.call", "ExitWorktree", $2, { tool_response: { restoredCwd: dir } });
  assert.deepEqual(t2, []);
});

test("the module's inlined config names equal the shared CONFIG_NAMES", () => {
  const src = readFileSync(path.join(PLUGIN, "hooks/notice.mjs"), "utf8");
  const m = /CONFIG_NAMES=(\[[^\]]*\])/.exec(src);
  assert.ok(m, "inlined CONFIG_NAMES");
  assert.deepEqual(JSON.parse(m[1]), [...CONFIG_NAMES]);
  assert.doesNotMatch(src, /^import/m);
});

test("classic.CwdChanged checks e.new_cwd, not session.cwd()", async () => {
  writeFileSync(path.join(dir, "dprint.json"), "{}");
  const { $, toasts } = engine(dir); // session cwd has a config, new_cwd has none
  await fire("classic.CwdChanged", undefined, $, { new_cwd: other });
  assert.equal(toasts.length, 1);
  assert.ok(toasts[0].text.includes(other), toasts[0].text);
  assert.equal(toasts[0].options.timeoutMs, 15000);

  const { $: $2, toasts: t2 } = engine(other); // session cwd has none, new_cwd has a config
  await fire("classic.CwdChanged", undefined, $2, { new_cwd: dir });
  assert.deepEqual(t2, []);
});

test("classic.CwdChanged without new_cwd -> no toast", async () => {
  const { $, toasts } = engine(dir);
  await fire("classic.CwdChanged", undefined, $, {});
  assert.deepEqual(toasts, []);
});

test("the hook returns next's result unchanged; a rejecting fs.exists -> no throw, no toast", async () => {
  const { $, toasts } = engine(dir, async () => {
    throw new Error("boom");
  });
  for (const [event, tool] of [
    ["session.start", undefined],
    ["classic.CwdChanged", undefined],
    ["tool.call", "EnterWorktree"],
    ["tool.call", "ExitWorktree"],
  ]) {
    assert.equal(await fire(event, tool, $, { new_cwd: dir }), "next-result");
  }
  assert.deepEqual(toasts, []);
});

test("a throwing session.cwd -> next's result unchanged, no throw, no toast", async () => {
  const { $, toasts } = engine(dir);
  $.session.cwd = () => {
    throw new Error("boom");
  };
  for (const [event, tool] of [
    ["session.start", undefined],
    ["tool.call", "EnterWorktree"],
    ["tool.call", "ExitWorktree"],
  ]) {
    assert.equal(await fire(event, tool, $), "next-result");
  }
  assert.deepEqual(toasts, []);
});

test("built module keeps the names Claude Code's static check needs (no mangling)", () => {
  const src = readFileSync(
    path.join(PLUGIN, "hooks/notice.mjs"),
    "utf8",
  );
  assert.match(src, /export const register=on=>/);
  assert.match(src, /async function onSessionCwd\(\$,e,next\)/);
  assert.match(src, /async function onCwdChanged\(\$,e,next\)/);
  assert.match(src, /\$\.fs\.exists\(/);
  assert.match(src, /\$\.ui\.toast\(/);
  assert.match(src, /\$\.session\.cwd\(\)/);
});
