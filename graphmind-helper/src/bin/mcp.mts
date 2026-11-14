#!/usr/bin/env node
// MCP wrapper: indexes the current project when needed, then serves `graphmind mcp` over inherited stdio.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { findGraphmind, registered, setupMcpPresent } from "./common.mjs";

/**
 * The real path of `p`, or `p` resolved when it does not exist.
 *
 * @param p - Path.
 * @returns Absolute path with symlinks followed where possible.
 */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * The git work tree root `dir` is or lies inside (a `.git` entry in it or an ancestor) and not the home directory.
 *
 * @param dir - Absolute directory.
 * @returns The work tree root init may index, or undefined.
 */
export function indexable(dir: string): string | undefined {
  // Real paths on both sides: a symlinked HOME (FreeBSD /home -> /usr/home) would never equal the real cwd.
  const home = real(homedir());
  for (let d = real(dir);; d = resolve(d, "..")) {
    // A dotfiles repo at $HOME must not make every folder below it indexable.
    if (d === home) return undefined;
    if (existsSync(join(d, ".git"))) return d;
    if (resolve(d, "..") === d) return undefined;
  }
}

/** Runs init (registration and git hooks, no build), starts the build in the background, then serves MCP. */
function main(): void {
  const bin = findGraphmind();
  if (!bin) {
    process.stderr.write("graphmind-helper: the graphmind binary was not found, MCP server not started\n");
    process.exit(1);
  }
  // init writes `command -v graphmind` (else ~/.graphmind/bin/graphmind) into its project server: an off-PATH binary must be found.
  process.env.PATH = dirname(bin) + delimiter + (process.env.PATH ?? "");
  const cwd = process.cwd();
  // Checked before init: init adds its own project entry to .claude.json, which this session has not loaded.
  const setupPresent = setupMcpPresent();
  const root = indexable(cwd);
  if (root && !registered(bin)) {
    // Registration and git hooks are fast; the graph build of a large repo could outlast the MCP startup timeout.
    // The work tree root, not a subdirectory the session started in: init would register only that part of the repo.
    const init = spawnSync(bin, ["init", "--skip-build"], { cwd: root, stdio: ["ignore", "ignore", "inherit"], timeout: 30_000 });
    // The no-op error listener: an unhandled spawn 'error' (EACCES) would crash the wrapper before it serves.
    if (init.status === 0) spawn(bin, ["build"], { cwd: root, detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  }
  // The user's own `graphmind setup` server (same tools) stays the one in use.
  if (setupPresent) process.exit(0);
  // No cwd option: process.cwd() mangles a non-UTF-8 folder name, and spawning there fails with ENOENT.
  const child = spawn(bin, ["mcp"], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
  child.on("error", () => process.exit(1));
}

// Not run when a test imports `indexable`.
if (process.argv[1]?.endsWith("mcp.mjs")) main();
