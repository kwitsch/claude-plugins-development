// Helpers of the MCP wrapper `mcp.mts` (zero-dependency Node). The hooks are a function-hooks module (`src/hooks/register.mts`).
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve, sep } from "node:path";
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
 * Whether `graphmind setup` already registered its MCP server in Claude Code's global config `.claude.json`.
 *
 * @param configDir - Directory of that file: `CLAUDE_CONFIG_DIR`, else the home directory (as Claude Code resolves it).
 * @param cwd - Working directory: only the project entries of it and of its ancestors count (a server of another project is not active here).
 * @returns True when a server named `graphmind` exists at the top level or in a project entry that covers `cwd`.
 */
export function setupMcpPresent(configDir: string = process.env.CLAUDE_CONFIG_DIR || homedir(), cwd: string = process.cwd()): boolean {
  try {
    const text = readFileSync(join(configDir, ".claude.json"), "utf8");
    // The file can be several MB: parse it only when the name occurs at all.
    if (!text.includes("\"graphmind\"")) return false;
    const json = JSON.parse(text) as { mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> }> };
    if (json.mcpServers?.graphmind) return true;
    const here = resolve(cwd);
    return Object.entries(json.projects ?? {}).some(([root, p]) => Boolean(p.mcpServers?.graphmind) && (here === resolve(root) || here.startsWith(`${resolve(root)}${sep}`)));
  } catch {
    return false;
  }
}
