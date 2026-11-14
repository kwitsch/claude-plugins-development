/**
 * Claude Code function-hooks module of graphmind-helper: what `graphmind setup` wires into `~/.claude/settings.json`
 * (project briefing, prompt recall, search nudge), done in-process through the graphmind MCP server's tools instead of
 * three command hooks that each start Node and graphmind.
 *
 * @remarks
 * EARLY ACCESS API. No engine type import: the used `$` members and events are typed structurally below. Every `$`
 * use lives here (the engine rejects `$` in helper files); the pure logic is in `terms.mts`. Two things the MCP tools
 * cannot do stay on the CLI through `$.process.run` (no shell, no Node start): the priority memory list and
 * `memory search --no-recall` (recall counting would promote automatically searched entries to priority, graphmind
 * issue #112). The server starts concurrently with `session.start`, so the briefing waits for the first prompt.
 *
 * @packageDocumentation
 */
import { entryId, fit, isCodePrompt, isRecallable, listing, NUDGE, resolveTools, searchTerms, SETUP_SCRIPTS, shouldNudge } from "./terms.mjs";
import type { GmTools } from "./terms.mjs";

/** One entry of `$.tool.list()`. */
type ToolInfo = { name: string };
/** A `tool.call` result. */
type ToolResult = { deny?: unknown; isError?: boolean; result?: unknown; context?: unknown } & Record<string, unknown>;
/** The part of the engine interface `$` this module uses. */
type Engine = {
  /** Time. */
  clock: { now(): Promise<number> };
  /** Environment of the Claude Code process. */
  env: { get(name: string): Promise<string | undefined> };
  /** The session's directory. */
  session: { cwd(): Promise<string> };
  /** Filesystem reads. */
  fs: { exists(path: string): Promise<boolean>; read(path: string): Promise<string> };
  /** Tools: the listed ones and calling one (the graphmind MCP tools). */
  tool: {
    list(): Promise<ToolInfo[]>;
    /** Runs a tool through every hook but the calling one; resolves its result or `{ deny }`. */
    call(input: { tool: string } & Record<string, unknown>): Promise<ToolResult>;
  };
  /** Child processes. */
  process: { run(argv: string[], init?: { cwd?: string; timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }> };
  /** User interface. */
  ui: { toast(text: string, options?: { timeoutMs?: number }): void };
};
/** Continues the hook chain with an event. */
type Next<E, R> = (e: E) => Promise<R>;
/** A function hook taking event `E` and resolving `R`. */
type Hook<E, R> = ($: Engine, e: E, next: Next<E, R>) => Promise<R>;
/** A `prompt.submit` event. */
type PromptEvent = { command?: unknown; isMeta?: boolean; text: string; context?: readonly string[]; origin?: { kind?: string } } & Record<string, unknown>;
/** A `tool.call` event; the tool's input fields sit on the event itself. */
type ToolCall = { tool: string; command?: unknown; description?: unknown; subagent_type?: unknown; prompt?: unknown } & Record<string, unknown>;
/** The `on` the engine passes to `register`, one overload per hooked event. */
type On = {
  (event: "session.start" | "session.end", hook: Hook<unknown, unknown>): void;
  (event: "prompt.submit", hook: Hook<PromptEvent, unknown>): void;
  (event: "tool.call", hook: Hook<ToolCall, ToolResult>): void;
};

/** How long the missing-binary toast stays, in ms. */
const TOAST_MS = 15_000;
/** How long a resolved tool list is trusted, in ms (no engine event reports a changed list). */
const TOOLS_TTL_MS = 30_000;
/** How long a "project not registered" answer is trusted, in ms (the MCP wrapper may register it a moment later). */
const NOT_READY_TTL_MS = 30_000;
/** How long the same search terms are not searched again, in ms. */
const SEARCH_TTL_MS = 180_000;
/** Timeout of a graphmind CLI run, in ms. */
const RUN_MS = 10_000;
/** The checkpoint reminder comes with every this many prompts. */
const CHECKPOINT_EVERY = 10;

/** Conversation state: reset at `session.start` and `session.end`. */
type State = {
  /** The graphmind binary, once found. */
  bin?: string;
  /** The graphmind MCP tools and when they were listed. */
  tools?: { at: number; tools: GmTools };
  /** Per cwd: whether the project is registered, and when that was asked. */
  ready: Map<string, { ok: boolean; at: number }>;
  /** Whether `graphmind setup`'s own hooks are in the user's settings (asked once). */
  wired?: boolean;
  /** The briefing went out. */
  briefed: boolean;
  /** The nudge went out (or setup's own hook does it). */
  nudged: boolean;
  /** Prompts that got a recall. */
  turns: number;
  /** Priority entry ids already shown. */
  shown: Set<string>;
  /** Search terms and when they were last searched. */
  searched: Map<string, number>;
};

/** The conversation state. */
let state: State = fresh();

/**
 * An empty conversation state.
 *
 * @returns The state.
 */
function fresh(): State {
  return { ready: new Map(), briefed: false, nudged: false, turns: 0, shown: new Set(), searched: new Map() };
}

/**
 * The text of a tool result.
 *
 * @param r - The `$.tool.call` result.
 * @returns The text, `undefined` for a deny, an error or a non-text result.
 */
function textOf(r: ToolResult): string | undefined {
  return r.deny === undefined && r.isError !== true && typeof r.result === "string" ? r.result : undefined;
}

/**
 * The directories the setup scripts look in for the binary, as `findGraphmind` of the MCP wrapper does.
 *
 * @param $ - Engine interface.
 * @returns Candidate paths of the binary.
 */
async function binaryCandidates($: Engine): Promise<string[]> {
  const [home, pathVar] = await Promise.all([$.env.get("HOME"), $.env.get("PATH")]);
  const dirs = (pathVar ?? "").split(":").filter((d) => d.startsWith("/"));
  if (home) dirs.push(`${home}/.graphmind/bin`, `${home}/.local/bin`);
  dirs.push("/usr/local/bin");
  return dirs.map((d) => `${d.replace(/\/+$/, "")}/graphmind`);
}

/**
 * The graphmind binary, cached once found.
 *
 * @remarks
 * The directory list is a copy of `findGraphmind` in `src/bin/common.mts` (the wrapper is a separate process); keep both in step.
 *
 * @param $ - Engine interface.
 * @returns The path, `undefined` when there is none.
 */
async function graphmindBin($: Engine): Promise<string | undefined> {
  if (state.bin) return state.bin;
  const candidates = await binaryCandidates($);
  const found = await Promise.all(candidates.map((p) => $.fs.exists(p)));
  state.bin = candidates.find((_, i) => found[i]);
  return state.bin;
}

/**
 * Runs a graphmind CLI command; never throws.
 *
 * @param $ - Engine interface.
 * @param bin - The binary.
 * @param args - Arguments.
 * @param cwd - Directory to run in.
 * @returns Its standard output, `""` on failure.
 */
async function cli($: Engine, bin: string, args: string[], cwd: string): Promise<string> {
  try {
    const r = await $.process.run([bin, ...args], { cwd, timeoutMs: RUN_MS });
    return r.exitCode === 0 ? r.stdout : "";
  } catch {
    return "";
  }
}

/**
 * Whether `graphmind setup` already wired its hooks into the user's settings, so this module would inject twice. Asked once per conversation.
 *
 * @param $ - Engine interface.
 * @returns True when one of the setup scripts is named in `~/.claude/settings.json`.
 */
async function setupWired($: Engine): Promise<boolean> {
  if (state.wired !== undefined) return state.wired;
  let wired = false;
  try {
    const home = await $.env.get("HOME");
    const file = home ? `${home}/.claude/settings.json` : "";
    if (file && await $.fs.exists(file)) {
      const text = await $.fs.read(file);
      wired = SETUP_SCRIPTS.some((s) => text.includes(s));
    }
  } catch { /* unreadable settings: not wired */ }
  state.wired = wired;
  return wired;
}

/**
 * The graphmind MCP tools in the engine's tool list, cached for {@link TOOLS_TTL_MS} once found.
 *
 * @param $ - Engine interface.
 * @returns The tool names, `undefined` while the server's tools are not listed.
 */
async function graphmindTools($: Engine): Promise<GmTools | undefined> {
  const now = await $.clock.now();
  if (state.tools && now - state.tools.at < TOOLS_TTL_MS) return state.tools.tools;
  const tools = resolveTools(await $.tool.list().catch(() => []));
  state.tools = tools ? { at: now, tools } : undefined;
  return tools;
}

/**
 * Whether the working directory is inside a registered project: `gm_status` for that path answers instead of
 * erroring (a negative answer is trusted for {@link NOT_READY_TTL_MS}).
 *
 * @param $ - Engine interface.
 * @param tools - The graphmind tools.
 * @param cwd - The session's working directory.
 * @returns True when registered.
 */
async function projectReady($: Engine, tools: GmTools, cwd: string): Promise<boolean> {
  const now = await $.clock.now();
  const known = state.ready.get(cwd);
  if (known && (known.ok || now - known.at < NOT_READY_TTL_MS)) return known.ok;
  const ok = textOf(await $.tool.call({ tool: tools.status, project: cwd }).catch(() => ({ deny: "failed" }))) !== undefined;
  if (state.ready.size > 20) state.ready.clear();
  state.ready.set(cwd, { ok, at: now });
  return ok;
}

/**
 * The context a prompt gets: on the first prompt of the conversation the project briefing (the SessionStart script's
 * content), on every prompt the recall (memory and code) and, every tenth, the save reminder. Never throws.
 *
 * @param $ - Engine interface.
 * @param prompt - The prompt text.
 * @returns The context entries to add, none when graphmind is not usable here.
 */
async function recallFor($: Engine, prompt: string): Promise<string[]> {
  if (!isRecallable(prompt) || await setupWired($)) return [];
  const bin = await graphmindBin($);
  const tools = bin ? await graphmindTools($) : undefined;
  if (!bin || !tools) return [];
  const cwd = await $.session.cwd();
  if (!(await projectReady($, tools, cwd))) return [];
  const now = await $.clock.now();

  state.turns++;
  const checkpoint = state.turns % CHECKPOINT_EVERY === 0
    ? `[graphmind checkpoint — prompt ${state.turns}] Review the last ${CHECKPOINT_EVERY} prompts. Call gm_session_analyze with an array of facts (decisions, conventions, bugs, constraints) that emerged — it batch-saves and deduplicates in one call. Use priority=true for facts needed every session.\n\n`
    : "";

  const text = async (tool: string, input: Record<string, unknown>): Promise<string> => textOf(await $.tool.call({ tool, project: cwd, ...input }).catch(() => ({ deny: "failed" }))) ?? "";
  const priorityRaw = await cli($, bin, ["memory", "list", "--priority", "--limit", "20", "--max-chars", "250"], cwd);
  const priority = listing(priorityRaw);

  let head = checkpoint;
  const blocks: { title: string; lines: string[] }[] = [];
  if (!state.briefed) {
    const [status, map, recent] = await Promise.all([text(tools.status, {}), text(tools.map, { limit: 20 }), text(tools.memoryList, { limit: 5 })]);
    head = `[graphmind] Project indexed and ready. Use MCP tools (gm_search, gm_fn, gm_deps, gm_map, gm_outline, gm_query) for code exploration.\n\n${checkpoint}`;
    blocks.push(
      { title: "Project status:", lines: status.split("\n").slice(0, 10) },
      { title: "Structure:", lines: map.split("\n").slice(0, 20) },
      { title: "★ Priority context (always active):", lines: priority },
      { title: "Recent memories:", lines: listing(recent).slice(0, 5) },
      { title: "Auto-memory is ON: save decisions/patterns/conventions via gm_memory_add. Use --priority for always-injected facts. Recall via gm_memory_search.", lines: [] },
    );
  } else {
    blocks.push({ title: "[graphmind ★ new priority context]", lines: priority.filter((l) => !state.shown.has(entryId(l) ?? "")) });
  }

  const terms = searchTerms(prompt);
  const last = terms ? state.searched.get(terms) : undefined;
  if (terms && (last === undefined || now - last >= SEARCH_TTL_MS)) {
    if (state.searched.size > 50) state.searched.clear();
    state.searched.set(terms, now);
    // --no-recall: an automatic search on every prompt is not a sign the entry matters (graphmind issue #112).
    const memory = listing(await cli($, bin, ["memory", "search", terms, "--limit", "5", "--max-chars", "300", "--no-recall"], cwd)).filter((l) => !l.startsWith("!")).slice(0, 5);
    const code = isCodePrompt(prompt) ? (await text(tools.search, { query: terms, limit: 5, code_only: true })).split("\n").slice(0, 30) : [];
    blocks.splice(blocks.length - 1, 0, { title: "[graphmind memory] Relevant:", lines: memory }, { title: "[graphmind code] Relevant symbols:", lines: code });
  }

  const out = fit(head, blocks);
  for (const l of priority) {
    const id = entryId(l);
    if (id && out.whole.has(l)) state.shown.add(id);
  }
  state.briefed = true;
  return out.text.trim() ? [out.text.trimEnd()] : [];
}

/**
 * `session.start` hook: reset the conversation state, run the event, then check for the binary detached; a missing
 * one toasts (the plugin's hooks and MCP wrapper stay off without it).
 *
 * @param $ - Engine interface.
 * @param e - Event, passed on unchanged.
 * @param next - Continues the hook chain.
 * @returns `next`'s result, unchanged.
 */
async function onSessionStart($: Engine, e: unknown, next: Next<unknown, unknown>): Promise<unknown> {
  state = fresh();
  const r = await next(e);
  void graphmindBin($).then((bin) => {
    if (!bin) $.ui.toast("graphmind-helper: the graphmind binary was not found (PATH, ~/.graphmind/bin, ~/.local/bin); the plugin's recall, nudge and MCP server stay off until it is installed (https://github.com/aouicher/graphmind)", { timeoutMs: TOAST_MS });
  }).catch(() => {});
  return r;
}

/**
 * `session.end` hook (raised for /clear and /resume, where no `session.start` follows): reset the conversation state.
 *
 * @param _$ - Engine interface, unused.
 * @param e - Event, passed on unchanged.
 * @param next - Continues the hook chain.
 * @returns `next`'s result, unchanged.
 */
async function onSessionEnd(_$: Engine, e: unknown, next: Next<unknown, unknown>): Promise<unknown> {
  state = fresh();
  return next(e);
}

/**
 * `prompt.submit` hook: adds the briefing and recall as context for the model. A prompt another plugin submitted,
 * a meta prompt or a slash command passes untouched; any failure passes the prompt on unchanged.
 *
 * @param $ - Engine interface.
 * @param e - The prompt event.
 * @param next - Continues the hook chain.
 * @returns `next`'s result.
 */
async function onPromptSubmit($: Engine, e: PromptEvent, next: Next<PromptEvent, unknown>): Promise<unknown> {
  if (e.origin?.kind === "plugin" || e.isMeta || e.command) return next(e);
  const added = await recallFor($, e.text).catch(() => []);
  return next(added.length ? { ...e, context: [...(e.context ?? []), ...added] } : e);
}

/**
 * `tool.call` hook: the once-per-session nudge towards graphmind, as context on the result of the first code search
 * made with grep, find or an Explore agent. Not sent while the project is not registered or when setup's own hook does it.
 *
 * @param $ - Engine interface.
 * @param e - The tool call.
 * @param next - Continues the hook chain.
 * @returns The tool's result, with the nudge added once.
 */
async function onToolCall($: Engine, e: ToolCall, next: Next<ToolCall, ToolResult>): Promise<ToolResult> {
  const r = await next(e);
  if (state.nudged || !shouldNudge(e)) return r;
  try {
    if (await setupWired($)) {
      state.nudged = true;
      return r;
    }
    const bin = await graphmindBin($);
    const tools = bin ? await graphmindTools($) : undefined;
    if (!tools || !(await projectReady($, tools, await $.session.cwd()))) return r;
    state.nudged = true;
    return { ...r, context: [...(Array.isArray(r.context) ? r.context as unknown[] : []), NUDGE] };
  } catch {
    return r;
  }
}

/**
 * Module entry point called by the engine.
 *
 * @param on - Registers a hook for an event.
 */
export const register = (on: On): void => {
  on("session.start", onSessionStart);
  on("session.end", onSessionEnd);
  on("prompt.submit", onPromptSubmit);
  on("tool.call", onToolCall);
};
