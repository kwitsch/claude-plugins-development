// Helpers of the MCP wrapper `mcp.mts` (zero-dependency Node). The hooks are a function-hooks module (`src/hooks/register.mts`).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve, sep } from "node:path";
import { binaryDirs } from "../hooks/terms.mjs";

/**
 * The graphmind binary: the first one on PATH, else the places the setup scripts add to PATH (`binaryDirs`, shared with the module).
 *
 * @param env - Process environment.
 * @returns Absolute path, `undefined` when there is none.
 */
export function findGraphmind(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return binaryDirs(env.PATH, homedir(), delimiter).map((d) => join(d, "graphmind")).find((p) => existsSync(p));
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
 * Whether `graphmind setup` already registered its MCP server in `~/.claude.json`.
 *
 * @param home - Home directory.
 * @param cwd - Working directory: only the project entries of it and of its ancestors count (a server of another project is not active here).
 * @returns True when a server named `graphmind` exists at the top level or in a project entry that covers `cwd`.
 */
export function setupMcpPresent(home: string = homedir(), cwd: string = process.cwd()): boolean {
  try {
    const text = readFileSync(join(home, ".claude.json"), "utf8");
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
