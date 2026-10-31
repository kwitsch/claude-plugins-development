/**
 * Command hook for SessionStart and CwdChanged: prints the FileChanged watch list
 * (`hookSpecificOutput.watchPaths`) for the working directory.
 *
 * @remarks
 * A `command` hook, not an `mcp_tool` hook: Claude Code skips SessionStart `mcp_tool` hooks while the MCP server
 * is still connecting. The list is what `dprint file-paths` (dprint 0.50-0.54: `output-file-paths`) reports in the
 * cwd, filtered by `inScope`. On CwdChanged the list replaces the previous one, so empty output in a config-less
 * cwd stops watching. Must not import `server.mjs` (it starts the server at import). Sync calls are fine: this is
 * its own short-lived process. Always exits 0; stdout carries exactly one JSON object or nothing.
 *
 * @packageDocumentation
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { findConfig } from "../skills/dprint/find-config.mjs";
import { findDprint } from "../skills/dprint/find-dprint.mjs";
import { inScope, scopeOf } from "./format.mjs";

/**
 * Most files watched per cwd.
 *
 * @remarks
 * Claude Code adds one inotify watch per watched directory and the list travels as hook output; above this limit
 * FileChanged formatting is off for that cwd.
 */
const WATCH_LIMIT = 5000;

/**
 * Files of the cwd that dprint formats and that are in scope.
 *
 * @param cwd - Working directory.
 * @param scratchpadDir - Session scratchpad (excluded), if any.
 * @returns Absolute paths as dprint printed them; `[]` without a cwd, a dprint config, a dprint binary, or above
 * {@link WATCH_LIMIT}.
 */
function watchList(cwd: string, scratchpadDir: string | undefined): string[] {
  if (!cwd || findConfig(cwd) === null) return [];
  const bin = findDprint();
  if (bin === null) return [];
  const run = (sub: string): string =>
    execFileSync(bin, [sub], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  let out: string;
  try {
    out = run("file-paths");
  } catch (e) {
    // dprint 0.50-0.54 call it output-file-paths (renamed in 0.55.0)
    if (!/unrecognized subcommand/.test((e as { stderr?: string }).stderr ?? "")) throw e;
    out = run("output-file-paths");
  }
  const lines = out.split("\n").filter(Boolean);
  // checked before the per-path realpath pass
  if (lines.length > WATCH_LIMIT) {
    process.stderr.write(
      `[dprint-hooks] watch-paths: ${lines.length} files above ${WATCH_LIMIT}, FileChanged formatting off\n`,
    );
    return [];
  }
  const sc = scopeOf({ cwd, scratchpad_dir: scratchpadDir });
  if (sc === null) return [];
  return lines.filter((p) => inScope(sc, p) !== null);
}

/**
 * Read the hook event from stdin and print the watch list; fails open (stderr line, empty stdout, exit 0).
 */
function main(): void {
  try {
    const input = JSON.parse(readFileSync(0, "utf8")) as {
      hook_event_name?: string;
      cwd?: string;
      new_cwd?: string;
      scratchpad_dir?: string;
    };
    const ev = input.hook_event_name;
    if (ev !== "SessionStart" && ev !== "CwdChanged") return;
    const watchPaths = watchList(
      input.new_cwd || input.cwd || "",
      input.scratchpad_dir,
    );
    if (watchPaths.length) {
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: ev, watchPaths } }),
      );
    }
  } catch (e) {
    process.stderr.write(
      `[dprint-hooks] watch-paths failed open: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}

main();
