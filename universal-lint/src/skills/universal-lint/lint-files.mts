#!/usr/bin/env node
/**
 * universal-lint skill driver: run the plugin's own lint handler over a list of files and print one aggregated,
 * read-only findings report. Reuses `lintFileHandler` from the hook verbatim: no new linting logic, no autofix.
 *
 * @remarks
 * Reads a newline-delimited list file (argv[2]); each path is resolved against `process.cwd()`, which must contain
 * the file (`lintFileHandler` hard-gates on containment and silently skips files outside it). `lintFileHandler` is
 * synchronous (spawnSync internally) and bypasses the hook's 5s debounce (which lives only in the hook's entry
 * point, never in the handler).
 *
 * shortcut: `lintFileHandler` reruns a whole-project `tsc --noEmit` per .ts file; the incremental buildinfo cache
 * keeps repeats cheap. Batch-per-tsconfig dedup is a future optimization only if a large .ts batch ever bites.
 *
 * @packageDocumentation
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { lintFileHandler } from "../../hooks/lint-file.mjs";

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

/**
 * The PostToolUse payload `lintFileHandler` expects, for a file written by Write.
 *
 * @param resolved - Absolute path of the file to lint.
 * @returns The hook payload.
 */
function mkArgs(resolved: string): Parameters<typeof lintFileHandler>[0] {
  return {
    session_id: "universal-lint-skill",
    transcript_path: "/dev/null",
    cwd,
    permission_mode: "default",
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: resolved },
    tool_response: { success: true },
  };
}

/** The findings text of every file with findings. */
const blocks: string[] = [];
for (const p of paths) {
  const resolved = resolve(cwd, p);
  try {
    const result = lintFileHandler(mkArgs(resolved));
    const ctx = result.hookSpecificOutput?.additionalContext;
    if (typeof ctx === "string" && ctx.length > 0) blocks.push(ctx);
  } catch {
    // fail open per file, matching the hook
  }
}

if (blocks.length === 0) {
  console.log("universal-lint: no findings.");
} else {
  console.log(blocks.join("\n\n"));
  console.log(`\nuniversal-lint: ${blocks.length} file(s) with findings.`);
}
process.exit(0);
