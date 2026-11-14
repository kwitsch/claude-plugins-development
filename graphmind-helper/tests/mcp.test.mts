// The built MCP wrapper, run as a process with a fake `graphmind` on PATH and a temp HOME.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "vitest";
import { findGraphmind, setupMcpPresent } from "../plugin/bin/common.mjs";
import { indexable } from "../plugin/bin/mcp.mjs";

const MCP = fileURLToPath(new URL("../plugin/bin/mcp.mjs", import.meta.url));
let root = "";
let home = "";
let proj = "";
let fakeBin = "";

/** A fake graphmind: logs every call, `which` follows the REGISTERED file, `init` creates it and, like the real one, adds a project server to .claude.json. */
const FAKE = `#!/bin/sh
echo "$@" >> "$FAKE_LOG"
case "$1" in
  which) [ -f "$FAKE_REGISTERED" ] && echo slug && exit 0; exit 1 ;;
  init) touch "$FAKE_REGISTERED"; printf '{"projects":{"%s":{"mcpServers":{"graphmind":{}}}}}' "$PWD" > "\${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"; exit 0 ;;
esac
exit 0
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gmh-"));
  home = join(root, "home");
  proj = join(root, "proj");
  fakeBin = join(root, "bin");
  for (const d of [home, proj, fakeBin, join(proj, ".git")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(fakeBin, "graphmind"), FAKE);
  chmodSync(join(fakeBin, "graphmind"), 0o755);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/**
 * Runs the wrapper in the project directory.
 *
 * @param noBinary - Leave the fake off PATH.
 * @param extraEnv - Further environment variables.
 * @param cwd - Working directory.
 * @returns Process result and the fake's call log.
 */
function runWrapper(noBinary = false, extraEnv: NodeJS.ProcessEnv = {}, cwd = proj) {
  const log = join(root, "calls.log");
  const r = spawnSync(process.execPath, [MCP], {
    cwd,
    encoding: "utf8",
    env: { HOME: home, PATH: `${noBinary ? "" : `${fakeBin}:`}/usr/bin:/bin`, FAKE_LOG: log, FAKE_REGISTERED: join(root, "registered"), ...extraEnv },
    timeout: 20_000,
  });
  return { r, calls: existsSync(log) ? readFileSync(log, "utf8") : "" };
}

test("in an unregistered git repo the wrapper runs init --skip-build, a background build, then mcp", async () => {
  const { r, calls } = runWrapper();
  assert.equal(r.status, 0);
  const lines = calls.trim().split("\n");
  assert.ok(lines.includes("init --skip-build"));
  assert.equal(lines.at(-1), "mcp");
  await new Promise((done) => setTimeout(done, 300));
  assert.match(readFileSync(join(root, "calls.log"), "utf8"), /^build$/m);
});

test("started in a repo subdirectory the wrapper registers and builds the work tree root", async () => {
  mkdirSync(join(proj, "sub"));
  const realProj = realpathSync(proj);
  writeFileSync(join(fakeBin, "graphmind"), FAKE.replace('echo "$@" >> "$FAKE_LOG"', 'echo "$@ $PWD" >> "$FAKE_LOG"'));
  assert.match(runWrapper(false, {}, join(proj, "sub")).calls, new RegExp(`^init --skip-build ${realProj}$`, "m"));
  await new Promise((done) => setTimeout(done, 300));
  assert.match(readFileSync(join(root, "calls.log"), "utf8"), new RegExp(`^build ${realProj}$`, "m"));
});

test("with the setup's server in ~/.claude.json the wrapper still inits but does not serve", () => {
  writeFileSync(join(home, ".claude.json"), "{\"mcpServers\":{\"graphmind\":{\"command\":\"graphmind\"}}}");
  const { calls } = runWrapper();
  assert.match(calls, /init --skip-build/);
  assert.doesNotMatch(calls, /^mcp$/m);
});

test("with CLAUDE_CONFIG_DIR set only its .claude.json counts, not the one in HOME", () => {
  const cfg = join(root, "cfg");
  const server = "{\"mcpServers\":{\"graphmind\":{\"command\":\"graphmind\"}}}";
  mkdirSync(cfg);
  writeFileSync(join(home, ".claude.json"), server);
  assert.match(runWrapper(false, { CLAUDE_CONFIG_DIR: cfg }).calls, /^mcp$/m);
  writeFileSync(join(cfg, ".claude.json"), server);
  rmSync(join(root, "calls.log"));
  assert.doesNotMatch(runWrapper(false, { CLAUDE_CONFIG_DIR: cfg }).calls, /^mcp$/m);
});

test("only the project entry Claude Code loads counts: git root, main checkout of a linked worktree, never an ancestor repo", () => {
  const git = (cwd: string, ...args: string[]) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" }).status, 0);
  const outer = join(root, "outer");
  const inner = join(outer, "inner");
  const wt = join(root, "wt");
  mkdirSync(join(inner, "sub"), { recursive: true });
  git(outer, "init", "-q");
  git(inner, "init", "-q");
  git(outer, "commit", "-q", "--allow-empty", "-m", "i");
  git(outer, "worktree", "add", "-q", wt);
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { [outer]: { mcpServers: { graphmind: {} } } } }));
  assert.equal(setupMcpPresent(home, outer), true);
  assert.equal(setupMcpPresent(home, wt), true);
  assert.equal(setupMcpPresent(home, join(inner, "sub")), false);
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { [inner]: { mcpServers: { graphmind: {} } } } }));
  assert.equal(setupMcpPresent(home, join(inner, "sub")), true);
});

test("a directory or non-executable graphmind earlier on PATH does not shadow the binary", () => {
  const dir = join(root, "a");
  const plain = join(root, "p");
  mkdirSync(join(dir, "graphmind"), { recursive: true });
  mkdirSync(plain);
  writeFileSync(join(plain, "graphmind"), FAKE);
  assert.equal(findGraphmind({ PATH: `${dir}:${plain}:${fakeBin}` }), join(fakeBin, "graphmind"));
});

test("without the binary the wrapper exits 1; home and non-git folders are not indexable", () => {
  assert.equal(runWrapper(true).r.status, 1);
  assert.equal(indexable(root), undefined);
  assert.equal(indexable(proj), proj);
});

test("a dotfiles repo in a symlinked HOME does not make a plain folder below it indexable", () => {
  mkdirSync(join(home, ".git"));
  mkdirSync(join(home, "notes", "sub"), { recursive: true });
  symlinkSync(home, join(root, "linkhome"));
  const saved = process.env.HOME;
  process.env.HOME = join(root, "linkhome");
  try {
    assert.equal(indexable(join(home, "notes", "sub")), undefined);
  } finally {
    process.env.HOME = saved;
  }
});
