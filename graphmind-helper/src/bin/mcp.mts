#!/usr/bin/env node
// MCP wrapper: indexes the current project when needed, then serves `graphmind mcp` over inherited stdio.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { findGraphmind, registered, setupMcpPresent } from "./common.mjs";

/**
 * Whether `dir` is a git work tree root or inside one (a `.git` entry in it or an ancestor) and not the home directory.
 *
 * @param dir - Absolute directory.
 * @returns True when init may index it.
 */
export function indexable(dir: string): boolean {
  if (resolve(dir) === resolve(homedir())) return false;
  for (let d = resolve(dir);; d = resolve(d, "..")) {
    if (existsSync(join(d, ".git"))) return true;
    if (resolve(d, "..") === d) return false;
  }
}

/** Runs init (registration and git hooks, no build), starts the build in the background, then serves MCP. */
function main(): void {
  const bin = findGraphmind();
  if (!bin) {
    process.stderr.write("graphmind-helper: the graphmind binary was not found, MCP server not started\n");
    process.exit(1);
  }
  const cwd = process.cwd();
  if (indexable(cwd) && !registered(bin)) {
    // Registration and git hooks are fast; the graph build of a large repo could outlast the MCP startup timeout.
    const init = spawnSync(bin, ["init", "--skip-build"], { cwd, stdio: ["ignore", "ignore", "inherit"], timeout: 30_000 });
    if (init.status === 0) spawn(bin, ["build"], { cwd, detached: true, stdio: "ignore" }).unref();
  }
  // The user's own `graphmind setup` server (same tools) stays the one in use.
  if (setupMcpPresent()) process.exit(0);
  const child = spawn(bin, ["mcp"], { cwd, stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
  child.on("error", () => process.exit(1));
}

// Not run when a test imports `indexable`.
if (process.argv[1]?.endsWith("mcp.mjs")) main();
