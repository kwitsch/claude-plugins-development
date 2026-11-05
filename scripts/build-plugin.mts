#!/usr/bin/env node
// Usage: build-plugin.mts [plugin dir]  (default: the cwd; every plugin's `build` script runs it from its own dir)
// Builds one plugin: src/**/*.mts -> plugin/**/*.mjs via oxc-transform (type stripping; type checks run in
// `pnpm lint`), minified with oxc-minify, then syncs plugin.json into plugin/.claude-plugin/.
// Generated .mjs files and plugin/.claude-plugin/plugin.json must never be edited by hand.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { minifySync } from "oxc-minify";
import { transformSync } from "oxc-transform";

/** The plugin directory (holds plugin.json, package.json, src/ and plugin/). */
const ROOT = path.resolve(process.argv[2] ?? ".");
/** The shipped plugin. */
const PLUGIN = path.join(ROOT, "plugin");
/** The TypeScript sources. */
const SRC = path.join(ROOT, "src");

/**
 * Every file below a directory, recursively.
 *
 * @param dir - Directory to walk; a missing one yields no files.
 * @returns The file paths.
 */
const walk = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((d) => !d.isDirectory())
      .map((d) => path.join(d.parentPath, d.name))
    : [];

// 0. plugin/ ships only build output and hand-written plugin files (.claude/rules/plugin-build-output.md)
const layout = spawnSync(
  process.execPath,
  [path.join(path.dirname(fileURLToPath(import.meta.url)), "../.github/scripts/check-plugin-layout.mts"), ROOT],
  { stdio: "inherit" },
);
if (layout.status !== 0) process.exit(layout.status ?? 1);

// 1. remove stale build output (plugin/ holds no hand-written .mjs)
for (const f of walk(PLUGIN)) if (f.endsWith(".mjs")) rmSync(f);

// 2. compile: strip types file by file (.mts -> .mjs), then minify.
// Type checking is not part of the build: `pnpm lint` (oxlint --type-check) does it.
const sources = walk(SRC).filter((f) => f.endsWith(".mts") && !f.endsWith(".d.mts"));
for (const src of sources) {
  const out = path.join(PLUGIN, path.relative(SRC, src)).replace(/\.mts$/, ".mjs");
  const t = transformSync(src, readFileSync(src, "utf8"), { sourceType: "module", target: "es2022" });
  if (t.errors.length) {
    for (const e of t.errors) console.error(`${path.relative(ROOT, src)}: ${e.message}`);
    process.exit(1);
  }
  // shipped output is for node, not humans: minify (drops comments, keeps the shebang and export names).
  // Function-hooks modules (plugin/hooks/*.mjs) keep their names and shape: Claude Code's static check wants
  // named hook functions, `$`/`on` spelled as such and no shadowed names, which compress/mangle would break.
  const hooksModule = path.relative(PLUGIN, out).startsWith("hooks" + path.sep);
  const m = minifySync(out, t.code, {
    module: true,
    compress: hooksModule ? false : { target: "es2022" },
    mangle: !hooksModule,
    codegen: { legalComments: "none" },
  });
  if (m.errors.length) {
    for (const e of m.errors) console.error(`${path.relative(ROOT, out)}: ${e.message}`);
    process.exit(1);
  }
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, m.code.endsWith("\n") ? m.code : m.code + "\n");
  if (m.code.startsWith("#!")) chmodSync(out, 0o755);
}

// 3. manifest: <name>/plugin.json is the source of truth
const manifest = JSON.parse(readFileSync(path.join(ROOT, "plugin.json"), "utf8")) as Partial<
  Record<"name" | "version" | "description", string>
>;
for (const k of ["name", "version", "description"] as const) {
  if (!manifest[k]) {
    console.error(`plugin.json: missing "${k}"`);
    process.exit(1);
  }
}
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version?: string };
if (pkg.version !== manifest.version) {
  console.error(`version mismatch: package.json ${pkg.version} != plugin.json ${manifest.version}`);
  process.exit(1);
}
mkdirSync(path.join(PLUGIN, ".claude-plugin"), { recursive: true });
copyFileSync(path.join(ROOT, "plugin.json"), path.join(PLUGIN, ".claude-plugin", "plugin.json"));
console.log(`built ${manifest.name}@${manifest.version} (${sources.length} source file(s))`);
