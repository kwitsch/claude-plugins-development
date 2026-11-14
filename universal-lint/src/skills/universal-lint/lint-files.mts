#!/usr/bin/env node
/**
 * universal-lint skill driver: lint a list of files with the plugin's own hook logic and print one aggregated,
 * read-only findings report. Reuses `lintFilesHandler` from the hook: no new linting logic, no autofix.
 *
 * @remarks
 * Reads a newline-delimited list file (argv[2]); each path is resolved against `process.cwd()` (spelled as `$PWD` when that is
 * the same directory through a symlink), which must contain
 * the file (`lintFilesHandler` scopes every file like the hook and silently skips files outside it). Batched: one
 * linter run per group of files sharing tool, local bin, spawn cwd and config-derived argv (one per package dir or
 * crate for go/cargo), at most `BATCH_MAX_FILES` files per run, tsc once per tsconfig; the report has one block per
 * tool run, naming every file of the run. `lintFilesHandler` is async (one spawn at a time, each a detached process group
 * killed as a whole on timeout); the driver awaits it (top-level await).
 *
 * @packageDocumentation
 */

import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { lintFilesHandler } from "../../hooks/lint-file.mjs";

/** The list file named on the command line. */
const listFile = process.argv[2];
if (!listFile) {
  console.error("usage: lint-files.mjs <listfile>");
  process.exit(2);
}

/**
 * Project root: every listed path is resolved against it. The shell's `PWD` when it names the same directory as
 * `process.cwd()` (which is always the real path): a symlinked session cwd keeps its symlink in Glob/pwd paths, as in
 * the hook's payload cwd, and a real-path root would reject them as outside it.
 */
let cwd = process.cwd();
try {
  const pwd = process.env.PWD;
  if (pwd && isAbsolute(pwd) && realpathSync(pwd) === cwd) cwd = pwd;
} catch {
  // stale or unreadable PWD: keep the real cwd
}

/** The listed paths, one per non-blank line. */
const paths = readFileSync(listFile, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

/** One findings block per tool run; empty on any throw or rejection (fail open, matching the hook). */
let blocks: string[];
try {
  blocks = await lintFilesHandler(cwd, paths.map((p) => resolve(cwd, p)));
} catch {
  blocks = [];
}

if (blocks.length === 0) {
  console.log("universal-lint: no findings.");
} else {
  console.log(blocks.join("\n\n"));
  console.log(`\nuniversal-lint: ${blocks.length} block(s) with findings.`);
}
process.exit(0);
