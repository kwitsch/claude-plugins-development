/**
 * Locate the dprint project config for a directory, shared by `mcp/format.mts` and `scan-plugins.mts`.
 *
 * @packageDocumentation
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { CONFIG_NAMES } from "./config-names.mjs";

/** Last hit per start dir; revalidated with one `existsSync`, so a deleted config is never reported. */
const hits = new Map<string, string>();

/**
 * First dprint config in `dir` or, like dprint itself, in the nearest ancestor that has one.
 *
 * @param dir - Directory to start from.
 * @returns Absolute path of the config, or `null` when none exists up to the filesystem root.
 */
export function findConfig(dir: string): string | null {
  const hit = hits.get(dir);
  // shortcut: a cached ancestor hit hides a closer config created later in the same session, restart to pick it up
  if (hit !== undefined && existsSync(hit)) return hit;
  for (let d = path.resolve(dir);; d = path.dirname(d)) {
    for (const n of CONFIG_NAMES) {
      const p = path.join(d, n);
      if (existsSync(p)) {
        hits.set(dir, p);
        return p;
      }
    }
    if (path.dirname(d) === d) return null;
  }
}
