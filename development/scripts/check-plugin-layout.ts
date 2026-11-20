#!/usr/bin/env node
// Usage: check-plugin-layout.ts <plugin dir>
// Fails when <plugin>/plugin/ holds a file the shipped plugin may not contain (.claude/rules/plugin-build-output.md).
// An allowlist: sources, tests, CLAUDE.md or tooling files belong outside plugin/. Called by every plugin's
// build (step 0 of build-plugin.ts and of the tsdown build, development/tsdown/index.ts) and by check-plugin-fresh.sh in CI.
// Opt-in per plugin: `pluginBuild.assets` in <plugin dir>/package.json lists further files by exact path relative to
// plugin/ (binary files a vendored bundle loads at runtime, e.g. universal-format's wasm files).
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// no tests/ dir, *.test.* or CLAUDE.md anywhere; then the allowlist itself
const ALLOWED = /^(?!(.*\/)?tests\/)(?!.*\.test\.)(?!(.*\/)?CLAUDE\.md$)(\.claude-plugin\/plugin\.json|\.mcp\.json|README\.md|hooks\/hooks\.json|agents\/[^/]+\.md|skills\/.+\/(SKILL|[^/]+\.reference)\.md|skills\/.+\.json|.+\.mjs|hooks\/[^/]+\.js)$/;

const dir = process.argv[2] ?? ".";
const root = path.join(dir, "plugin");
/** The plugin's `pluginBuild.assets`: exact paths (relative to plugin/, `/`-separated) allowed beside the allowlist. */
const assets = new Set<string>();
const manifest = path.join(dir, "package.json");
if (existsSync(manifest)) {
  const listed = (JSON.parse(readFileSync(manifest, "utf8")) as { pluginBuild?: { assets?: unknown } }).pluginBuild?.assets ?? [];
  if (!Array.isArray(listed) || listed.some((a) => typeof a !== "string")) {
    console.error(`${manifest}: pluginBuild.assets must be an array of paths relative to plugin/`);
    process.exit(1);
  }
  for (const a of listed as string[]) assets.add(a);
}
// readdirSync follows a symlinked root: the build would delete .mjs files in its target
if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
  console.error(`${root} is a symlink: the build must not touch what it points at`);
  process.exit(1);
}
/**
 * Every path below a directory; symlinks count as files and are never followed (one could point outside plugin/).
 *
 * @param dir - Directory to list.
 * @returns The file and symlink paths.
 */
const list = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? list(path.join(dir, d.name)) : [path.join(dir, d.name)]);
// a symlink is stray whatever its name: the build must not touch what it points at
const stray = (existsSync(root) ? list(root) : [])
  .map((f) => path.relative(root, f).split(path.sep).join("/"))
  .filter((f) => !(ALLOWED.test(f) || assets.has(f)) || lstatSync(path.join(root, f)).isSymbolicLink());
if (stray.length) {
  console.error(`${root} holds files the shipped plugin may not contain (sources and tests belong in src/ and tests/):`);
  for (const f of stray) console.error(`  ${f}`);
  process.exit(1);
}
