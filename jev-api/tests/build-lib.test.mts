// The bundleHooksLib step of development/scripts/build-plugin.mts (jev-api is its user): helper import shapes the
// bundler cannot rewrite must fail the build instead of shipping a broken lib.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

const BUILD = path.resolve(import.meta.dirname, "../../development/scripts/build-plugin.mts");

/** Builds a fixture plugin whose hooks.json lists only register.mjs and returns the build's exit code and stderr. */
const build = (files: Record<string, string>): { status: number | null; stderr: string } => {
  const dir = mkdtempSync(path.join(tmpdir(), "bundle-lib-"));
  try {
    mkdirSync(path.join(dir, "src/hooks"), { recursive: true });
    mkdirSync(path.join(dir, "plugin/hooks"), { recursive: true });
    writeFileSync(path.join(dir, "plugin/hooks/hooks.json"), `{ "modules": ["./register.mjs"] }\n`);
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.1", description: "d", author: { name: "x" }, keywords: [], type: "module", pluginBuild: { bundleHooksLib: true }, claudePlugin: {} }));
    for (const [f, t] of Object.entries(files)) writeFileSync(path.join(dir, "src/hooks", f), t);
    const r = spawnSync(process.execPath, [BUILD, dir], { encoding: "utf8" });
    return { status: r.status, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const A = `export const one = 1;\n`;
const REGISTER = `import { two } from "./b.mjs";\nexport function register(on: unknown): number { return two(); }\n`;

test("a helper importing a helper with an alias fails the build", () => {
  const r = build({ "a.mts": A, "b.mts": `import { one as uno } from "./a.mjs";\nexport const two = (): number => uno + 1;\n`, "register.mts": REGISTER });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /renames an import of \.\/a\.mjs/);
});

test("a namespace import of a helper fails the build", () => {
  const r = build({ "a.mts": A, "b.mts": `import * as A from "./a.mjs";\nexport const two = (): number => A.one + 1;\n`, "register.mts": REGISTER });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /imports \.\/a\.mjs other than by named imports/);
});

test("an entry's namespace import of a helper fails the build", () => {
  const r = build({ "a.mts": A, "register.mts": `import * as A from "./a.mjs";\nexport function register(on: unknown): number { return A.one; }\n` });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /register\.mjs imports \.\/a\.mjs other than by named imports/);
});

test("named helper imports still build", () => {
  const r = build({ "a.mts": A, "b.mts": `import { one } from "./a.mjs";\nexport const two = (): number => one + 1;\n`, "register.mts": REGISTER });
  assert.equal(r.status, 0, r.stderr);
});
