// Contract tests for the built plugin/skills/init-dprint/check-dprint.mjs.
// Isolated PATH (only bash + node) and HOME per test; dprint is stubbed.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugin");
const SCRIPT = path.join(PLUGIN, "skills/init-dprint/check-dprint.mjs");
const MIN = /^const MIN_VERSION = "([0-9.]+)";$/m.exec(readFileSync(SCRIPT, "utf8"))?.[1];

let bin, home;
beforeEach(() => {
  const tmp = mkdtempSync(path.join(tmpdir(), "dprint-test-"));
  bin = path.join(tmp, "bin");
  home = path.join(tmp, "home");
  mkdirSync(bin);
  mkdirSync(home);
  for (const t of ["bash", "node"]) {
    const src = spawnSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
    if (src) symlinkSync(src, path.join(bin, t));
  }
});

function stub(file, ...lines) {
  writeFileSync(file, ["#!/usr/bin/env bash", ...lines, ""].join("\n"));
  chmodSync(file, 0o755);
}
const stubDprint = (...lines) => stub(path.join(bin, "dprint"), ...lines);
function stubHomeDprint(version) {
  mkdirSync(path.join(home, ".dprint/bin"), { recursive: true });
  stub(path.join(home, ".dprint/bin/dprint"), `echo "dprint ${version}"`);
}
function run(...args) {
  const r = spawnSync(path.join(bin, "node"), [SCRIPT, ...args], {
    env: { PATH: bin, HOME: home },
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr };
}

test("MIN_VERSION is defined exactly once", () => {
  assert.ok(MIN);
  assert.equal(readFileSync(SCRIPT, "utf8").match(/MIN_VERSION = /g).length, 1);
});

test("no dprint anywhere -> exit 10, status=missing", () => {
  const r = run();
  assert.equal(r.code, 10);
  assert.equal(r.out, `status=missing version=- min=${MIN} path=-`);
});

test("non-executable dprint on PATH is ignored -> exit 10", () => {
  writeFileSync(path.join(bin, "dprint"), "not executable\n");
  chmodSync(path.join(bin, "dprint"), 0o644);
  const r = run();
  assert.equal(r.code, 10);
  assert.match(r.out, /status=missing/);
});

test("0.6.0 is outdated (numeric compare) -> exit 11", () => {
  stubDprint('echo "dprint 0.6.0"');
  const r = run();
  assert.equal(r.code, 11);
  assert.equal(r.out, `status=outdated version=0.6.0 min=${MIN} path=${bin}/dprint`);
});

test("0.100.0 is ok (numeric compare) -> exit 0", () => {
  stubDprint('echo "dprint 0.100.0"');
  const r = run();
  assert.equal(r.code, 0);
  assert.equal(r.out, `status=ok version=0.100.0 min=${MIN} path=${bin}/dprint`);
});

test("exactly MIN_VERSION is ok -> exit 0", () => {
  stubDprint(`echo "dprint ${MIN}"`);
  const r = run();
  assert.equal(r.code, 0);
  assert.equal(r.out, `status=ok version=${MIN} min=${MIN} path=${bin}/dprint`);
});

test("prerelease of MIN_VERSION is outdated -> exit 11", () => {
  stubDprint(`echo "dprint ${MIN}-rc.1"`);
  assert.equal(run().code, 11);
});

test("garbage --version output -> exit 2, status=error", () => {
  stubDprint('echo "hello world"');
  const r = run();
  assert.equal(r.code, 2);
  assert.equal(r.out, `status=error version=- min=${MIN} path=${bin}/dprint`);
});

test("empty --version output -> exit 2", () => {
  stubDprint("exit 0");
  assert.equal(run().code, 2);
});

test("--version exits non-zero -> exit 2", () => {
  stubDprint('echo "dprint 0.60.0"', "exit 1");
  const r = run();
  assert.equal(r.code, 2);
  assert.match(r.out, /status=error/);
});

test("fallback ~/.dprint/bin/dprint used when not on PATH", () => {
  stubHomeDprint("9.9.9");
  const r = run();
  assert.equal(r.code, 0);
  assert.equal(r.out, `status=ok version=9.9.9 min=${MIN} path=${home}/.dprint/bin/dprint`);
});

test("PATH dprint wins over ~/.dprint/bin/dprint", () => {
  stubDprint('echo "dprint 0.10.0"');
  stubHomeDprint("9.9.9");
  const r = run();
  assert.equal(r.code, 11);
  assert.match(r.out, new RegExp(`path=${bin}/dprint$`));
});

test("any argument is a usage error -> exit 2", () => {
  stubDprint('echo "dprint 9.9.9"');
  const r = run("--help");
  assert.equal(r.code, 2);
  assert.match(r.out, /status=error/);
});
