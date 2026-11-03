/**
 * The files of a working directory that dprint formats, shared by the `watch-paths` command hook and the
 * server's `bash_finished` scan.
 *
 * @remarks
 * Imports neither `server.mjs` (it starts the server at import) nor `format.mjs`, so both can use it.
 *
 * @packageDocumentation
 */
import { execFileSync } from "node:child_process";
import { findConfig } from "../skills/dprint/find-config.mjs";
import { findDprint } from "../skills/dprint/find-dprint.mjs";

/**
 * Most files watched per cwd.
 *
 * @remarks
 * Claude Code adds one inotify watch per watched directory and the list travels as hook output; above this limit
 * FileChanged formatting is off for that cwd.
 */
export const WATCH_LIMIT = 5000;

/**
 * Files of the cwd that dprint formats, before any scope filter.
 *
 * @param cwd - Working directory.
 * @returns Absolute paths as dprint printed them; `[]` without a cwd, a dprint config, a dprint binary, or above
 * {@link WATCH_LIMIT}. Throws when dprint fails.
 */
export function dprintFilePaths(cwd: string): string[] {
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
  if (lines.length > WATCH_LIMIT) {
    process.stderr.write(
      `[dprint-hooks] watch-paths: ${lines.length} files above ${WATCH_LIMIT}, FileChanged formatting off\n`,
    );
    return [];
  }
  return lines;
}
