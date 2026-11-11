#!/usr/bin/env node
/**
 * universal-lint skill driver: lint a list of files with the plugin's own hook logic and print one aggregated,
 * read-only findings report. Reuses `lintFilesHandler` from the hook: no new linting logic, no autofix.
 *
 * @remarks
 * Reads a newline-delimited list file (argv[2]); each path is resolved against `process.cwd()`, which must contain
 * the file (`lintFilesHandler` scopes every file like the hook and silently skips files outside it). Batched: one
 * linter run per group of files sharing tool, local bin, spawn cwd and config-derived argv (one per package dir or
 * crate for go/cargo), at most `BATCH_MAX_FILES` files per run, tsc once per tsconfig; the report has one block per
 * tool run, naming every file of the run. `lintFilesHandler` is synchronous (spawnSync internally).
 *
 * @packageDocumentation
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { lintFilesHandler } from "../../hooks/lint-file.mjs";

/** The list file named on the command line. */
const listFile = process.argv[2];
if (!listFile) {
  console.error("usage: lint-files.mjs <listfile>");
  process.exit(2);
}

/** Project root: every listed path is resolved against it. */
const cwd = process.cwd();

/** The listed paths, one per non-blank line. */
const paths = readFileSync(listFile, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

/** One findings block per tool run; empty on any throw (fail open, matching the hook). */
let blocks: string[];
try {
  blocks = lintFilesHandler(cwd, paths.map((p) => resolve(cwd, p)));
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
