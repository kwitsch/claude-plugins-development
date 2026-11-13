/**
 * The files of a working directory that dprint formats, shared by the `watch-paths` command hook and the
 * server's `bash_finished` scan.
 *
 * @remarks
 * Imports neither `server.mjs` (it starts the server at import) nor `format.mjs`, so both can use it.
 *
 * @packageDocumentation
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { findConfig } from "../skills/dprint/find-config.mjs";
import { dprintArgv, findDprint } from "../skills/dprint/find-dprint.mjs";

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
 * @returns Absolute paths, sorted (a stable list for diffing); `[]` without a cwd, a dprint config, a way to run dprint
 * (binary or npx), or above {@link WATCH_LIMIT}. Rejects when dprint fails.
 */
export async function dprintFilePaths(cwd: string): Promise<string[]> {
  if (!cwd || findConfig(cwd) === null) return [];
  const cmd = await findDprint();
  if (cmd === null) return [];
  // async: the MCP server must keep answering other hooks while dprint lists the files
  const run = async (sub: string): Promise<string> =>
    (await promisify(execFile)(...dprintArgv(cmd, [sub]), {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    })).stdout;
  let out: string;
  try {
    out = await run("file-paths");
  } catch (e) {
    // dprint 0.50-0.54 call it output-file-paths (renamed in 0.55.0)
    if (!/unrecognized subcommand/.test((e as { stderr?: string }).stderr ?? "")) throw e;
    out = await run("output-file-paths");
  }
  const lines = out.split("\n").filter(Boolean);
  if (lines.length > WATCH_LIMIT) {
    process.stderr.write(
      `[dprint-hooks] file list: ${lines.length} files above ${WATCH_LIMIT}, FileChanged and Bash formatting off\n`,
    );
    return [];
  }
  return lines.sort();
}

/**
 * Collapse a file list to the directories Claude Code should watch instead of the files themselves.
 *
 * @remarks
 * Claude Code watches a directory recursively (checked live on 2.1.323: files created later, also in new
 * subdirectories, and files that are deleted and recreated, produce events), while a watched file that is unlinked
 * loses its watch. The price is every event below the directory: `.git`, `node_modules` and build output churn
 * reaches the `file_changed` hook too (about 100 events per second, 3000 files took 35 s). Hence opt-in
 * (`DPRINT_WATCH_DIRECTORIES=1`, e.g. in the `env` of the Claude Code settings).
 *
 * @param files - Absolute file paths.
 * @returns The sorted directories of the files, minus every directory below another one in the result.
 */
export function watchDirectories(files: string[]): string[] {
  // sorted with a trailing separator, so a directory is followed by its descendants and not by '/r/src-gen' or '/r/a.b'
  const dirs = [...new Set(files.map((f) => path.dirname(f)))].sort((a, b) => (a + path.sep < b + path.sep ? -1 : 1));
  const out: string[] = [];
  for (const d of dirs) {
    if (!out.some((o) => d === o || d.startsWith(o.endsWith(path.sep) ? o : o + path.sep))) out.push(d);
  }
  return out;
}
