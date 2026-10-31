// Contract tests for the built plugin/skills/dprint/run-dprint.mjs.
// Isolated PATH (only bash + node), HOME and project dir per test; dprint is stubbed and logs its argv.
// Every run passes a cwd inside proj: otherwise findConfig walks up to the repo-root dprint.json.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugin/skills/dprint/run-dprint.mjs");

let bin, home, proj;
beforeEach(() => {
  const tmp = mkdtempSync(path.join(tmpdir(), "dprint-run-test-"));
  bin = path.join(tmp, "bin");
  home = path.join(tmp, "home");
  proj = path.join(tmp, "proj");
  for (const d of [bin, home, proj]) mkdirSync(d);
  for (const t of ["bash", "node"]) {
    const src = spawnSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
    if (src) symlinkSync(src, path.join(bin, t));
  }
});

function stub(file, ...lines) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, ["#!/usr/bin/env bash", ...lines, ""].join("\n"));
  chmodSync(file, 0o755);
}
/** dprint stub at `file` (default: on PATH) that logs its argv, one per line, to $HOME/argv, then runs `lines` */
const stubDprint = (file = path.join(bin, "dprint"), ...lines) => stub(file, `printf '%s\\n' "$@" > "$HOME/argv"`, ...lines);
/** argv the stub was called with */
const argv = () => readFileSync(path.join(home, "argv"), "utf8").split("\n").slice(0, -1);
/** whether the stub was called at all */
const ran = () => existsSync(path.join(home, "argv"));
/** create proj/<rel> as an empty dprint config */
function conf(rel = "dprint.json") {
  const f = path.join(proj, rel);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, "{}\n");
}
function run(args, cwd = proj) {
  const r = spawnSync(path.join(bin, "node"), [SCRIPT, ...args], {
    cwd,
    env: { PATH: bin, HOME: home },
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("usage errors -> exit 2, dprint not run", () => {
  stubDprint();
  conf();
  for (const args of [[], ["lint"], ["check", "a", "b"], ["check", ""]]) {
    const r = run(args);
    assert.equal(r.code, 2, JSON.stringify(args));
    assert.match(r.err, /usage: node run-dprint\.mjs <check\|fmt> \[scope\]/);
  }
  assert.equal(ran(), false);
});

test("no dprint on PATH nor in ~/.dprint/bin -> exit 3, reason=missing", () => {
  conf();
  const r = run(["check"]);
  assert.equal(r.code, 3);
  assert.equal(r.out, "status=notsetup reason=missing\n");
  assert.match(r.err, /\/dprint init/);
});

test("dprint but no config in proj or its ancestors -> exit 3, reason=noconfig, dprint not run", () => {
  stubDprint();
  const r = run(["fmt"]);
  assert.equal(r.code, 3);
  assert.equal(r.out, "status=notsetup reason=noconfig\n");
  assert.match(r.err, /\/dprint init/);
  assert.equal(ran(), false);
});

test("dprint.json in cwd, check -> dprint check without file arguments, exit 0", () => {
  stubDprint();
  conf();
  const r = run(["check"]);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /status=notsetup/);
  assert.deepEqual(argv(), ["check"]);
});

test("config only in the parent directory -> found by walk-up, dprint runs", () => {
  stubDprint();
  conf(".dprint.jsonc");
  mkdirSync(path.join(proj, "sub"));
  const r = run(["fmt"], path.join(proj, "sub"));
  assert.equal(r.code, 0);
  assert.deepEqual(argv(), ["fmt"]);
});

test("only .config/dprint.json -> it counts as config, dprint runs", () => {
  stubDprint();
  conf(".config/dprint.json");
  const r = run(["check"]);
  assert.equal(r.code, 0);
  assert.deepEqual(argv(), ["check"]);
});

test("glob scope is passed verbatim after --, not expanded", () => {
  stubDprint();
  conf();
  const r = run(["check", "src/**/*.ts"]);
  assert.equal(r.code, 0);
  assert.deepEqual(argv(), ["check", "--", "src/**/*.ts"]);
});

test("scope starting with - and containing a space stays one argument after --", () => {
  stubDprint();
  conf();
  const r = run(["fmt", "-x y"]);
  assert.equal(r.code, 0);
  assert.deepEqual(argv(), ["fmt", "--", "-x y"]);
});

test("dprint only in ~/.dprint/bin -> that one is used", () => {
  stubDprint(path.join(home, ".dprint/bin/dprint"));
  conf();
  const r = run(["check"]);
  assert.equal(r.code, 0);
  assert.deepEqual(argv(), ["check"]);
});

test("dprint's exit code and output are passed through", () => {
  stubDprint(undefined, 'echo "unformatted: a.ts"', "exit 20");
  conf();
  const r = run(["check"]);
  assert.equal(r.code, 20);
  assert.match(r.out, /unformatted: a\.ts/);
});
