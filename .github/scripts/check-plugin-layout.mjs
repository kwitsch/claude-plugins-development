#!/usr/bin/env node
// Usage: check-plugin-layout.mjs <plugin dir>
// Fails when <plugin>/plugin/ holds a file the shipped plugin may not contain (.claude/rules/plugin-build-output.md).
// An allowlist: sources, tests, CLAUDE.md or tooling files belong outside plugin/. Called by every plugin's
// build (step 0) and by check-plugin-fresh.sh in CI.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

// no tests/ dir, *.test.* or CLAUDE.md anywhere; then the allowlist itself
const ALLOWED =
  /^(?!(.*\/)?tests\/)(?!.*\.test\.)(?!(.*\/)?CLAUDE\.md$)(\.claude-plugin\/plugin\.json|\.mcp\.json|README\.md|hooks\/hooks\.json|agents\/[^/]+\.md|skills\/.+\/(SKILL|[^/]+\.reference)\.md|skills\/.+\.json|.+\.mjs)$/;

const root = path.join(process.argv[2] ?? ".", "plugin");
// symlinks count as files: one could point at sources outside plugin/
const stray = (existsSync(root) ? readdirSync(root, { recursive: true, withFileTypes: true }) : [])
  .filter((d) => !d.isDirectory())
  .map((d) => path.relative(root, path.join(d.parentPath, d.name)).split(path.sep).join("/"))
  .filter((f) => !ALLOWED.test(f));
if (stray.length) {
  console.error(`${root} holds files the shipped plugin may not contain (sources and tests belong in src/ and tests/):`);
  for (const f of stray) console.error(`  ${f}`);
  process.exit(1);
}
