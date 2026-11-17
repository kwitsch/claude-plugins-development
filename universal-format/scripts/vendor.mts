#!/usr/bin/env node
// Usage: node scripts/vendor.mts  (from universal-format/, after build-plugin.ts: its stale-.mjs cleanup removes the chunks)
// Bundles the third-party runtime code (prettier and its java, php and shell plugins) into plugin/mcp/vendor/*.mjs
// with rolldown and copies the three wasm files the plugins load at runtime. Everything is written to a temp
// directory first: a failed bundle leaves the previous output in place.
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { rolldown } from "rolldown";

/** The server's output directory; `main.wasm` goes here, one level above the chunks, where sh-syntax looks for it. */
const MCP = path.resolve("plugin/mcp");
/** The bundle's directory: `index.mjs`, its chunks and the two wasm files prettier-plugin-java loads beside its chunk. */
const VENDOR = path.join(MCP, "vendor");

const require = createRequire(import.meta.url);
/** prettier-plugin-java's entry: its grammar wasm lies beside it, web-tree-sitter is its dependency. */
const javaEntry = require.resolve("prettier-plugin-java");
/** The wasm files by target directory, each resolved the way its plugin resolves it at runtime. */
const WASM: [string, string][] = [
  [VENDOR, createRequire(javaEntry).resolve("web-tree-sitter/web-tree-sitter.wasm")],
  [VENDOR, path.join(path.dirname(javaEntry), "tree-sitter-java_orchard.wasm")],
  [MCP, createRequire(require.resolve("prettier-plugin-sh")).resolve("sh-syntax/main.wasm")],
];

const tmp = mkdtempSync(path.join(tmpdir(), "uf-vendor-"));
try {
  const bundle = await rolldown({ input: { index: "scripts/vendor-entry.mts" }, platform: "node", logLevel: "silent" });
  // no comments (they carry machine-specific module paths), content-hashed chunk names: the output is the same on every machine
  await bundle.write({ dir: tmp, format: "esm", minify: true, comments: false, entryFileNames: "[name].mjs", chunkFileNames: "[name]-[hash].mjs" });
  await bundle.close();
  // a plugin bump that renames a chunk or a grammar must not leave the old file behind
  rmSync(VENDOR, { recursive: true, force: true });
  for (const f of readdirSync(MCP)) if (f.endsWith(".wasm")) rmSync(path.join(MCP, f));
  mkdirSync(VENDOR, { recursive: true });
  for (const f of readdirSync(tmp)) copyFileSync(path.join(tmp, f), path.join(VENDOR, f));
  for (const [dir, file] of WASM) {
    const out = path.join(dir, path.basename(file));
    copyFileSync(file, out);
    // the package manager's store may hold them executable; git records the mode
    chmodSync(out, 0o644);
  }
  console.log(`vendored ${readdirSync(VENDOR).length} file(s) into ${path.relative(process.cwd(), VENDOR)}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
