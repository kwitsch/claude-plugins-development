// The fake environment of graphmind-helper's tests, bound to the built plugin/hooks/register.mjs on claude-engine-vitest:
// stubs answer the engine calls (tool list and calls, process.run, fs, env, cwd, toast); prompt.submit and tool.call end
// in recording stubs, so the tests read the context the mod added. Imports no source of the plugin (.claude/rules/hook-tests.md).
import { createKit } from "claude-engine-vitest";
import type { On } from "claude-engine-vitest";

/** The manifest defaults (package.json claudePlugin.userConfig): graphmind-helper has none. */
export const DEFAULTS = {};

/** The kit's mock helpers, as createKit returns them. */
export type MockKit = ReturnType<typeof createKit>["mock"];

/** The session's working directory. */
export const CWD = "/proj";
/** The graphmind binary of the default world (`~/.local/bin` of `/home/u`). */
export const BIN = "/home/u/.local/bin/graphmind";
/** The default user settings path. */
export const SETTINGS = "/home/u/.claude/settings.json";
/** The plugin's own server's tools. */
export const OWN = ["status", "map", "memory_list", "search"].map((t) => ({ name: `mcp__plugin_graphmind-helper_graphmind__gm_${t}`, description: "", mcp: true }));
/** A `graphmind setup` server's tools. */
export const SETUP = ["status", "map", "memory_list", "search"].map((t) => ({ name: `mcp__graphmind__gm_${t}`, description: "", mcp: true }));

/**
 * A kit bound to the built register.mjs with the given userConfig options.
 *
 * @param options - The manifest defaults of the test.
 * @returns The kit's `test` and `mock`, and `setup` bound to that mock.
 */
export function makeKit(options: Record<string, unknown> = DEFAULTS) {
  const kit = createKit({ module: new URL("../../plugin/hooks/register.mjs", import.meta.url), plugin: "graphmind-helper", options });
  return { ...kit, setup: (on: On, w?: World) => setupWith(kit.mock, on, w) };
}

/** The test's `$` (the kit does not export its type). */
export type Runner = Parameters<Parameters<ReturnType<typeof makeKit>["test"]>[2]>[0];

/** What the fake world looks like. */
export type World = {
  /** Tools `$.tool.list()` reports. */
  tools?: { name: string; description: string; mcp: boolean }[];
  /** Paths `fs.exists` reports (`fs.stat`: as files). */
  files?: string[];
  /** Paths `fs.stat` reports as directories. */
  dirs?: string[];
  /** Contents of settings.json when it exists. */
  settings?: string;
  /** Path of that settings.json (default: `~/.claude/settings.json`). */
  settingsPath?: string;
  /** Value of `CLAUDE_CONFIG_DIR` (default: unset). */
  configDir?: string;
  /** Value of `PATH` (default: `/usr/bin`). */
  path?: string;
  /** Value of `HOME` (default: `/home/u`). */
  home?: string;
  /** `gm_status` fails (project not registered). */
  unregistered?: boolean;
  /** `gm_status` answers a result without any text part. */
  emptyStatus?: boolean;
  /** Output of `graphmind memory search`. */
  search?: string;
  /** Text of `gm_memory_list`. */
  recent?: string;
  /** Output of `graphmind memory list --priority`. */
  priority?: string;
  /** Text of `gm_map`. */
  map?: string;
  /** `session.compact` answers a skip instead of messages. */
  compactSkip?: boolean;
};

/**
 * Stubs every engine call of the module. One `setup` per test: `on()` after the test's first `$` call throws.
 *
 * @param mock - The kit's mock helpers.
 * @param on - The test's `on`.
 * @param w - The fake world.
 * @returns What the module did: prompts it passed on, toasts, MCP calls, CLI runs, and the fake clock.
 */
