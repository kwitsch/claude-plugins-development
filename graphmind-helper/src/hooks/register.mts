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
import { binaryDirs, entryId, fit, isCodePrompt, isRecallable, listing, NUDGE, resolveTools, searchTerms, SETUP_SCRIPTS, shouldNudge } from "./terms.mjs";
import type { Block, GmTools, SearchCall } from "./terms.mjs";

/** One entry of `$.tool.list()`. */
type ToolInfo = {
  /** The tool's full name. */
  name: string;
};
/** A `tool.call` result. */
type ToolResult = {
  /** Why the call was denied. */
  deny?: unknown;
  /** Whether the tool reported an error. */
  isError?: boolean;
  /** The result: a string or MCP text parts. */
  result?: unknown;
  /** The joined text of an MCP result. */
  text?: unknown;
  /** Context for the model added by a hook. */
  context?: unknown;
} & Record<string, unknown>;
/** The part of the engine interface `$` this module uses. */
type Engine = {
  /** Time. */
  clock: { now(): Promise<number> };
  /** Environment of the Claude Code process. */
  env: { get(name: string): Promise<string | undefined> };
  /** The session's directory. */
  session: { cwd(): Promise<string> };
  /** Filesystem reads. */
  fs: { exists(path: string): Promise<boolean>; read(path: string): Promise<string>; stat(path: string): Promise<{ kind: "file" | "dir" | "other" }> };
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
type Next<E, R> = ((e: E) => Promise<R>) & {
  /** Aborts when the dispatch is abandoned (interrupt, a hook above settled first, budget). */
  signal?: AbortSignal;
};
/** A function hook taking event `E` and resolving `R`. */
type Hook<E, R> = ($: Engine, e: E, next: Next<E, R>) => Promise<R>;
/** A `prompt.submit` event. */
type PromptEvent = {
  /** Set for a slash command. */
  command?: unknown;
  /** Set for a meta prompt. */
  isMeta?: boolean;
  /** The prompt text. */
  text: string;
  /** Context entries already attached. */
  context?: readonly string[];
  /** Who submitted the prompt. */
  origin?: { kind?: string };
} & Record<string, unknown>;
/** A `tool.call` event; the tool's input fields sit on the event itself. */
type ToolCall = SearchCall;
/** A `session.compact` event (only the fields read here). */
type CompactEvent = {
  /** Who compacts: `manual`, `auto`, `plugin` or `precompute` (installs nothing). */
  trigger: string;
  /** Set for a subagent's or fork's own transcript; absent for the main conversation. */
  agentId?: string;
} & Record<string, unknown>;
/** The `on` the engine passes to `register`, one overload per hooked event. */
type On = {
  (event: "session.start" | "session.end", hook: Hook<unknown, unknown>): void;
  (event: "session.compact", hook: Hook<CompactEvent, unknown>): void;
  (event: "prompt.submit", hook: Hook<PromptEvent, unknown>): void;
  (event: "tool.call", hook: Hook<ToolCall, ToolResult>): void;
};

/** How long the missing-binary toast stays, in ms. */
const TOAST_MS = 15_000;
/** How long a resolved tool list is trusted, in ms (no engine event reports a changed list). */
const TOOLS_TTL_MS = 30_000;
/** How long a negative answer (no binary, no tools listed, project not registered) is trusted, in ms: the MCP wrapper may register the project, or the server may connect, a moment later. */
const NEGATIVE_TTL_MS = 30_000;
/** How long the same search terms are not searched again, in ms. */
const SEARCH_TTL_MS = 180_000;
/** Timeout of a graphmind CLI run, in ms. */
const RUN_MS = 10_000;
/** The checkpoint reminder comes with every this many prompts. */
const CHECKPOINT_EVERY = 10;
/** The closing line of the briefing. */
const AUTO_MEMORY = "Auto-memory is ON: save decisions/patterns/conventions via gm_memory_add. Use --priority for always-injected facts. Recall via gm_memory_search.";

/** Conversation state: reset at `session.start`, `session.end` and a main-conversation compaction. */
type State = {
  /** The graphmind binary, once found. */
  bin?: string;
  /** When the binary was last looked for in vain. */
  binMissAt?: number;
  /** The graphmind MCP tools and when they were listed. */
  tools?: { at: number; tools: GmTools };
  /** When the tools were last looked for in vain. */
  toolsMissAt?: number;
  /** Per cwd: the project's `gm_status` text (`undefined`: not registered) and when that was asked. */
  ready: Map<string, { status?: string; at: number }>;
  /** Whether `graphmind setup`'s own hooks are in the user's settings (asked once). */
  wired?: boolean;
  /** The briefing went out. */
  briefed: boolean;
  /** The nudge went out. */
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
 * The text of a tool result. A real MCP tool answers (live, Claude Code 2.1.325) `{ result: [{ type: "text", text }], text }`;
 * a tool registered through `$.tool.register` answers `{ result: "<text>" }`.
 *
 * @param r - The `$.tool.call` result.
 * @returns The text, `undefined` for a deny, an error or a result without text.
 */
function textOf(r: ToolResult): string | undefined {
  if (r.deny !== undefined || r.isError === true) return undefined;
  if (typeof r.text === "string") return r.text;
  if (typeof r.result === "string") return r.result;
  if (!Array.isArray(r.result)) return undefined;
  const parts = (r.result as unknown[]).map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).filter((t) => t !== "");
  // A result without any text part is no answer (an empty status must not make a project look registered).
  return parts.length ? parts.join("\n") : undefined;
}

/**
 * Runs a graphmind MCP tool for the session's project; never throws.
 *
 * @param $ - Engine interface.
 * @param tool - The tool's name.
 * @param cwd - The project (the session's directory; graphmind accepts a path).
 * @param input - Further tool input.
 * @returns The result text, `undefined` when the tool failed (for `gm_status`: the project is not registered).
 */
async function callText($: Engine, tool: string, cwd: string, input: Record<string, unknown> = {}): Promise<string | undefined> {
  return textOf(await $.tool.call({ tool, project: cwd, ...input }).catch(() => ({ deny: "failed" })));
}

/**
 * The graphmind binary (the directories of `binaryDirs`, as the MCP wrapper looks; a directory named `graphmind` is skipped), cached
 * once found and a miss for {@link NEGATIVE_TTL_MS}.
 *
 * @param $ - Engine interface.
 * @param now - The engine clock.
 * @returns The path, `undefined` when there is none.
 */
async function graphmindBin($: Engine, now: number): Promise<string | undefined> {
  if (state.bin) return state.bin;
  if (state.binMissAt !== undefined && now - state.binMissAt < NEGATIVE_TTL_MS) return undefined;
  const [home, pathVar] = await Promise.all([$.env.get("HOME"), $.env.get("PATH")]);
  const candidates = binaryDirs(pathVar, home).map((d) => `${d}/graphmind`);
  // shortcut: the engine's stat has no mode bits, so a non-executable file still counts here; the wrapper checks X_OK.
  const found = await Promise.all(candidates.map((p) => $.fs.stat(p).then((s) => s.kind !== "dir", () => false)));
  state.bin = candidates.find((_, i) => found[i]);
  state.binMissAt = state.bin ? undefined : now;
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
 * @returns True when one of the setup scripts is named in the user settings (`$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`).
 */
async function setupWired($: Engine): Promise<boolean> {
  if (state.wired !== undefined) return state.wired;
  let wired = false;
  try {
    const [home, configDir] = await Promise.all([$.env.get("HOME"), $.env.get("CLAUDE_CONFIG_DIR")]);
    const dir = configDir || (home ? `${home}/.claude` : "");
    const file = dir ? `${dir}/settings.json` : "";
    if (file && await $.fs.exists(file)) {
      const text = await $.fs.read(file);
      wired = SETUP_SCRIPTS.some((s) => text.includes(s));
    }
  } catch { /* unreadable settings: not wired */ }
  state.wired = wired;
  return wired;
}

/**
 * The graphmind MCP tools in the engine's tool list, cached for {@link TOOLS_TTL_MS} once found and a miss for {@link NEGATIVE_TTL_MS}.
 *
 * @param $ - Engine interface.
 * @param now - The engine clock.
 * @returns The tool names, `undefined` while the server's tools are not listed.
 */
async function graphmindTools($: Engine, now: number): Promise<GmTools | undefined> {
  if (state.tools && now - state.tools.at < TOOLS_TTL_MS) return state.tools.tools;
  if (state.toolsMissAt !== undefined && now - state.toolsMissAt < NEGATIVE_TTL_MS) return undefined;
  const tools = resolveTools(await $.tool.list().catch(() => []));
  state.tools = tools ? { at: now, tools } : undefined;
  state.toolsMissAt = tools ? undefined : now;
  return tools;
}

/** What a hook needs to talk to graphmind. */
type Usable = {
  /** The binary. */
  bin: string;
  /** The MCP tools. */
  tools: GmTools;
  /** The session's directory (the project). */
  cwd: string;
  /** The engine clock. */
  now: number;
  /** The project's `gm_status` text. */
  status: string;
};

/**
 * Whether graphmind can be used here, and with what: setup's own hooks are not in the settings, the binary exists,
 * the server's tools are listed and `gm_status` answers for the session's directory (a negative answer is trusted for
 * {@link NEGATIVE_TTL_MS}, a positive one for the conversation).
 *
 * @param $ - Engine interface.
 * @returns What the hook needs, `undefined` when graphmind is not usable here.
 */
async function usable($: Engine): Promise<Usable | undefined> {
  if (await setupWired($)) return undefined;
  const now = await $.clock.now();
  const [bin, tools, cwd] = await Promise.all([graphmindBin($, now), graphmindTools($, now), $.session.cwd()]);
  if (!bin || !tools) return undefined;
  const known = state.ready.get(cwd);
  let status: string | undefined;
  if (known && (known.status !== undefined || now - known.at < NEGATIVE_TTL_MS)) status = known.status;
  else {
    status = await callText($, tools.status, cwd);
    if (state.ready.size > 20) state.ready.clear();
    state.ready.set(cwd, { status, at: now });
  }
  return status === undefined ? undefined : { bin, tools, cwd, now, status };
}

/**
 * The context a prompt gets: on the first prompt of the conversation the project briefing (the SessionStart script's
 * content), on every prompt the recall (memory and code) and, every tenth, the save reminder. Never throws.
 * On the first prompt the briefing and the recall are two entries, each fitted to its own budget, as the setup's two hooks send them.
 *
 * @param $ - Engine interface.
 * @param prompt - The prompt text.
 * @param signal - The dispatch's `next.signal`; once it aborted, nothing is returned and no state is committed.
 * @returns The context entries to add, none when graphmind is not usable here.
 */
async function recallFor($: Engine, prompt: string, signal?: AbortSignal): Promise<string[]> {
  if (!isRecallable(prompt)) return [];
  const use = await usable($);
  if (!use) return [];
  const { bin, tools, cwd, now, status } = use;

  const terms = searchTerms(prompt);
  const last = terms ? state.searched.get(terms) : undefined;
  const search = terms !== "" && (last === undefined || now - last >= SEARCH_TTL_MS);
  const briefing = !state.briefed;
  // The calls do not depend on each other: all go out at once. --no-recall: an automatic search on every prompt is not a sign the entry matters (graphmind issue #112).
  const [priorityRaw, memoryRaw, code, map, recent] = await Promise.all([
    cli($, bin, ["memory", "list", "--priority", "--limit", "20", "--max-chars", "250"], cwd),
    search ? cli($, bin, ["memory", "search", terms, "--limit", "5", "--max-chars", "300", "--no-recall"], cwd) : "",
    search && isCodePrompt(prompt) ? callText($, tools.search, cwd, { query: terms, limit: 5, code_only: true }) : undefined,
    briefing ? callText($, tools.map, cwd, { limit: 20 }) : undefined,
    briefing ? callText($, tools.memoryList, cwd, { limit: 10 }) : undefined,
  ]);
  // An abandoned dispatch (interrupt, a hook above settled first, budget) delivers nothing: commit no state, so the next prompt gets what this one lost.
  if (signal?.aborted) return [];
  state.turns++;
  const checkpoint = state.turns % CHECKPOINT_EVERY === 0
    ? `[graphmind checkpoint — prompt ${state.turns}] Review the last ${CHECKPOINT_EVERY} prompts. Call gm_session_analyze with an array of facts (decisions, conventions, bugs, constraints) that emerged — it batch-saves and deduplicates in one call. Use priority=true for facts needed every session.\n\n`
    : "";
  if (search) {
    if (state.searched.size > 50) state.searched.clear();
    state.searched.set(terms, now);
  }
  // Only entries: an empty store prints "No priority memories found." without an id, which would never be marked shown.
  const priority = listing(priorityRaw).filter((l) => entryId(l) !== undefined);
  // A search hit that is a priority entry is already shown or offered in the priority block (the setup's drop_shown).
  const pids = new Set(priority.flatMap((l) => entryId(l) ?? []));
  const skip = new Set([...state.shown, ...pids]);
  const found: Block[] = search
    ? [
      { title: "[graphmind memory] Relevant:", lines: listing(memoryRaw).filter((l) => !l.startsWith("!") && !skip.has(entryId(l) ?? "")).slice(0, 5) },
      { title: "[graphmind code] Relevant symbols:", lines: (code ?? "").split("\n").slice(0, 30) },
    ]
    : [];

  let head = checkpoint;
  let blocks: Block[];
  if (briefing) {
    head = `[graphmind] Project indexed and ready. Use MCP tools (gm_search, gm_fn, gm_deps, gm_map, gm_outline, gm_query) for code exploration.\n\n${checkpoint}`;
    blocks = [
      { title: "Project status:", lines: status.split("\n").slice(0, 10) },
      { title: "Structure:", lines: (map ?? "").split("\n").slice(0, 20) },
      { title: "★ Priority context (always active):", lines: priority },
      // gm_memory_list does not star priority entries (the setup drops them by the star); match its "(id: " prefix, the summary can hold any 8 hex.
      { title: "Recent memories:", lines: listing(recent ?? "").filter((l) => !pids.has(/\(id: ([0-9a-f]{8})/.exec(l)?.[1] ?? "")).slice(0, 5) },
      { title: "", lines: [AUTO_MEMORY] },
    ];
  } else {
    blocks = [{ title: "[graphmind ★ new priority context]", lines: priority.filter((l) => !state.shown.has(entryId(l) ?? "")) }, ...found];
  }

  // The setup sends the briefing (SessionStart) and the recall (UserPromptSubmit) as two outputs, each with its own budget.
  const out = fit(head, blocks);
  const rec = briefing ? fit("", found).text.trimEnd() : "";
  for (const l of priority) {
    const id = entryId(l);
    if (id && out.whole.has(l)) state.shown.add(id);
  }
  state.briefed = true;
  return [out.text.trimEnd(), rec].filter(Boolean);
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
  void $.clock.now().then((now) => graphmindBin($, now)).then((bin) => {
    if (!bin) $.ui.toast("graphmind-helper: the graphmind binary was not found (PATH, ~/.graphmind/bin, ~/.local/bin, /usr/local/bin); the plugin's recall, nudge and MCP server stay off until it is installed (https://github.com/aouicher/graphmind)", { timeoutMs: TOAST_MS });
  }).catch(() => {});
  return r;
}

/**
 * `session.end` hook (raised for /clear and /resume, where no `session.start` follows): reset the conversation state;
 * what is known about the machine (the binary, setup's hooks) stays.
 *
 * @param _$ - Engine interface, unused.
 * @param e - Event, passed on unchanged.
 * @param next - Continues the hook chain.
 * @returns `next`'s result, unchanged.
 */
async function onSessionEnd(_$: Engine, e: unknown, next: Next<unknown, unknown>): Promise<unknown> {
  state = { ...fresh(), bin: state.bin, wired: state.wired };
  return next(e);
}

/**
 * `session.compact` hook: once the main conversation was compacted, the summary has lost the briefing and the priority
 * entries, so the conversation state starts over (the setup's SessionStart script does the same for `source=compact`);
 * the machine-level caches (binary, setup's hooks, tool list, readiness) stay.
 *
 * @param _$ - Engine interface, unused.
 * @param e - Event, passed on unchanged.
 * @param next - Continues the hook chain.
 * @returns `next`'s result, unchanged.
 */
async function onSessionCompact(_$: Engine, e: CompactEvent, next: Next<CompactEvent, unknown>): Promise<unknown> {
  const r = await next(e);
  // A precompute installs nothing, a subagent's compaction is not the main conversation, a skip leaves it as it is.
  const skipped = r !== null && typeof r === "object" && (r as { skip?: unknown }).skip !== undefined;
  if (e.trigger === "precompute" || e.agentId !== undefined || skipped) return r;
  state = { ...fresh(), bin: state.bin, wired: state.wired, tools: state.tools, ready: state.ready };
  return r;
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
  const added = await recallFor($, e.text, next.signal).catch(() => []);
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
    if (!(await usable($))) return r;
    // Parallel searches all pass the first check while `usable` is awaited: only the first one nudges.
    // An abandoned dispatch delivers nothing, so it must not spend the nudge.
    if (next.signal?.aborted || state.nudged) return r;
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
  on("session.compact", onSessionCompact);
  on("prompt.submit", onPromptSubmit);
  on("tool.call", onToolCall);
};
