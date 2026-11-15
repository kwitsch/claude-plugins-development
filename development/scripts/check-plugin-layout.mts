#!/usr/bin/env node
// Usage: check-plugin-layout.mts <plugin dir>
// Fails when <plugin>/plugin/ holds a file the shipped plugin may not contain (.claude/rules/plugin-build-output.md).
// An allowlist: sources, tests, CLAUDE.md or tooling files belong outside plugin/. Called by every plugin's
// build (step 0) and by check-plugin-fresh.sh in CI.
import { existsSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";

// no tests/ dir, *.test.* or CLAUDE.md anywhere; then the allowlist itself
const ALLOWED = /^(?!(.*\/)?tests\/)(?!.*\.test\.)(?!(.*\/)?CLAUDE\.md$)(\.claude-plugin\/plugin\.json|\.mcp\.json|README\.md|hooks\/hooks\.json|agents\/[^/]+\.md|skills\/.+\/(SKILL|[^/]+\.reference)\.md|skills\/.+\.json|.+\.mjs)$/;

const root = path.join(process.argv[2] ?? ".", "plugin");
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
  .filter((f) => !ALLOWED.test(f) || lstatSync(path.join(root, f)).isSymbolicLink());
if (stray.length) {
  console.error(`${root} holds files the shipped plugin may not contain (sources and tests belong in src/ and tests/):`);
  for (const f of stray) console.error(`  ${f}`);
  process.exit(1);
}
