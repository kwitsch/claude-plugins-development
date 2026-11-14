// Shared helpers of the graphmind-helper hook scripts and the MCP wrapper (zero-dependency Node).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** Where the hook output limit of Claude Code cuts a message, in characters (the setup scripts use the same). */
export const MAX_CHARS = 9000;

/** The scripts `graphmind setup` installs; their names in `~/.claude/settings.json` mean the user already wired the hooks. */
const SETUP_HOOKS = ["graphmind-session.sh", "graphmind-prompt.sh", "graphmind-search.sh"];

/**
 * The graphmind binary: the first one on PATH, else the places the setup scripts add to PATH.
 *
 * @remarks
 * `src/hooks/notice.mts` (no imports allowed there) repeats this directory list; keep both in step.
 *
 * @param env - Process environment.
 * @returns Absolute path, `undefined` when there is none.
 */
export function findGraphmind(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = homedir();
  const dirs = [...(env.PATH ?? "").split(delimiter).filter((d) => d.startsWith("/")), join(home, ".graphmind", "bin"), join(home, ".local", "bin"), "/usr/local/bin"];
  return dirs.map((d) => join(d, "graphmind")).find((p) => existsSync(p));
}

/** Result of one {@link run}. */
export type Run = {
  /** Exit status, `null` when the program could not start or timed out. */
  status: number | null;
  /** Standard output, empty on failure. */
  stdout: string;
};

/**
 * Runs the binary without a shell.
 *
 * @param bin - Program.
 * @param args - Arguments.
 * @param timeoutMs - Kill after this long.
 * @returns Status and stdout; never throws.
 */
export function run(bin: string, args: string[], timeoutMs = 20_000): Run {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"] });
  return { status: r.status, stdout: r.stdout ?? "" };
}

/**
 * Whether the working directory is inside a registered graphmind project (`graphmind which` exits 0).
 *
 * @param bin - The binary.
 * @returns True when registered.
 */
export function registered(bin: string): boolean {
  return run(bin, ["which"], 10_000).status === 0;
}

/**
 * Whether `graphmind setup` already wired its hooks into the user's settings, so the plugin's hooks would inject twice.
 *
 * @param home - Home directory.
 * @returns True when one of the setup scripts is named in `~/.claude/settings.json`.
 */
export function setupHooksPresent(home: string = homedir()): boolean {
  try {
    const text = readFileSync(join(home, ".claude", "settings.json"), "utf8");
    return SETUP_HOOKS.some((s) => text.includes(s));
  } catch {
    return false;
  }
}

/**
 * Whether `graphmind setup` already registered its MCP server in `~/.claude.json`.
 *
 * @param home - Home directory.
 * @returns True when a server named `graphmind` exists at the top level or in a project entry.
 */
export function setupMcpPresent(home: string = homedir()): boolean {
  try {
    const text = readFileSync(join(home, ".claude.json"), "utf8");
    // The file can be several MB: parse it only when the name occurs at all.
    if (!text.includes("\"graphmind\"")) return false;
    const json = JSON.parse(text) as { mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> }> };
    return Boolean(json.mcpServers?.graphmind) || Object.values(json.projects ?? {}).some((p) => Boolean(p.mcpServers?.graphmind));
  } catch {
    return false;
  }
}

/**
 * A payload field as text.
 *
 * @param v - Any JSON value.
 * @returns The value when it is a string, else `""`.
 */
export function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * The per-session state directory (the same one the setup scripts use).
 *
 * @param sessionId - The payload's session id.
 * @param home - Home directory.
 * @returns Absolute path.
 */
export function stateDir(sessionId: unknown, home: string = homedir()): string {
  const id = (typeof sessionId === "string" ? sessionId : "").replace(/[^A-Za-z0-9_-]/g, "");
  return join(home, ".graphmind", "hook-state", id || "default");
}

/**
 * Reads the hook payload from stdin.
 *
 * @returns The parsed payload, `{}` when stdin is empty or invalid.
 */
export function readInput(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(0, "utf8") || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Prints the hook answer that adds context.
 *
 * @param event - Hook event name.
 * @param text - The context.
 */
export function emit(event: string, text: string): void {
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })}\n`);
}

/**
 * The 8-character entry id a listing line starts with (after an optional star).
 *
 * @param line - A `graphmind memory list` line.
 * @returns The id, `undefined` when the line has none.
 */
export function entryId(line: string): string | undefined {
  return /[0-9a-f]{8}/.exec(line)?.[0];
}

/**
 * The entry ids of the listing lines that appear whole in the message: what the session has actually seen.
 *
 * @param msg - The message that goes to the model.
 * @param lines - Listing lines offered for it.
 * @returns The ids, one per included line.
 */
export function wholeIds(msg: string, lines: string[]): string[] {
  const whole = new Set(msg.split("\n"));
  return lines.filter((l) => whole.has(l)).map(entryId).filter((i): i is string => i !== undefined);
}

/**
 * Keeps the non-empty listing lines that are not graphmind's `>>` header.
 *
 * @param out - Command output.
 * @returns The lines.
 */
export function listing(out: string): string[] {
  return out.split("\n").filter((l) => l.trim() !== "" && !l.startsWith(">>"));
}
