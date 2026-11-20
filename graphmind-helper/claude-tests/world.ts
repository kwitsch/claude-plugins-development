// What the fake world of graphmind-helper answers, shared by tests/support/kit.ts (vitest, claude-engine-vitest) and
// register.test.ts (`claude plugin test`). No imports: `claude plugin test` runs it from a temp copy without node_modules.

/** The graphmind binary of the default world (`~/.local/bin` of `/home/u`). */
export const BIN = "/home/u/.local/bin/graphmind";

/** The plugin's own server's tools. */
export const OWN = ["status", "map", "memory_list", "search"].map((t) => ({ name: `mcp__plugin_graphmind-helper_graphmind__gm_${t}`, description: "", mcp: true }));

/**
 * The value of an environment variable of the fake world.
 *
 * @param name - The variable.
 * @param w - Overrides: `home`, `path`, `configDir`.
 * @returns The value, or undefined when the world does not set it.
 */
export function envValue(name: string, w: { home?: string; path?: string; configDir?: string } = {}): string | undefined {
  return name === "HOME" ? (w.home ?? "/home/u") : name === "PATH" ? (w.path ?? "/usr/bin") : name === "CLAUDE_CONFIG_DIR" ? w.configDir : undefined;
}

/**
 * The stdout of a `graphmind` CLI run of the fake world.
 *
 * @param argv - The argv of the run (`[binary, "memory", "list", ...]`).
 * @param w - Overrides: `priority` (memory list), `search` (memory search).
 * @returns The output text.
 */
export function processOut(argv: readonly string[], w: { priority?: string; search?: string } = {}): string {
  if (argv[1] === "memory" && argv[2] === "list") return w.priority ?? ">> p\n★ aaaaaaaa [decision] always use X\n";
  if (argv[2] === "search") return w.search ?? "bbbbbbbb [pattern] about foo_bar\n";
  return "";
}

/**
 * The text of an MCP tool of the fake world.
 *
 * @param tool - The full tool name (`mcp__…__gm_status`).
 * @param w - Overrides: `map`, `recent` (memory list).
 * @returns The tool's text.
 */
export function mcpText(tool: string, w: { map?: string; recent?: string } = {}): string {
  if (tool.endsWith("__gm_status")) return "Project: p\nGraph: 1 symbols";
  if (tool.endsWith("__gm_map")) return w.map ?? ">> map\n  top file";
  if (tool.endsWith("__gm_memory_list")) return w.recent ?? ">> 1\n  [decision] recent one (id: x)";
  return "  foo [Function] a.ts:1";
}