function setupWith(mock: MockKit, on: On, w: World = {}) {
  const prompts: { context?: readonly string[] }[] = [];
  const toasts: string[] = [];
  const calls: { tool: string; [k: string]: unknown }[] = [];
  const runs: string[][] = [];
  const clock = mock.clock(on);
  const files = w.files ?? [BIN];
  const settings = w.settingsPath ?? SETTINGS;
  on("env.get", (_$, e) => ({ value: e.name === "HOME" ? (w.home ?? "/home/u") : e.name === "PATH" ? (w.path ?? "/usr/bin") : e.name === "CLAUDE_CONFIG_DIR" ? w.configDir : undefined }));
  on("session.cwd", () => ({ value: CWD }));
  on("fs.exists", (_$, e) => ({ value: files.includes(String(e.path)) || w.dirs?.includes(String(e.path)) || (w.settings !== undefined && e.path === settings) }));
  on("fs.stat", (_$, e) => (files.includes(String(e.path)) ? { value: { kind: "file", size: 1, mtimeMs: 0 } } : w.dirs?.includes(String(e.path)) ? { value: { kind: "dir", size: 0, mtimeMs: 0 } } : { deny: "ENOENT" }));
  on("fs.read", (_$, e) => (e.path === settings && w.settings !== undefined ? { value: w.settings } : { deny: "ENOENT" }));
  on("tool.list", () => ({ value: w.tools ?? OWN }));
  on("process.run", (_$, e) => {
    const argv = [...(e.argv as string[])];
    runs.push(argv);
    const out = argv[1] === "memory" && argv[2] === "list" ? (w.priority ?? ">> p\n★ aaaaaaaa [decision] always use X\n") : argv[2] === "search" ? (w.search ?? "bbbbbbbb [pattern] about foo_bar\n") : "";
    return { value: { exitCode: 0, stdout: out, stderr: "" } };
  });
  on("ui.toast", (_$, e) => {
    toasts.push(String(e.text));
    return { value: undefined };
  });
  on("session.start", async () => ({}));
  on("session.end", async () => ({}));
  on("session.compact", async () => (w.compactSkip ? { skip: "not now" } : { messages: [] }));
  on("prompt.submit", (_$, e) => {
    prompts.push({ context: e.context as readonly string[] | undefined });
    return { value: {} };
  });
  on("tool.call", (_$, e, next) => {
    const tool = String(e.tool);
    if (!tool.startsWith("mcp__")) return { result: "tool output" };
    calls.push({ ...e, tool });
    if (tool.endsWith("__gm_status") && w.unregistered) return { value: { deny: "Project is not registered" } };
    if (tool.endsWith("__gm_status") && w.emptyStatus) return { value: { result: [], text: "" } };
    const text = tool.endsWith("__gm_status") ? "Project: p\nGraph: 1 symbols" : tool.endsWith("__gm_map") ? (w.map ?? ">> map\n  top file") : tool.endsWith("__gm_memory_list") ? (w.recent ?? ">> 1\n  [decision] recent one (id: x)") : "  foo [Function] a.ts:1";
    // The shape of a real MCP tool result (live, Claude Code 2.1.325): text parts under `result` and the joined text.
    return tool.includes("graphmind") ? { value: { result: [{ type: "text", text }], text } } : next(e);
  });
  return { prompts, toasts, calls, runs, clock };
}

/**
 * Fires a tool call through the module.
 *
 * @param $ - The test's `$`.
 * @param input - The tool call event.
 * @returns The result with the context the module added.
 */
export async function toolCall($: Runner, input: Record<string, unknown>) {
  return (await $.tool.call(input)) as { context?: string[] };
}

/**
 * Sends a composer prompt through the module.
 *
 * @param $ - The test's `$`.
 * @param text - The prompt.
 * @param extra - Event fields to override.
 */
export async function prompt($: Runner, text: string, extra: Record<string, unknown> = {}) {
  await $.prompt.submit({ text, origin: { kind: "composer" }, ...extra });
}
