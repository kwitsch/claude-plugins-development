/**
 * Command hook for SessionStart and CwdChanged: prints the FileChanged watch list
 * (`hookSpecificOutput.watchPaths`) for the working directory.
 *
 * @remarks
 * A `command` hook, not an `mcp_tool` hook: Claude Code skips SessionStart `mcp_tool` hooks while the MCP server
 * is still connecting. With `DPRINT_WATCH_DIRECTORIES=1` the list is collapsed to directories, see {@link watchDirectories}. The list is what `dprint file-paths`
 * (dprint 0.50-0.54: `output-file-paths`) reports in the cwd, filtered by `inScope`. On CwdChanged the list replaces the previous one, so empty output in a config-less
 * cwd stops watching. Must not import `server.mjs` (it starts the server at import). Sync calls are fine: this is
 * its own short-lived process. Always exits 0; stdout carries exactly one JSON object or nothing.
 *
 * @packageDocumentation
 */
import { readFileSync } from "node:fs";
import { inScope, scopeOf } from "./format.mjs";
import { dprintFilePaths, watchDirectories } from "./watch-list.mjs";

/**
 * Files of the cwd that dprint formats and that are in scope.
 *
 * @param cwd - Working directory.
 * @param scratchpadDir - Session scratchpad (excluded), if any.
 * @returns Absolute paths as dprint printed them, see {@link dprintFilePaths}, minus out-of-scope ones.
 */
async function watchList(cwd: string, scratchpadDir: string | undefined): Promise<string[]> {
  const lines = await dprintFilePaths(cwd);
  const sc = scopeOf({ cwd, scratchpad_dir: scratchpadDir });
  if (sc === null) return [];
  return lines.filter((p) => inScope(sc, p) !== null);
}

/**
 * Read the hook event from stdin and print the watch list; fails open (stderr line, empty stdout, exit 0).
 */
async function main(): Promise<void> {
  try {
    const input = JSON.parse(readFileSync(0, "utf8")) as {
      hook_event_name?: string;
      cwd?: string;
      new_cwd?: string;
      scratchpad_dir?: string;
    };
    const ev = input.hook_event_name;
    if (ev !== "SessionStart" && ev !== "CwdChanged") return;
    const files = await watchList(
      input.new_cwd || input.cwd || "",
      input.scratchpad_dir,
    );
    const watchPaths = process.env.DPRINT_WATCH_DIRECTORIES === "1" ? watchDirectories(files) : files;
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

await main();
