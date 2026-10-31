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
 * Nothing is cached (a config created mid-session, e.g. by `dprint`, must be seen at once); the walk is
 * bounded by the git root, so it costs a few `existsSync` calls per directory level.
 *
 * @param dir - Directory to start from.
 * @returns The config found, or `null` when none exists up to that root (the filesystem root outside git).
 */
export function findConfig(dir: string): FoundConfig | null {
  for (let d = path.resolve(dir);; d = path.dirname(d)) {
    for (const name of CONFIG_NAMES) {
      if (existsSync(path.join(d, name))) return { dir: d, name };
    }
    if (existsSync(path.join(d, ".git")) || path.dirname(d) === d) return null;
  }
}
