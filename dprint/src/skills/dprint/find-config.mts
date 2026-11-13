/**
 * Locate the dprint project config for a directory, shared by `mcp/format.mts` and `scan-plugins.mts`.
 *
 * @packageDocumentation
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { CONFIG_NAMES } from "./config-names.mjs";

/** A found config: the directory holding it and its entry of {@link CONFIG_NAMES}. */
export type FoundConfig = {
  /** Absolute directory holding the config. */
  dir: string;
  /** The config's name relative to `dir`, e.g. `dprint.json` or `.config/dprint.jsonc`. */
  name: (typeof CONFIG_NAMES)[number];
};

/**
 * First dprint config in `dir` or in the nearest ancestor that has one, but never above the git repository root or,
 * inside a git worktree, the worktree root (the nearest directory holding `.git`, a directory or a file).
 *
 * @remarks
 * This is the format gate's own rule, not dprint's: `dprint lsp` resolves its config per file by itself and does
 * not stop at the git root, so a config above the root still applies to a started lsp but never opens the gate.
 * A config found in `dir` itself is cached and re-checked with one `existsSync` (a stat is expensive on 9P
 * mounts). Nothing else is cached: `null`, so a config created mid-session, e.g. by `dprint`, is seen at once, and a
 * config found in an ancestor, so a nearer one created later is seen at once too. The uncached walk is bounded by
 * the git root.
 *
 * @param dir - Directory to start from.
 * @returns The config found, or `null` when none exists up to that root (the filesystem root outside git).
 */
export function findConfig(dir: string): FoundConfig | null {
  const key = path.resolve(dir);
  const hit = cache.get(key);
  if (hit !== undefined) {
    // still there, and no name of higher priority (CONFIG_NAMES order) appeared next to it
    const higher = CONFIG_NAMES.slice(0, CONFIG_NAMES.indexOf(hit.name)).some((n) => existsSync(path.join(hit.dir, n)));
    if (!higher && existsSync(path.join(hit.dir, hit.name))) return hit;
    cache.delete(key);
  }
  const found = walk(key);
  if (found !== null && found.dir === key) {
    if (cache.size >= 64) cache.clear(); // bounded: one entry per distinct start directory
    cache.set(key, found);
  }
  return found;
}

/** Found configs by start directory; see {@link findConfig}. */
const cache = new Map<string, FoundConfig>();

/**
 * The uncached lookup of {@link findConfig}.
 *
 * @param start - Absolute directory to start from.
 * @returns The config found, or `null`.
 */
function walk(start: string): FoundConfig | null {
  for (let d = start;; d = path.dirname(d)) {
    for (const name of CONFIG_NAMES) {
      if (existsSync(path.join(d, name))) return { dir: d, name };
    }
    if (existsSync(path.join(d, ".git")) || path.dirname(d) === d) return null;
  }
}
