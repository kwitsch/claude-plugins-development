#!/usr/bin/env node
// Build: src/**/*.mts -> plugin/**/*.mjs via tsc, then sync plugin.json into plugin/.claude-plugin/.
// Generated .mjs files and plugin/.claude-plugin/plugin.json must never be edited by hand.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// 1. remove stale build output
for (const f of walk(PLUGIN)) if (f.endsWith(".mjs")) rmSync(f);

// 2. compile (only if there are sources)
const sources = walk(path.join(ROOT, "src")).filter((f) => f.endsWith(".mts"));
if (sources.length) {
  const tsc = spawnSync("pnpm", ["exec", "tsc", "-p", "tsconfig.json"], { cwd: ROOT, stdio: "inherit" });
  if (tsc.status !== 0) process.exit(tsc.status ?? 1);
  for (const f of walk(PLUGIN)) {
    if (f.endsWith(".mjs") && readFileSync(f, "utf8").startsWith("#!")) chmodSync(f, 0o755);
  }
}

// 3. manifest: <name>/plugin.json is the source of truth
const manifest = JSON.parse(readFileSync(path.join(ROOT, "plugin.json"), "utf8"));
for (const k of ["name", "version", "description"]) {
  if (!manifest[k]) {
    console.error(`plugin.json: missing "${k}"`);
    process.exit(1);
  }
}
mkdirSync(path.join(PLUGIN, ".claude-plugin"), { recursive: true });
copyFileSync(path.join(ROOT, "plugin.json"), path.join(PLUGIN, ".claude-plugin", "plugin.json"));
console.log(`built ${manifest.name}@${manifest.version} (${sources.length} source file(s))`);
