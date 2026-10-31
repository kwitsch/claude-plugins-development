// Shared dprint lookup: first executable on PATH, else ~/.dprint/bin/dprint.
// Used by check-dprint.mts and the MCP server's lsp client (mcp/lsp.mts).

import { accessSync, statSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** true when p is a regular file executable by this user */
function isExecutableFile(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** absolute path of the dprint to use, or null */
export function findDprint(): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const p = resolve(dir, "dprint");
    if (isExecutableFile(p)) return p;
  }
  const fallback = join(homedir(), ".dprint", "bin", "dprint");
  return isExecutableFile(fallback) ? fallback : null;
}
