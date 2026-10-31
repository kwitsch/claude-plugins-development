/**
 * Shared dprint lookup (binary and project config) used by `check-dprint.mts`, `run-dprint.mts` and the MCP
 * server's lsp client (`mcp/lsp.mts`).
 *
 * @packageDocumentation
 */

import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CONFIG_NAMES } from "./config-names.mjs";

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

/**
 * Find the project dprint config the way dprint does: the first of `CONFIG_NAMES` in `start`, else in each
 * ancestor directory up to the filesystem root.
 *
 * @param start - Directory to start in (normally `process.cwd()`).
 * @returns Absolute path of the config file, or `null` when no directory up to the root has one.
 */
export function findConfig(start: string): string | null {
  for (let dir = resolve(start);; dir = dirname(dir)) {
    // shortcut: a directory named like a config counts as found (same as scan-plugins), switch to statSync().isFile() if that ever matters
    for (const name of CONFIG_NAMES) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
    if (dirname(dir) === dir) return null;
  }
}
