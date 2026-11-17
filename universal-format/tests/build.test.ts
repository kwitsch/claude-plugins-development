// What the build must have produced: the vendored bundle with exactly the listed wasm files, relocatable, with the
// installed prettier inside, and no plugin evaluated before its first use. Freshness of the committed output against
// the sources is CI's job (`.github/scripts/check-plugin-fresh.sh` rebuilds and compares).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { BUNDLED_PRETTIER_VERSION } from "../plugin/mcp/prettier.mjs";
import { PLUGIN } from "./support/mcp.ts";

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
  for (const f of list(path.join(PLUGIN, "mcp")).filter((f) => f.endsWith(".mjs"))) {
    const text = readFileSync(path.join(PLUGIN, "mcp", f), "utf8");
    assert.equal(text.includes(root), false, `${f} embeds this checkout's path`);
    assert.equal(text.includes("node_modules/.pnpm"), false, `${f} embeds a package store path`);
  }
});

// The plugins must stay lazy: a static import would evaluate one at every server start (java: two wasm loads; shell:
// a Go runtime that leaks globals). A child imports the built module with `.wasm` reads and new globals recorded and
// must see neither, then formats a shell and a java file as the positive control of both instruments.
const LAZY_PROBE = `
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
const wasm = [];
for (const [obj, key] of [[fs, "readFileSync"], [fs, "readFile"], [fsp, "readFile"]]) {
  const orig = obj[key];
  obj[key] = function (p, ...rest) { if (String(p).endsWith(".wasm")) wasm.push(String(p)); return orig.call(this, p, ...rest); };
}
syncBuiltinESMExports();
const before = new Set(Object.getOwnPropertyNames(globalThis));
const mod = await import(${JSON.stringify(pathToFileURL(path.join(PLUGIN, "mcp", "handlers.mjs")).href)});
const { formatInProcess } = await import(${JSON.stringify(pathToFileURL(path.join(PLUGIN, "mcp", "prettier.mjs")).href)});
await new Promise((r) => setTimeout(r, 300));
const seen = () => ({ wasm: wasm.length, globals: Object.getOwnPropertyNames(globalThis).filter((k) => !before.has(k)).length });
const atImport = seen();
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "uf-lazy-"));
await formatInProcess("let x=1", path.join(cwd, "a.ts"), cwd, "jsts");
const afterPlain = seen();
await formatInProcess("echo  hi", path.join(cwd, "a.sh"), cwd, "shell");
await formatInProcess("class A {  }", path.join(cwd, "A.java"), cwd, "java");
await new Promise((r) => setTimeout(r, 100));
process.stdout.write(JSON.stringify({ atImport, afterPlain, afterUse: seen() }));
process.exit(0);
`;

test("no bundled plugin is evaluated at import or by a plain TypeScript format, only on its first use", () => {
  const out = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", LAZY_PROBE], { encoding: "utf8" })) as Record<string, { wasm: number; globals: number }>;
  assert.deepEqual(out.atImport, { wasm: 0, globals: 0 }, "importing the server's modules evaluated a bundled plugin");
  assert.deepEqual(out.afterPlain, { wasm: 0, globals: 0 }, "a plain TypeScript format evaluated a bundled plugin");
  assert.ok(out.afterUse.wasm > 0 && out.afterUse.globals > 0, "positive control failed: formatting java and shell must show up in the probe's instruments");
});

// The shell loader imports Go's wasm_exec runtime from this package's sh-syntax, while prettier-plugin-sh brings its
// own (a ^ range) with the matching main.wasm: both must be one version, or runtime and wasm come from different ones.
test("the sh-syntax pin equals the version prettier-plugin-sh resolves", () => {
  const viaPlugin = (JSON.parse(readFileSync(createRequire(require.resolve("prettier-plugin-sh")).resolve("sh-syntax/package.json"), "utf8")) as { version: string }).version;
  assert.equal(pkg.devDependencies["sh-syntax"], viaPlugin);
});
