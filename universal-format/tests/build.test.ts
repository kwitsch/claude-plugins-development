// What the build must have produced: the vendored bundle with exactly the listed wasm files, relocatable, with the
// installed prettier inside, and no plugin evaluated before its first use. `plugin/` is git-ignored; CI and Sync
// build it fresh and run the layout check.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "vitest";
import { BUNDLED_PRETTIER_VERSION } from "../src/mcp/prettier.ts";
import { cleanup, PLUGIN, sandbox } from "./support/mcp.ts";

afterEach(cleanup);

const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(path.join(PLUGIN, "..", "package.json"), "utf8")) as { devDependencies: Record<string, string>; pluginBuild: { assets: string[] } };
/** Every file below a directory, relative to it. */
const list = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.relative(dir, path.join(d.parentPath, d.name)));

test("the bundled prettier is the installed one, pinned in package.json", () => {
  const installed = (JSON.parse(readFileSync(require.resolve("prettier/package.json"), "utf8")) as { version: string }).version;
  assert.equal(BUNDLED_PRETTIER_VERSION, installed, "prettier was bumped without a rebuild: run pnpm build");
  assert.equal(pkg.devDependencies.prettier, installed);
});

// a deleted, stale or orphaned wasm file is invisible to the tests of the code: an orphan means a plugin bump renamed one
test("exactly the wasm files listed under pluginBuild.assets ship, each equal to the plugin's own copy", () => {
  assert.deepEqual(list(PLUGIN).filter((f) => f.endsWith(".wasm")).sort(), [...pkg.pluginBuild.assets].sort());
  const java = require.resolve("prettier-plugin-java");
  const sources: Record<string, string> = {
    "mcp/vendor/tree-sitter-java_orchard.wasm": path.join(path.dirname(java), "tree-sitter-java_orchard.wasm"),
    "mcp/vendor/web-tree-sitter.wasm": createRequire(java).resolve("web-tree-sitter/web-tree-sitter.wasm"),
    "mcp/main.wasm": createRequire(require.resolve("prettier-plugin-sh")).resolve("sh-syntax/main.wasm"),
  };
  assert.deepEqual(Object.keys(sources).sort(), [...pkg.pluginBuild.assets].sort());
  for (const [rel, source] of Object.entries(sources)) assert.ok(readFileSync(path.join(PLUGIN, rel)).equals(readFileSync(source)), `${rel} is stale: run pnpm build`);
});

// a bundler's CJS shim once hardcoded the build machine's node_modules path as sh-syntax's __dirname
test("the build output is relocatable: no path of this checkout or of a package store is embedded", () => {
  const root = path.resolve(PLUGIN, "..", "..");
  const scanned = [...list(path.join(PLUGIN, "mcp")).filter((f) => f.endsWith(".mjs")).map((f) => path.join("mcp", f)), "skills/universal-format/format-files.mjs"];
  assert.ok(scanned.includes("mcp/server.mjs") && scanned.some((f) => f.startsWith(path.join("mcp", "vendor"))), "server and vendor bundle are scanned");
  for (const f of scanned) {
    const text = readFileSync(path.join(PLUGIN, f), "utf8");
    assert.equal(text.includes(root), false, `${f} embeds this checkout's path`);
    assert.equal(text.includes("node_modules/.pnpm"), false, `${f} embeds a package store path`);
  }
});

// The plugins must stay lazy: a static import would evaluate one at every start (java: two wasm loads; shell: a Go
// runtime that leaks globals). The built skill driver (it inlines the handlers the server uses) runs under a preload
// that records `.wasm` reads and new globals: a plain TypeScript format must show neither, a shell and a java format
// both (the positive control of both instruments).
const PRELOAD = `
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const wasm = [];
for (const [obj, key] of [[fs, "readFileSync"], [fs, "readFile"], [fsp, "readFile"]]) {
  const orig = obj[key];
  obj[key] = function (p, ...rest) { if (String(p).endsWith(".wasm")) wasm.push(String(p)); return orig.call(this, p, ...rest); };
}
syncBuiltinESMExports();
const before = new Set(Object.getOwnPropertyNames(globalThis));
process.on("exit", () => fs.writeFileSync(process.env.UF_PROBE_OUT, JSON.stringify({ wasm: wasm.length, globals: Object.getOwnPropertyNames(globalThis).filter((k) => !before.has(k)).length })));
`;

/**
 * Formats files with the built skill driver under the recording preload.
 *
 * @param files - File contents by name, written into a fresh sandbox project.
 * @returns The driver's stdout and what the preload recorded.
 */
function probe(files: Record<string, string>): { stdout: string; seen: { wasm: number; globals: number } } {
  const s = sandbox();
  const preload = path.join(s.root, "preload.mjs");
  const out = path.join(s.root, "probe.json");
  const listFile = path.join(s.root, "list");
  writeFileSync(preload, PRELOAD);
  mkdirSync(s.proj, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(s.proj, name), text);
  writeFileSync(listFile, Object.keys(files).map((name) => path.join(s.proj, name)).join("\n") + "\n");
  const run = spawnSync(path.join(s.bin, "node"), ["--import", pathToFileURL(preload).href, path.join(PLUGIN, "skills/universal-format/format-files.mjs"), listFile], { cwd: s.proj, encoding: "utf8", env: { PATH: s.bin, HOME: s.home, UF_PROBE_OUT: out } });
  assert.equal(run.status, 0, run.stderr);
  return { stdout: run.stdout, seen: JSON.parse(readFileSync(out, "utf8")) as { wasm: number; globals: number } };
}

test("no bundled plugin is evaluated at start or by a plain TypeScript format, only on its first use", () => {
  const plain = probe({ "a.ts": "let x=1" });
  assert.match(plain.stdout, /1 formatted/);
  assert.deepEqual(plain.seen, { wasm: 0, globals: 0 }, "starting the driver and a plain TypeScript format evaluated a bundled plugin");
  const used = probe({ "a.sh": "echo  hi", "A.java": "class A {  }" });
  assert.match(used.stdout, /2 formatted/);
  assert.ok(used.seen.wasm > 0 && used.seen.globals > 0, "positive control failed: formatting java and shell must show up in the probe's instruments");
});

// The shell loader imports Go's wasm_exec runtime from this package's sh-syntax, while prettier-plugin-sh brings its
// own (a ^ range) with the matching main.wasm: both must be one version, or runtime and wasm come from different ones.
test("the sh-syntax pin equals the version prettier-plugin-sh resolves", () => {
  const viaPlugin = (JSON.parse(readFileSync(createRequire(require.resolve("prettier-plugin-sh")).resolve("sh-syntax/package.json"), "utf8")) as { version: string }).version;
  assert.equal(pkg.devDependencies["sh-syntax"], viaPlugin);
});
