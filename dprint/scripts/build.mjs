#!/usr/bin/env node
// Build: src/**/*.mts -> plugin/**/*.mjs via tsc, minified with terser, then sync plugin.json into plugin/.claude-plugin/.
// Generated .mjs files and plugin/.claude-plugin/plugin.json must never be edited by hand.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { minify } from "terser";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = path.join(ROOT, "plugin");

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// 1. remove stale build output (plugin/ holds no hand-written .mjs/.js)
for (const f of walk(PLUGIN)) if (/\.m?js$/.test(f)) rmSync(f);

// 2. validate hooks.json and regenerate the hook input types (src/mcp/hook-inputs.d.mts) from it
const hooks = spawnSync(
  process.execPath,
  [path.join(ROOT, "scripts/hooks.mjs")],
  {
    stdio: "inherit",
  },
);
if (hooks.status !== 0) process.exit(hooks.status ?? 1);

// 3. compile (only if there are sources): .mts -> .mjs, .ts -> .js
const sources = walk(path.join(ROOT, "src")).filter((f) => /\.m?ts$/.test(f));
if (sources.length) {
  const tsc = spawnSync("pnpm", ["exec", "tsc", "-p", "tsconfig.json"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (tsc.status !== 0) process.exit(tsc.status ?? 1);
  // shipped output is for node, not humans: minify (drops comments, keeps the shebang and export names)
  for (const f of walk(PLUGIN).filter((f) => /\.m?js$/.test(f))) {
    const { code } = await minify(readFileSync(f, "utf8"), {
      module: true,
      ecma: 2020,
      compress: { passes: 2 },
      format: { comments: false },
    });
    writeFileSync(f, code + "\n");
    if (code.startsWith("#!")) chmodSync(f, 0o755);
  }
}

// 4. manifest: <name>/plugin.json is the source of truth
const manifest = JSON.parse(
  readFileSync(path.join(ROOT, "plugin.json"), "utf8"),
);
for (const k of ["name", "version", "description"]) {
  if (!manifest[k]) {
    console.error(`plugin.json: missing "${k}"`);
    process.exit(1);
  }
}
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
if (pkg.version !== manifest.version) {
  console.error(
    `version mismatch: package.json ${pkg.version} != plugin.json ${manifest.version}`,
  );
  process.exit(1);
}
mkdirSync(path.join(PLUGIN, ".claude-plugin"), { recursive: true });
copyFileSync(
  path.join(ROOT, "plugin.json"),
  path.join(PLUGIN, ".claude-plugin", "plugin.json"),
);
console.log(
  `built ${manifest.name}@${manifest.version} (${sources.length} source file(s))`,
);
