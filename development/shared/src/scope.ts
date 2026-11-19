/**
 * Path-scope helpers of the plugins that format or lint files from hooks: which paths are never touched, whether a
 * path leaves a directory, the real path of a file that may not exist yet, and the upward directory walk.
 *
 * @packageDocumentation
 */
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * Whether a base-relative path is never formatted or linted: dependency and VCS state (`node_modules`, `vendor`,
 * `.git`), Claude Code's own subtrees `.claude/worktrees` and `.claude/agent-memory` (not `.claude/` as a whole), and
 * personal override files (`*.local.*`, by basename). Must get the path relative to the base directory: the absolute
 * path of a session inside its own worktree contains `.claude/worktrees`.
 *
 * @param rel - The path relative to the base directory.
 * @returns True when the path is excluded.
 */
export function isExcludedPath(rel: string): boolean {
  const segments = rel.split(path.sep);
  if (segments.some((s) => s === "node_modules" || s === "vendor" || s === ".git")) return true;
  if (hasClaudeInternal(segments)) return true;
  return segments[segments.length - 1].includes(".local.");
}

/**
 * Whether one of Claude Code's own subtrees (`.claude/worktrees`, `.claude/agent-memory`) is part of a path.
 *
 * @param segments - The path's segments.
 * @returns True when the path leads into such a subtree.
 */
export function hasClaudeInternal(segments: string[]): boolean {
  return segments.some((s, i) => s === ".claude" && (segments[i + 1] === "worktrees" || segments[i + 1] === "agent-memory"));
}

/**
 * Whether a `path.relative(root, p)` result leaves `root` (`..`, `../x`, or another root). Never a `startsWith`
 * prefix test on the paths: that answered "outside" for every file when the root had a trailing separator or was `/`.
 *
 * @param rel - Relative path from the root.
 * @returns True when `p` lies outside the root.
 */
export function outside(rel: string): boolean {
  return rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
}

/**
 * The path of `resolved` relative to `dir` when `dir` is it or contains it.
 *
 * @param dir - The directory.
 * @param resolved - The absolute path.
 * @returns The relative path (empty for `dir` itself), or null when `dir` does not contain it.
 */
export function relativeIfContains(dir: string, resolved: string): string | null {
  const rel = path.relative(dir, resolved);
  return outside(rel) ? null : rel;
}

/**
 * Real path of `p`, also for a path that does not exist yet (the new file of a Write).
 *
 * @remarks
 * A missing path resolves through its nearest existing ancestor. A dangling symlink, or a link that cannot be
 * resolved (`ELOOP`, `EACCES`), throws: falling back to the lexical path of a dangling link would let a Write
 * follow it out of the cwd.
 *
 * @param p - Path to resolve.
 * @returns The real path of `p`, or of its nearest existing ancestor joined with the missing rest.
 */
export function realish(p: string): string {
  try {
    return realpathSync.native(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    try {
      lstatSync(p);
    } catch {
      const dir = path.dirname(p);
      return dir === p ? p : path.join(realish(dir), path.basename(p));
    }
    throw e; // p itself exists: a dangling symlink
  }
}

/**
 * Walks from a directory up to the filesystem root (inclusive) until the callback answers true.
 *
 * @param dir - The directory to start at.
 * @param checkDir - Called for each directory; true ends the walk.
 * @returns True when a directory was accepted, false when the root was passed.
 */
export function walkToRoot(dir: string, checkDir: (dir: string) => boolean): boolean {
  for (;;) {
    if (checkDir(dir)) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}
