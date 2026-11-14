// Helpers of the MCP wrapper `mcp.mts` (zero-dependency Node). The hooks are a function-hooks module (`src/hooks/register.mts`).
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { binaryDirs } from "../hooks/terms.mjs";

/**
 * The graphmind binary: the first executable file on PATH, else in the places the setup scripts add to PATH (`binaryDirs`, shared
 * with the module). Like `command -v`, a directory or a non-executable `graphmind` is skipped.
 *
 * @param env - Process environment.
 * @returns Absolute path, `undefined` when there is none.
 */
export function findGraphmind(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return binaryDirs(env.PATH, homedir(), delimiter).map((d) => join(d, "graphmind")).find(isExecutableFile);
}

/**
 * Whether a path is an executable regular file (symlinks followed).
 *
 * @param p - The path.
 * @returns `true` for an executable file.
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
 * Whether the working directory is inside a registered graphmind project (`graphmind which` exits 0).
 *
 * @param bin - The binary.
 * @returns True when registered.
 */
export function registered(bin: string): boolean {
  return spawnSync(bin, ["which"], { timeout: 10_000, stdio: "ignore" }).status === 0;
}

/**
 * The `projects` key of `.claude.json` that Claude Code reads for `cwd`: the git root (for a linked worktree the main checkout's
 * root), outside git the real `cwd`. Only that one entry is loaded, never those of ancestors.
 *
 * @param cwd - Working directory.
 * @returns Absolute real path.
 */
export function claudeProjectKey(cwd: string): string {
  const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"], { cwd, encoding: "utf8", timeout: 10_000 });
  const [top, gitDir, common] = r.status === 0 ? r.stdout.trim().split("\n") : [];
  // A linked worktree's git dir differs from the common one; a submodule's does not (its root is its own top level).
  const key = top ? (common && gitDir !== common ? dirname(common) : top) : cwd;
  try {
    return realpathSync(key);
  } catch {
    return key;
  }
}

/**
 * Whether `graphmind setup` already registered its MCP server in Claude Code's global config `.claude.json`.
 *
 * @param configDir - Directory of that file: `CLAUDE_CONFIG_DIR`, else the home directory (as Claude Code resolves it).
 * @param cwd - Working directory: only the project entry Claude Code loads for it counts (`claudeProjectKey`).
 * @returns True when a server named `graphmind` exists at the top level or in that project entry.
 */
export function setupMcpPresent(configDir: string = process.env.CLAUDE_CONFIG_DIR || homedir(), cwd: string = process.cwd()): boolean {
  try {
    const text = readFileSync(join(configDir, ".claude.json"), "utf8");
    // The file can be several MB: parse it only when the name occurs at all.
    if (!text.includes("\"graphmind\"")) return false;
    const json = JSON.parse(text) as { mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> }> };
    return Boolean(json.mcpServers?.graphmind ?? json.projects?.[claudeProjectKey(cwd)]?.mcpServers?.graphmind);
  } catch {
    return false;
  }
}
