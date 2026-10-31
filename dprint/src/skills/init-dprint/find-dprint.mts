/**
 * Shared dprint lookup used by `check-dprint.mts` and the MCP server's lsp client (`mcp/lsp.mts`).
 *
 * @packageDocumentation
 */

import { accessSync, statSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Check whether a path is a regular file this user may execute.
 *
 * @param p - Path to test.
 * @returns `true` for an executable regular file, `false` otherwise (including when it does not exist).
 */
function isExecutableFile(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Find the dprint binary: the first executable `dprint` on `PATH`, else `~/.dprint/bin/dprint` (the
 * install script's default location).
 *
 * @returns Absolute path of the dprint binary, or `null` when neither location has one.
 */
export function findDprint(): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const p = resolve(dir, "dprint");
    if (isExecutableFile(p)) return p;
  }
  const fallback = join(homedir(), ".dprint", "bin", "dprint");
  return isExecutableFile(fallback) ? fallback : null;
}
