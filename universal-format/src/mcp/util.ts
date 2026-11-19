/**
 * The lookup of CLI formatters on PATH.
 *
 * @packageDocumentation
 */
import { accessSync, constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/** Whether a tool is on PATH, by tool name, for the life of the process. */
const probeCache = new Map<string, boolean>();

/** Whether `~/.local/bin` was already appended to this process's PATH. */
let pathExtended = false;

/**
 * Appends `~/.local/bin` to this process's PATH, once: user-level formatters are installed there, and the PATH of the
 * Claude Code process need not hold it. Appended, so a tool on the inherited PATH wins; the formatter children inherit
 * the same PATH.
 */
function extendPath(): void {
  if (pathExtended) return;
  pathExtended = true;
  const home = os.homedir();
  if (home) process.env.PATH = [process.env.PATH, path.join(home, ".local", "bin")].filter(Boolean).join(path.delimiter);
}

/**
 * Whether a tool is an executable on PATH (with `~/.local/bin` appended). Cached for the life of the process.
 *
 * @param tool - The executable's name.
 * @returns True when a PATH directory holds an executable of that name.
 */
export function onPath(tool: string): boolean {
  const cached = probeCache.get(tool);
  if (cached !== undefined) return cached;
  extendPath();
  let found = false;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      accessSync(path.join(dir, tool), fsConstants.X_OK);
      found = true;
      break;
    } catch {
      // keep looking
    }
  }
  probeCache.set(tool, found);
  return found;
}
