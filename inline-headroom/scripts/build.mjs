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

// 0. plugin/ ships only build output and hand-written plugin files (.claude/rules/plugin-build-output.md)
const layout = spawnSync(process.execPath, [path.join(ROOT, "../.github/scripts/check-plugin-layout.mjs"), ROOT], { stdio: "inherit" });
if (layout.status !== 0) process.exit(layout.status ?? 1);

// 1. remove stale build output (plugin/ holds no hand-written .mjs)
for (const f of walk(PLUGIN)) if (f.endsWith(".mjs")) rmSync(f);

// 2. compile (only if there are sources): .mts -> .mjs
const sources = walk(path.join(ROOT, "src")).filter((f) => f.endsWith(".mts"));
if (sources.length) {
  const tsc = spawnSync("pnpm", ["exec", "tsc", "-p", "tsconfig.json"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (tsc.status !== 0) process.exit(tsc.status ?? 1);
  // shipped output is for node, not humans: minify (drops comments, keeps the shebang and export names)
  for (const f of walk(PLUGIN).filter((f) => f.endsWith(".mjs"))) {
    // function-hooks modules (plugin/hooks/*.mjs) keep their names and shape: Claude Code's static check wants
    // named hook functions, `$`/`on` spelled as such and no shadowed names, which compress/mangle would break
    const hooksModule = path.relative(PLUGIN, f).startsWith("hooks" + path.sep);
    const { code } = await minify(readFileSync(f, "utf8"), {
      module: true,
      ecma: 2020,
      compress: hooksModule ? false : { passes: 2 },
      mangle: !hooksModule,
      format: { comments: false },
    });
    writeFileSync(f, code + "\n");
    if (code.startsWith("#!")) chmodSync(f, 0o755);
  }
}

// 3. manifest: <name>/plugin.json is the source of truth
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
