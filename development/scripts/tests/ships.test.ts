// Every state of .github/scripts/ships.sh (the release rule): one throwaway git repo, one commit per case on top of
// a shared base, the script run in that checkout as release.yml and pr.yml run it.
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, test } from "vitest";

const SHIPS = fileURLToPath(new URL("../../../.github/scripts/ships.sh", import.meta.url));
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const tmp = mkdtempSync(path.join(os.tmpdir(), "ships-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// the caller's git state (a hook's GIT_DIR, user or system config) must not reach the throwaway repo
const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
env.GIT_CONFIG_NOSYSTEM = "1";
env.GIT_CONFIG_GLOBAL = "/dev/null";

function git(...args: string[]): string {
  const r = spawnSync("git", args, { cwd: tmp, env, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function write(file: string, content: string): void {
  const f = path.join(tmp, file);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, content);
}

const pkg = (name: string, extra: Record<string, unknown> = {}): string => `${JSON.stringify({ name, version: "1.0.0", scripts: { test: "vitest run" }, claudePlugin: {}, ...extra }, null, 2)}\n`;

let base = "";

beforeAll(() => {
  git("init", "-q");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  write("p/package.json", pkg("p"));
  write("p/src/a.ts", "export const a = 1;\n");
  write("p/tsdown.config.ts", "export default {};\n");
  write("p/tests/a.test.ts", "// test\n");
  write("p/plugin/x.mjs", "export{};\n");
  write("q/package.json", pkg("q"));
  write("q/tsdown.config.ts", "export default { alias: { \"@shared\": \"../development/shared/src\" } };\n");
  write("development/shared/src/s.ts", "export const s = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  base = git("rev-parse", "HEAD");
});

/** Commits `files` (null deletes) on top of the base; HEAD is that commit afterwards. */
function change(files: Record<string, string | null>): void {
  git("checkout", "-q", "--detach", base);
  for (const [file, content] of Object.entries(files)) {
    if (content === null) git("rm", "-q", file);
    else write(file, content);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "case");
}

function ships(dir: string, from: string, to = "HEAD"): SpawnSyncReturns<string> {
  return spawnSync("bash", [SHIPS, dir, from, to], { cwd: tmp, env, encoding: "utf8" });
}

function expectState(dir: string, state: string, from = base): void {
  const r = ships(dir, from);
  assert.equal(r.stderr, "");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `${state}\n`);
}

test("a test file only -> none", () => {
  change({ "p/tests/a.test.ts": "// changed\n" });
  expectState("p", "none");
});

test("deleting plugin/ (git-ignored build output) -> none", () => {
  change({ "p/plugin/x.mjs": null });
  expectState("p", "none");
});

test("scripts.test only -> none", () => {
  change({ "p/package.json": pkg("p", { scripts: { test: "vitest run --reporter dot" } }) });
  expectState("p", "none");
});

test("src/ only -> content", () => {
  change({ "p/src/a.ts": "export const a = 2;\n" });
  expectState("p", "content");
});

test("description only -> content", () => {
  change({ "p/package.json": pkg("p", { description: "changed" }) });
  expectState("p", "content");
});

test("devDependencies only -> content", () => {
  change({ "p/package.json": pkg("p", { devDependencies: { tsdown: "0.23.8" } }) });
  expectState("p", "content");
});

test("an added assets/ file -> content", () => {
  change({ "p/assets/README.md": "# p\n" });
  expectState("p", "content");
});

test("version only -> version", () => {
  change({ "p/package.json": pkg("p", { version: "1.0.1" }) });
  expectState("p", "version");
});

test("src/ and version -> ship", () => {
  change({ "p/src/a.ts": "export const a = 2;\n", "p/package.json": pkg("p", { version: "1.0.1" }) });
  expectState("p", "ship");
});

test("a new plugin dir with package.json and src/ -> ship", () => {
  change({ "n/package.json": pkg("n"), "n/src/a.ts": "export const a = 1;\n" });
  expectState("n", "ship");
});

test("shared source and the version of an @shared consumer -> ship", () => {
  change({ "development/shared/src/s.ts": "export const s = 2;\n", "q/package.json": pkg("q", { version: "1.0.1" }) });
  expectState("q", "ship");
});

test("shared source and the version of a plugin without @shared -> version", () => {
  change({ "development/shared/src/s.ts": "export const s = 2;\n", "p/package.json": pkg("p", { version: "1.0.1" }) });
  expectState("p", "version");
});

test("the empty tree as <from> (release.yml's first-push fallback) -> ship", () => {
  git("checkout", "-q", "--detach", base);
  expectState("p", "ship", EMPTY_TREE);
});

test("an unknown <from> revision -> non-zero exit", () => {
  git("checkout", "-q", "--detach", base);
  assert.notEqual(ships("p", "no-such-revision").status, 0);
});

test("an unknown <to> revision -> non-zero exit", () => {
  git("checkout", "-q", "--detach", base);
  assert.notEqual(ships("p", base, "no-such-revision").status, 0);
});
