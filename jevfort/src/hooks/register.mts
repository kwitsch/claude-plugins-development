/**
 * Claude Code function-hooks module of jevfort: every hook and every `$` use. The pure logic lives in the sibling
 * modules, which must never touch `$`. A port of nim-f/jev-pilot 0.5.0 `hooks/register.ts` plus the `$`-using parts
 * of its `jev`, `log`, `context`, `candidates`, `summarize`, `prompt`, `agents`, `compact` and `view`
 * modules, without upstream's modes (disable the plugin to turn it off). Jev is asked only through the jev-api
 * plugin's tools (`$.tool.call`); this module makes no network request of its own.
 *
 * @remarks
 * EARLY ACCESS API. No engine type import (the engine typings are not in the repo): the used `$` members and
 * events are typed structurally below. `development/scripts/build-plugin.mts` keeps `hooks/*.mjs` unmangled and
 * uncompressed, since the engine's static check wants `$`/`on` spelled as such and no `$.<noun>` passed as a bare
 * value; every hook is a named function literal.
 *
 * @packageDocumentation
 */
import { GENERAL, SWITCH_AT } from "./agents.mjs";
import { absolute, AUTH_TOOL, bash, BUILTIN_COMMANDS, clipScript, coversStep, dedupeSkills, isSafeToOffer, MAX_READS, mentionedPaths, quotedTerms, relevant, SAFE_MAKE, SAFE_SCRIPT, sameCall, SKILL_BLOCKLIST_KEY } from "./candidates.mjs";
import type { Candidate } from "./candidates.mjs";
import { compactInstructions, compactItems, RELEVANCE } from "./compact.mjs";
import { clip, splitTurn, summarize, toolCalls } from "./context.mjs";
import type { SessionMessage, ToolUse, TurnContext } from "./context.mjs";
import { choice, JEV_API_TIMEOUT_S, JEV_BATCH, JEV_TOOL_PREFIX, JEV_TOOLS, MAX_CHOICE_OPTIONS, missingJevTools, noul, score, TIMEOUT_MS } from "./jev.mjs";
import type { Answer, ChoiceAnswer, JevResult, Question } from "./jev.mjs";
import { LOG_KEY, MAX_ENTRIES, recentDecisions, remember, statsKey } from "./log.mjs";
import type { Entry } from "./log.mjs";
import { bestAction, bounds, difficultyQuestion, doneQuestion, EFFORT_ORDER, effortQuestion, ESTIMATE_SPEC, ESTIMATE_TOOL, estimateEffort, EVERY_TURN_MODELS, inScratchpad, isEffort, lowerModel, mechanicalQuestion, modelFamily, nextActionQuestion, parseEstimateInput, pickCandidate, route, shouldContinue, singleActionQuestion } from "./policy.mjs";
import type { Effort, EstimateBounds, EstimateModel, Route } from "./policy.mjs";
import { hints, NONE, promptQuestions } from "./prompt.mjs";
import { buildReport } from "./report.mjs";
import { SUMMARY_MODEL, SYSTEM } from "./summarize.mjs";
import type { ModelUsage, Summary } from "./summarize.mjs";

/** One entry of `$.command.list()`. */
type CommandInfo = { name: string; description: string; source: string };
/** One entry of `$.tool.list()`. */
type ToolInfo = { name: string; description: string; mcp?: boolean };
/** What `$.model.complete` resolves. */
type Completion = { isAnswered: true; text: string; usage: ModelUsage } | { isAnswered: false; reason: string };
/** The part of the engine interface `$` this module uses. */
type Engine = {
  /** Time. */
  clock: { now(): Promise<number>; sleep(ms: number): Promise<unknown> };
  /** Environment of the Claude Code process. */
  env: { get(name: string): Promise<string | undefined> };
  /** This plugin's key-value store. */
  store: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown> };
  /** The session's transcript, directory and id. */
  session: { messages(opts: { agentId?: string }): Promise<SessionMessage[]>; cwd(): Promise<string>; id(): Promise<string> };
  /** Filesystem. */
  fs: {
    exists(path: string): Promise<boolean>;
    stat(path: string): Promise<{ kind: string; size: number }>;
    read(path: string): Promise<string>;
    write(path: string, text: string): Promise<unknown>;
  };
  /** Slash commands. */
  command: { register(spec: { name: string; description: string }): Promise<unknown>; list(): Promise<CommandInfo[]> };
  /** Tools: the listed ones, registering this plugin's own (`estimate_effort`), and calling one (the jev-api tools). */
  tool: {
    list(): Promise<ToolInfo[]>;
    register(spec: typeof ESTIMATE_SPEC): Promise<{ tool?: string }>;
    /** Runs a tool through every hook but the calling one; resolves its result or `{ deny }` (it rejects only for an unknown tool or an abort). */
    call(input: { tool: string } & Record<string, unknown>): Promise<ToolResult>;
  };
  /** Model requests. */
  model: { complete(spec: { model: string; system: string; prompt: string; maxTokens: number; timeoutMs: number }): Promise<Completion> };
  /** User interface. */
  ui: {
    status(text: string): Promise<unknown>;
    // The element factories are plain functions, called detached from the object (`const { Markdown } = …`).
    resolve(e: unknown): { Markdown: (props: { text: string }) => unknown };
  };
  /** Prompts sent as this plugin. */
  prompt: { submit(input: { text: string }): Promise<unknown> };
  /** The session's subagents. */
  agent: { list(): Promise<{ status: string }[]> };
};
/** Continues the hook chain with an event. */
type Next<E, R> = (e: E) => Promise<R>;
/** A function hook taking event `E` and resolving `R`. */
type Hook<E, R> = ($: Engine, e: E, next: Next<E, R>) => Promise<R>;
/** A step's token usage as `turn.step` reports it; `null` when unknown. */
type Usage = Record<string, unknown> | null;
/** One chunk of a `turn.step` stream. */
type Chunk =
  | { kind: "text"; index: number; text: string }
  | { kind: "tool"; index: number; id: string; name: string }
  | { kind: "input"; index: number; json: string }
  | { kind: "stop"; stopReason: string; usage: Usage };
/** What a `turn.step` run returns when it ends. */
type StepResult = { turnId: string; index: number; answer: string; toolUses: readonly { name: string; input?: unknown }[]; stopReason: string; usage: Usage };
/** A `turn.step` run: the step's stream, ending in its result. */
type StepRun = AsyncGenerator<Chunk, StepResult, unknown>;
/** A `turn.step` event. */
type Step = { turnId: string; index: number; model: string; effort?: unknown; agentId?: string } & Record<string, unknown>;
/** A `tool.call` event. */
type ToolCall = { tool: string; tool_use_id?: string; agentId?: string } & Record<string, unknown>;
/** A `tool.call` event of the Agent tool. */
type AgentCall = ToolCall & { subagent_type?: string; prompt: string; description: string };
/** A `tool.call` result. */
type ToolResult = { deny?: unknown; isError?: boolean } & Record<string, unknown>;
/** A `tool.check` event. */
type Check = { tool: string; tool_use_id?: string; agentId?: string; input?: unknown } & Record<string, unknown>;
/** A `tool.check` result; `rule` is the settings rule that decided, absent for a tool's own check. */
type Verdict = { decision: string; reason?: string; rule?: string } & Record<string, unknown>;
/** A `prompt.submit` event; `origin` says who sent it (`{ kind: "plugin", name }` for another plugin's `$.prompt.submit`). */
type PromptEvent = { command?: unknown; isMeta?: boolean; text: string; context?: readonly string[]; origin?: { kind?: string; name?: string } } & Record<string, unknown>;
/** An `agent.offer` event. */
type OfferEvent = { agent: string; description: string } & Record<string, unknown>;
/** A `session.compact` event. */
type CompactEvent = { agentId?: string; trigger: string; messages: readonly SessionMessage[]; instructions?: string } & Record<string, unknown>;
/** A `ui.render` event of the `/jev` command output. */
type RenderEvent = { props: { isErrored?: boolean; text: string } } & Record<string, unknown>;
/** A `turn.complete` event. */
type TurnEnd = { turnId: string; reason?: string; agentId?: string; answer?: string } & Record<string, unknown>;
/** A `command.run` event. */
type CommandEvent = { args: string } & Record<string, unknown>;
/** The `on` the engine passes to `register`, one overload per hooked event. */
type On = {
  (event: "session.start", hook: Hook<unknown, unknown>): void;
  (event: "command.run", matcher: { command: "jev" }, hook: ($: Engine, e: CommandEvent) => Promise<{ text: string }>): void;
  (event: "turn.complete", hook: Hook<TurnEnd, unknown>): void;
  (event: "tool.call", hook: Hook<ToolCall, ToolResult>): void;
  (event: "tool.call", matcher: { tool: "Agent" }, hook: Hook<AgentCall, ToolResult>): void;
  (event: "turn.step", hook: ($: Engine, e: Step, next: (e: Step) => StepRun) => StepRun): void;
  (event: "tool.check", hook: Hook<Check, Verdict>): void;
  (event: "prompt.submit", hook: Hook<PromptEvent, unknown>): void;
  (event: "agent.offer", hook: Hook<OfferEvent, unknown>): void;
  (event: "session.compact", hook: Hook<CompactEvent, unknown>): void;
  (event: "ui.render", matcher: { component: "CommandOutput"; props: { command: "jev" } }, hook: ($: Engine, e: RenderEvent, next: (e: RenderEvent) => unknown) => unknown): void;
};
/** The plugin options the engine passes to `register` (the manifest's `userConfig` values). */
type Options = Partial<Record<string, unknown>>;

/** How many steps Jev may take in one turn. */
const MAX_TAKES_PER_TURN = 3;
/** The file tools whose writes into the session scratchpad are always allowed. */
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
/** From this `single_action` probability on, a taken step bypasses the whole turn. */
const SINGLE_ACTION = 0.8;
/** This plugin's name: the `origin.name` of the prompts it submits itself. */
const PLUGIN_NAME = "jevfort";
/** The done check's follow-up message. */
const DONE_PROMPT = "Jev: the user's request doesn't look finished yet. Continue with what remains. If it is actually complete, say so in one line.";

/** Subagent statuses that mean the work is over (the engine documents `running`, `completed`, `failed`, `killed` and others); any other status counts as still going. */
const FINISHED = new Set(["completed", "failed", "killed", "idle"]);

/**
 * `String(v)` for a tool-input field, typed `unknown` so the lint's base-to-string check accepts a `?? ""` fallback.
 *
 * @param v - The field.
 * @returns Its string form.
 */
const asText = (v: unknown): string => String(v);

/**
 * Asks Jev through the jev-api plugin's `batch` tool; never throws. All questions go out in one `$.tool.call` (one
 * System One request) inside the calling hook's frame, raced against `TIMEOUT_MS`. All or nothing: a failed call, a
 * timeout or a wrong answer is `{ ok: false }`, so callers fall back to Claude Code's own behaviour. A call still
 * running when the budget ends is ignored.
 *
 * @param $ - Engine interface.
 * @param state - The facts the questions are about; sent as JSON text.
 * @param questions - The questions by id.
 * @returns The answers, or the error, with the time taken.
 */
async function askJev($: Engine, state: unknown, questions: Record<string, Question>): Promise<JevResult> {
  const startedAt = await $.clock.now();
  const done = async (r: { ok: true; answers: Record<string, Answer> } | { ok: false; error: string }): Promise<JevResult> => ({ ...r, ms: (await $.clock.now()) - startedAt });

  const entries = Object.entries(questions);
  const call = (async (): Promise<Record<string, Answer>> => {
    const r = await $.tool.call({ tool: JEV_BATCH, state: JSON.stringify(state), questions: entries.map(([, q]) => q), timeout: JEV_API_TIMEOUT_S });
    // jev-api's deny text already starts with `batch:`.
    if (r.deny !== undefined) throw new Error(asText(r.deny));
    // Core's error result (no hook answered) has no `batch:` prefix; a structured one is serialized, not printed as `[object Object]`.
    if (r.isError === true || typeof r.result !== "string") throw new Error(`batch: ${r.result === undefined ? "no result" : typeof r.result === "string" ? r.result : JSON.stringify(r.result)}`);
    let list: unknown;
    try {
      list = JSON.parse(r.result);
    } catch {
      throw new Error("batch: result is not JSON");
    }
    if (!Array.isArray(list) || list.length !== entries.length) throw new Error(`batch: expected ${entries.length} answers`);
    // The answers come in question order.
    return Object.fromEntries(entries.map(([id, q], i) => {
      const answer = list[i] as Answer | null;
      if (answer?.type !== q.type) throw new Error(`batch: no ${q.type} answer for questions[${i}]`);
      return [id, answer];
    }));
  })();
  // A call abandoned at the timeout must not raise an unhandled rejection.
  call.catch(() => undefined);
  const timeout = $.clock.sleep(TIMEOUT_MS).then(() => undefined);

  try {
    const answers = await Promise.race([call, timeout]);
    if (!answers) return done({ ok: false, error: `timeout after ${TIMEOUT_MS}ms` });
    return done({ ok: true, answers });
  } catch (err) {
    return done({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/** The needed jev-api tools missing from this session's tool listing: looked up once per session, reset at `session.start`. */
let jevTools: Promise<string[]> | undefined;

/**
 * The needed jev-api tools that are not listed; a non-empty answer turns jevfort off (every hook but `/jev` passes
 * through). A failed or malformed listing counts as all missing, so the cached promise never rejects.
 *
 * @remarks
 * Module level, with its cache, because the engine accepts `$` passed only to top-level functions.
 *
 * @param $ - Engine interface.
 * @returns The missing full tool names, empty when jevfort can ask Jev.
 */
function jevMissing($: Engine): Promise<string[]> {
  return (jevTools ??= $.tool.list().then((t) => missingJevTools(t.map((x) => x.name))).catch(() => [...JEV_TOOLS]));
}

/**
 * The stored log, oldest first.
 *
 * @param $ - Engine interface.
 * @returns The entries.
 */
async function readLog($: Engine): Promise<Entry[]> {
  return ((await $.store.get(LOG_KEY)) as Entry[] | undefined) ?? [];
}

/**
 * The decision counters.
 *
 * @param $ - Engine interface.
 * @returns Counts by stats key.
 */
async function stats($: Engine): Promise<Record<string, number>> {
  return ((await $.store.get("stats")) as Record<string, number> | undefined) ?? {};
}
/** Tail of the queue that serializes record()'s store writes. */
let storeQueue: Promise<void> = Promise.resolve();

/**
 * Logs a decision: this session's buffer, the capped store log, the counters, and the status line.
 *
 * @param $ - Engine interface.
 * @param d - The decision without its time.
 */
async function record($: Engine, d: Omit<Entry, "at">): Promise<void> {
  const entry: Entry = { ...d, at: await $.clock.now() };
  remember(entry);

  // Serialized: parallel hooks would otherwise read the same log and tally and lose each other's writes.
  const run = storeQueue.then(async () => {
    const log = await readLog($);
    await $.store.set(LOG_KEY, [...log, entry].slice(-MAX_ENTRIES));

    const tally = await stats($);
    const key = statsKey(d);
    await $.store.set("stats", { ...tally, [key]: (tally[key] ?? 0) + 1 });
  });
  storeQueue = run.catch(() => undefined);
  await run;

  if (d.kind !== "outcome" && d.kind !== "turn") void $.ui.status(`jev: ${d.text}`.slice(0, 80));
}

/**
 * Empties the log and the counters.
 *
 * @param $ - Engine interface.
 */
async function clearLog($: Engine): Promise<void> {
  await $.store.set(LOG_KEY, []);
  await $.store.set("stats", {});
}

/**
 * The current turn of the main loop or of a subagent.
 *
 * @param $ - Engine interface.
 * @param agentId - The subagent, or none for the main loop.
 * @returns The request and the steps so far, or `undefined` without a request.
 */
async function readTurn($: Engine, agentId?: string): Promise<TurnContext | undefined> {
  const messages = await $.session.messages(agentId ? { agentId } : {});
  if (!Array.isArray(messages)) return undefined;
  // Jev's own done follow-up is not the user's request.
  // shortcut: SessionMessage has no origin marker, so the synthetic message is matched by its exact text; a user sending exactly that text loses that one message from the scored request.
  return splitTurn(messages.filter((m) => !(m.role === "user" && m.text.trim() === DONE_PROMPT)));
}

/**
 * The end of the assistant's last reply, so short follow-ups are judged in context.
 *
 * @param $ - Engine interface.
 * @returns The last 800 characters of the reply, or `undefined`.
 */
async function previousReply($: Engine): Promise<string | undefined> {
  const messages = await $.session.messages({}).catch(() => undefined);
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.text.trim()) return m.text.length > 800 ? `…${m.text.slice(-800)}` : m.text;
  }
  return undefined;
}

/**
 * The package runner of the project, by its lock file.
 *
 * @param $ - Engine interface.
 * @param cwd - The project directory.
 * @returns `pnpm`, `yarn`, `bun` or `npm`.
 */
async function packageRunner($: Engine, cwd: string): Promise<string> {
  for (const [file, runner] of [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lockb", "bun"], ["bun.lock", "bun"]] as const) {
    if (await $.fs.exists(`${cwd}/${file}`).catch(() => false)) return runner;
  }
  return "npm";
}

/**
 * The actions Jev may take at this step: files named so far, searches for quoted terms, read-only git commands,
 * the project's safe scripts and test runners, and at step 0 related skills and deferred tools.
 *
 * @param $ - Engine interface.
 * @param request - The user's request.
 * @param steps - The turn's steps so far.
 * @param calls - The turn's tool calls so far.
 * @param stepIndex - The step within the turn.
 * @returns At most `MAX_CHOICE_OPTIONS - 1` candidates (one of jev-api's choice options is `claude`).
 */
async function buildCandidates($: Engine, request: string, steps: readonly SessionMessage[], calls: readonly ToolUse[], stepIndex: number): Promise<Candidate[]> {
  const cwd = await $.session.cwd();
  const out: Candidate[] = [];
  const has = (file: string) => $.fs.exists(`${cwd}/${file}`).catch(() => false);

  // Files named in the request or the turn's text/tool output, not yet read this turn.
  const texts = [request, ...steps.map((m) => m.text), ...calls.map((c) => c.text ?? "")];
  const alreadyRead = new Set(calls.filter((c) => c.tool === "Read").map((c) => String(c.input.file_path)));
  let reads = 0;
  for (const p of mentionedPaths(texts)) {
    if (reads >= MAX_READS) break;
    if (p.startsWith("~")) continue;
    const file = absolute(cwd, p);
    if (alreadyRead.has(file) || !isSafeToOffer(file, cwd)) continue;
    const stat = await $.fs.stat(file).catch(() => undefined);
    if (stat?.kind !== "file" || stat.size > 2_000_000) continue;
    out.push({ key: `read ${p}`, description: `Read the file ${p}`, tool: "Read", input: { file_path: file } });
    reads += 1;
  }

  // Searches for terms the user quoted.
  for (const term of quotedTerms(request)) {
    out.push(bash(`grep -rnF --exclude-dir=node_modules --exclude-dir=.git -- '${term}' .`, `Search the project for the text "${term}"`));
  }

  // Read-only git commands.
  if (await has(".git")) {
    // One "what changed" option: status and diff --stat as two options split Jev's probability (0.75/0.24 live); merged it reaches 0.93.
    out.push(bash("git status --short && git diff --stat", "Show what changed: which files are modified, staged or untracked, with a per-file count of changed lines"));
    out.push(bash("git diff", "Show the full line-by-line diff of unstaged changes"));
    out.push(bash("git log --oneline -n 15", "Show the 15 most recent commits"));
  }

  // The project's own safe scripts and test runners.
  const pkg = await $.fs.read(`${cwd}/package.json`).catch(() => undefined);
  if (typeof pkg === "string") {
    let scripts: Record<string, string> = {};
    try {
      scripts = (JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts ?? {};
    } catch {
      // a malformed package.json offers no scripts
    }
    const runner = await packageRunner($, cwd);
    for (const name of Object.keys(scripts).filter((n) => SAFE_SCRIPT.test(n))) {
      const command = name === "test" ? `${runner} test` : `${runner} run ${name}`;
      out.push(bash(command, `Run the project's "${name}" script (${clipScript(scripts[name])})`));
    }
  }
  const makefile = await $.fs.read(`${cwd}/Makefile`).catch(() => undefined);
  if (typeof makefile === "string") {
    const targets = new Set([...makefile.matchAll(/^([A-Za-z][\w-]*):(?!=)/gm)].map((m) => m[1]));
    for (const t of [...targets].filter((t) => SAFE_MAKE.test(t))) out.push(bash(`make ${t}`, `Run the Makefile's "${t}" target`));
  }
  if (await has("Cargo.toml")) {
    out.push(bash("cargo test", "Run the Rust tests"));
    out.push(bash("cargo check", "Type-check the Rust project"));
    out.push(bash("cargo clippy", "Lint the Rust project"));
  }
  if (await has("go.mod")) {
    out.push(bash("go test ./...", "Run the Go tests"));
    out.push(bash("go vet ./...", "Vet the Go code"));
    out.push(bash("go build ./...", "Build the Go packages"));
  }
  if ((await has("pytest.ini")) || (await has("conftest.py")) || /\[tool\.pytest/.test(String(await $.fs.read(`${cwd}/pyproject.toml`).catch(() => "")))) {
    out.push(bash("python -m pytest -q", "Run the Python tests"));
  }

  // First move of a turn only: a skill to invoke, or a deferred tool to load.
  if (stepIndex === 0) {
    const commands = await $.command.list().catch(() => []);
    const blocked = new Set(((await $.store.get(SKILL_BLOCKLIST_KEY).catch(() => undefined)) as string[] | undefined) ?? []);
    const allSkills = dedupeSkills(
      commands.filter((c) => (c.source === "plugin" || c.source === "user") && c.name !== "jev" && !BUILTIN_COMMANDS.has(c.name) && !blocked.has(c.name)),
    );
    // Every skill when the prompt is about skills; otherwise only related ones.
    const skills = /\bskills?\b/i.test(request) ? allSkills : relevant(request, allSkills);
    for (const c of skills) {
      out.push({ key: `skill ${c.name}`, description: `Use the skill or command "${c.name}": ${clipScript(c.description)}`, tool: "Skill", input: { skill: c.name } });
    }
    const loaded = new Set(calls.filter((c) => c.tool === "ToolSearch").map((c) => String(c.input.query)));
    // jev-api's tools are jevfort's own Jev back end, never a tool for Claude to load.
    const tools = (await $.tool.list().catch(() => [])).filter((t) => t.mcp && !AUTH_TOOL.test(t.name) && !t.name.startsWith(JEV_TOOL_PREFIX) && !loaded.has(`select:${t.name}`));
    for (const t of relevant(request, tools)) {
      out.push({ key: `load ${t.name}`, description: `Load the tool ${t.name}: ${clipScript(t.description)}`, tool: "ToolSearch", input: { query: `select:${t.name}`, max_results: 1 } });
    }
  }

  // One of jev-api's choice options is "claude".
  return out.slice(0, MAX_CHOICE_OPTIONS - 1);
}

/**
 * Whole-turn bypass: the small model's report of the one action's output.
 *
 * @param $ - Engine interface.
 * @param request - The user's request.
 * @param action - The action taken (its candidate key).
 * @param output - The action's output.
 * @returns The summary, or why there is none.
 */
async function summarizeResult($: Engine, request: string, action: string, output: string): Promise<Summary> {
  const r = await $.model.complete({
    model: SUMMARY_MODEL,
    system: SYSTEM,
    prompt: `Request: ${clip(request, 2000)}\nAction: ${action}\nOutput:\n${clip(output, 12000)}`,
    maxTokens: 600,
    timeoutMs: 20000,
  });
  if (!r.isAnswered) return { ok: false, reason: r.reason };
  const text = r.text.trim();
  return text ? { ok: true, text, usage: r.usage } : { ok: false, reason: "empty-reply" };
}

/**
 * The skill options of the prompt classifier: `none` plus each listed plugin or user skill that is not built in or
 * blocklisted, once per name and in listing order, at most `MAX_CHOICE_OPTIONS` options in all (jev-api's choice
 * limit).
 *
 * @param $ - Engine interface.
 * @returns The options, or `undefined` when no skill is listed.
 */
async function skillOptions($: Engine): Promise<Record<string, string> | undefined> {
  const commands = await $.command.list().catch(() => []);
  const blocked = new Set(((await $.store.get(SKILL_BLOCKLIST_KEY).catch(() => undefined)) as string[] | undefined) ?? []);
  const criteria: Record<string, string> = { [NONE]: "No listed skill is meant for this request" };
  for (const c of commands) {
    // shortcut: past jev-api's choice limit later skills are left out; rank them if users hit it.
    if (Object.keys(criteria).length >= MAX_CHOICE_OPTIONS) break;
    // Own keys only: `in` would also see Object.prototype members, dropping a skill named `constructor` or `toString`.
    if ((c.source === "plugin" || c.source === "user") && c.name !== "jev" && !BUILTIN_COMMANDS.has(c.name) && !blocked.has(c.name) && !Object.hasOwn(criteria, c.name)) {
      criteria[c.name] = clip(c.description, 160);
    }
  }
  return Object.keys(criteria).length > 1 ? criteria : undefined;
}

/**
 * Short form of a step's tool calls: `Edit app.js ×3, Bash npm test`.
 *
 * @param calls - The calls.
 * @returns The summary, `replied` without calls.
 */
function summarizeCalls(calls: readonly { tool: string; input: Record<string, unknown> }[]): string {
  if (!calls.length) return "replied";
  const parts = new Map<string, number>();
  for (const c of calls) {
    const target = typeof c.input.file_path === "string"
      ? c.input.file_path.split("/").pop()
      : typeof c.input.command === "string"
      ? c.input.command.replace(/\s+/g, " ").slice(0, 30)
      : typeof c.input.skill === "string"
      ? c.input.skill
      : "";
    const key = target ? `${c.tool} ${target}` : c.tool;
    parts.set(key, (parts.get(key) ?? 0) + 1);
  }
  return [...parts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(", ");
}

/**
 * Logs Claude's step next to Jev's top action. `agree` means Jev's action would have replaced Claude's whole step
 * (one call, same command once output filters and flags are set aside), so taking it saves one Claude request.
 *
 * @param $ - Engine interface.
 * @param turnId - The turn.
 * @param step - The step index.
 * @param request - The user's request.
 * @param answer - Jev's next-action answer.
 * @param candidates - The candidates Jev was offered.
 * @param toolUses - Claude's calls in the step.
 * @param measured - Whether Jev was asked in parallel (measure path) rather than before the step.
 */
async function recordCompare($: Engine, turnId: string, step: number, request: string, answer: ChoiceAnswer, candidates: readonly Candidate[], toolUses: readonly { name: string; input?: unknown }[], measured: boolean): Promise<void> {
  const best = bestAction(answer);
  const claudeCalls = toolUses.map((u) => ({ tool: u.name, input: (u.input ?? {}) as Record<string, unknown> }));
  const bestCandidate = candidates.find((c) => c.key === best?.key);
  const agree = Boolean(bestCandidate && coversStep(claudeCalls, bestCandidate));
  const claudeUsedCandidate = claudeCalls.some((c) => candidates.some((k) => coversStep([c], k)));
  const claudeSummary = summarizeCalls(claudeCalls);
  await record($, {
    kind: "compare",
    applied: false,
    text: `Claude: ${claudeSummary} · Jev best ${best?.key ?? "none"}${agree ? " ✓" : ""}`,
    turnId,
    data: {
      request: clip(request, 120),
      step,
      measured,
      claudeSummary,
      pick: answer.choice,
      best: best?.key,
      bestP: best?.p,
      claude: claudeCalls.map((c) => c.tool),
      claudeCalls: claudeCalls.map((c) => clip(asText(c.input.command ?? c.input.file_path ?? c.input.skill ?? c.input.query ?? ""), 200)),
      agree,
      claudeUsedCandidate,
    },
  });
}

/**
 * Never offers skill `name` again (the Skill tool refused it).
 *
 * @param $ - Engine interface.
 * @param name - The skill.
 */
async function blockSkill($: Engine, name: string): Promise<void> {
  const list = ((await $.store.get(SKILL_BLOCKLIST_KEY)) as string[] | undefined) ?? [];
  if (!list.includes(name)) await $.store.set(SKILL_BLOCKLIST_KEY, [...list, name]);
}

/**
 * The done check after a main-loop answer: asks Jev whether the request is finished and records the verdict.
 *
 * @remarks
 * Module level because the engine accepts `$` passed only to top-level functions.
 *
 * @param $ - Engine interface.
 * @param e - The `turn.complete` event.
 * @param threshold - The `doneThreshold`: below this `done` probability the request counts as unfinished.
 * @returns Whether to send Claude back with a follow-up message.
 */
async function checkDone($: Engine, e: TurnEnd, threshold: number): Promise<boolean> {
  // Waiting on background work (a subagent) is not stopping early: that work will wake the session when it finishes.
  // shortcut: background Bash commands are not exposed to $ (only subagents are), so waiting on one still triggers a follow-up; upgrade when the engine lists background tasks.
  const agents = await $.agent.list().catch(() => undefined);
  if (!agents) return false;
  const waitingOn = agents.filter((a) => !FINISHED.has(a.status)).length;
  if (waitingOn > 0) {
    await record($, { kind: "done", applied: false, text: `skipped: waiting on ${waitingOn} background task(s)`, data: { skipped: "background", continued: false } });
    return false;
  }

  const ctx = await readTurn($);
  if (!ctx) return false;
  const r = await askJev(
    $,
    { request: clip(ctx.request, 3000), final_message: clip(e.answer ?? "", 2000), recent: summarize(ctx.steps) },
    { done: doneQuestion },
  );
  if (!r.ok) return false;
  const done = noul(r.answers, "done");
  const unfinished = shouldContinue(done, threshold);
  await record($, {
    kind: "done",
    applied: unfinished,
    text: unfinished ? `not finished (p=${(done ?? 0).toFixed(2)}), continuing` : `finished (p=${(done ?? 0).toFixed(2)})`,
    ms: r.ms,
    data: { p: done, continued: unfinished },
  });
  return unfinished;
}

/**
 * Module entry point called by the engine.
 *
 * @param on - Registers a hook for an event.
 * @param options - The manifest's `userConfig` values.
 */
export const register = (on: On, options: Options): void => {
  const routing = options.routing === "model" || options.routing === "off" ? options.routing : "effort";
  const takeSteps = options.takeSteps !== false;
  const doneCheck = options.doneCheck !== false;
  const takeThreshold = typeof options.takeThreshold === "number" ? options.takeThreshold : 0.85;
  const subagents = options.subagents !== false;
  const bypass = options.bypass !== false;
  // Benchmark (2026-10-14): taking steps inside multi-step coding turns only added turns (+6, +3% cost); taking pays off when the whole turn is bypassed.
  const takeOnlyForBypass = options.takeOnlyForBypass !== false;
  const measureSteps = options.measureSteps !== false;
  const threshold = (key: string, fallback: number): number => {
    const v = options[key];
    return typeof v === "number" ? v : fallback;
  };
  const doneThreshold = threshold("doneThreshold", 0.15);
  // The bounds of the turn-start effort estimate; invalid or inverted options fall back to low..xhigh together.
  const configuredRange = bounds(options.minEffort, options.maxEffort);
  const effortRange: { minEffort: Effort; maxEffort: Effort } = configuredRange ?? { minEffort: "low", maxEffort: "xhigh" };
  /** Set when the user configured `minEffort`/`maxEffort` but they are invalid or inverted; logged at session start. */
  const badRange = !configuredRange && (options.minEffort !== undefined || options.maxEffort !== undefined) ? `minEffort ${String(options.minEffort)}, maxEffort ${String(options.maxEffort)}` : undefined;

  // Draws `/jev` output as Markdown, so the report's tables render as tables.
  on("ui.render", { component: "CommandOutput", props: { command: "jev" } }, function onRenderJev($: Engine, e: RenderEvent, next: (e: RenderEvent) => unknown): unknown {
    if (e.props.isErrored) return next(e);
    const { Markdown } = $.ui.resolve(e);
    return Markdown({ text: e.props.text });
  });

  // The next main-loop turn after a done follow-up is exempt, so Jev sends Claude back at most once per request.
  // Armed only by a prompt this plugin submitted itself (`origin`), cleared by a user's own prompt (`composer`, not meta), so a
  // user turn neither consumes nor inherits it, a user pasting the follow-up text triggers nothing, and a meta prompt in
  // between (a background-task notification) does not re-open the follow-up turn to a second check. A hot reload forgets it: at worst one more follow-up.
  let donePending = false;
  // Why the last follow-up failed to submit: its rejection arrives after the hook frame ended, so it is logged by the next turn.complete.
  let lostFollowUp: string | undefined;
  // Phase 3: classify each prompt as it is sent and, when Jev is confident, add a short hint only Claude reads.
  // This one hook also notes Jev's own done follow-up passing through, which arms the exemption.
  on("prompt.submit", async function onPromptSubmit($: Engine, e: PromptEvent, next: Next<PromptEvent, unknown>): Promise<unknown> {
    if ((await jevMissing($)).length) return next(e);
    if (e.origin?.kind === "plugin" && e.origin.name === PLUGIN_NAME) {
      donePending = true;
      return next(e);
    }
    if (e.origin?.kind === "composer" && !e.isMeta) donePending = false;
    if (options.classify === false || e.command || e.isMeta || e.text.trim().length < 3) return next(e);

    const questions = promptQuestions(await skillOptions($));
    const previous = await previousReply($);
    const r = await askJev($, { request: clip(e.text, 3000), ...(previous ? { previous_reply: previous } : {}) }, questions);
    if (!r.ok) return next(e);
    const kind = choice(r.answers, "kind");
    const needsPlan = noul(r.answers, "needs_plan");
    const skillAnswer = choice(r.answers, "skill");
    const skill = skillAnswer ? { name: skillAnswer.choice, p: skillAnswer.probabilities[skillAnswer.choice] ?? 0 } : undefined;
    const added = hints(kind?.choice, needsPlan, skill, takeThreshold);

    await record($, {
      kind: "classify",
      applied: added.length > 0,
      text: `${kind?.choice ?? "?"}${needsPlan !== undefined ? `, plan ${needsPlan.toFixed(2)}` : ""}${skill && skill.name !== NONE ? `, skill ${skill.name} ${skill.p.toFixed(2)}` : ""}${added.length ? " → hint" : ""}`,
      ms: r.ms,
      data: { request: clip(e.text, 120), kind: kind?.choice, kindP: kind?.confidence, needsPlan, skill: skill?.name, skillP: skill?.p, hints: added.length },
    });
    if (!added.length) return next(e);
    return next({ ...e, context: [...(e.context ?? []), ...added] });
  });

  // Phase 3: when Claude starts a general-purpose subagent, Jev may pick a more specialised agent type.
  if (options.agentTypes !== false) {
    // Agent types as the engine offers them to the model, with their descriptions.
    const offered = new Map<string, string>();

    on("agent.offer", async function onAgentOffer($: Engine, e: OfferEvent, next: Next<OfferEvent, unknown>): Promise<unknown> {
      if ((await jevMissing($)).length) return next(e);
      offered.set(e.agent, e.description);
      return next(e);
    });

    on("tool.call", { tool: "Agent" }, async function onAgentCall($: Engine, e: AgentCall, next: Next<AgentCall, ToolResult>): Promise<ToolResult> {
      if ((await jevMissing($)).length) return next(e);
      const claudeType = e.subagent_type ?? "";
      if (offered.size < 2 || claudeType === "fork") return next(e);

      const criteria: Record<string, string> = {};
      // shortcut: past jev-api's choice limit later-offered agent types are left out; rank them if users hit it.
      for (const [name, description] of [...offered].slice(0, MAX_CHOICE_OPTIONS)) criteria[name] = clip(description, 200);
      const r = await askJev(
        $,
        { task: clip(e.prompt, 3000), description: e.description },
        { agent_type: { type: "choice", instructions: "Which agent type is best suited to carry out `task`?", criteria } },
      );
      if (!r.ok) return next(e);
      const answer = choice(r.answers, "agent_type");
      if (!answer) return next(e);
      const p = answer.probabilities[answer.choice] ?? 0;
      const canSwitch = GENERAL.has(claudeType) && !GENERAL.has(answer.choice) && p >= SWITCH_AT;
      await record($, {
        kind: "agent",
        applied: canSwitch,
        text: `Claude ${claudeType || "(default)"} · Jev ${answer.choice} p=${p.toFixed(2)}${canSwitch ? " → switched" : ""}`,
        ms: r.ms,
        data: { claude: claudeType || "general-purpose", jev: answer.choice, p, switched: canSwitch, agree: answer.choice === (claudeType || "general-purpose") },
      });
      return canSwitch ? next({ ...e, subagent_type: answer.choice }) : next(e);
    });
  }

  // Phase 3: before a compaction, Jev scores how relevant each recent tool result is; the summarizer is told what to keep.
  if (options.compaction !== false) {
    on("session.compact", async function onCompact($: Engine, e: CompactEvent, next: Next<CompactEvent, unknown>): Promise<unknown> {
      if ((await jevMissing($)).length) return next(e);
      if (e.agentId || (e.trigger !== "manual" && e.trigger !== "auto")) return next(e);
      const items = compactItems(e.messages);
      if (items.length < 3) return next(e);

      const request = splitTurn(e.messages)?.request ?? "";
      const questions: Record<string, Question> = {};
      items.forEach((it, i) => {
        questions[`item_${i}`] = {
          type: "score",
          instructions: `How relevant is this earlier tool call and its result to continuing the work on \`request\`? Call: ${it.label}. Result: ${it.result || "(no output)"}`,
          criteria: RELEVANCE,
        };
      });
      const r = await askJev($, { request: clip(request, 2000), item_count: items.length }, questions);
      if (!r.ok) return next(e);
      const scores = items.map((_, i) => score(r.answers, `item_${i}`)?.score);
      const added = compactInstructions(items, scores);
      const keep = scores.filter((s) => (s ?? 0) >= 2.2).length;
      const drop = scores.filter((s) => s !== undefined && s < 0.8).length;
      await record($, {
        kind: "compact",
        applied: added !== undefined,
        text: `${e.trigger} compaction: ${items.length} results scored, keep ${keep}, drop ${drop}`,
        ms: r.ms,
        data: { trigger: e.trigger, items: items.length, keep, drop },
      });
      if (!added) return next(e);
      return next({ ...e, instructions: e.instructions ? `${e.instructions}\n\n${added}` : added });
    });
  }

  // Per-turn state: the difficulty route, the effort sent on every step of the turn, Jev's takes and the bypass.
  const turns = new Map<string, { route?: Route; effort?: Effort; taken: number; bypassId?: string; bypassAction?: string }>();
  // What each loop's first turn (key `agentId`, `""` for the main loop) saw and estimated: the session model's family,
  // the session effort (`from`) and the estimate (unset when none was made or Jev failed). Drives the Haiku/Fable hold.
  const firstTurns = new Map<string, { family?: EstimateModel; from: unknown; effort?: Effort }>();
  // Calls Jev made itself: `tool.check` approves them, their commands come from a vetted list.
  const ownCalls = new Set<string>();
  on("session.start", async function onSessionStart($: Engine, e: unknown, next: Next<unknown, unknown>): Promise<unknown> {
    // A new conversation (also after /clear) gets its own first-turn estimate.
    firstTurns.clear();
    if (badRange) await record($, { kind: "error", applied: false, text: `invalid effort bounds (${badRange}): using low..xhigh` }).catch(() => undefined);
    await $.command.register({
      name: "jev",
      description: "Jev pilot: status, /jev report, /jev candidates, /jev export, /jev clear",
    });
    // After `next(e)`: jev-api registers its tools in its own session.start, which may run beneath this hook.
    const result = await next(e);
    // A new session looks the jev-api tools up again, and only now: a jevfort hook raised inside `next(e)` (another
    // plugin's session.start making a tool call) may have cached a listing from before jev-api registered.
    jevTools = undefined;
    const missing = await jevMissing($);
    if (missing.length) {
      await record($, { kind: "error", applied: false, text: `inactive: jev-api tools missing (${missing.join(", ")})` }).catch(() => undefined);
      return result;
    }
    // Registered whatever `routing` says: Skills and subagents call it too. Turn start does not depend on it.
    try {
      await $.tool.register(ESTIMATE_SPEC);
    } catch (err) {
      await record($, { kind: "error", applied: false, text: `estimate_effort not registered: ${String(err)}` }).catch(() => undefined);
    }
    return result;
  });

  on("command.run", { command: "jev" }, async function onJevCommand($: Engine, e: CommandEvent): Promise<{ text: string }> {
    const arg = e.args.trim();
    if (arg === "report") {
      return { text: buildReport(await readLog($), takeThreshold) };
    }
    if (arg === "candidates") {
      // Exactly what Jev is offered at step 0 for the last prompt.
      const ctx = await readTurn($);
      const calls = ctx ? toolCalls(ctx.steps) : [];
      const list = await buildCandidates($, ctx?.request ?? "", ctx?.steps ?? [], calls, 0);
      const kind = (c: Candidate) => (c.tool === "Skill" ? "Skills" : c.tool === "ToolSearch" ? "Tools to load" : c.tool === "Read" ? "File reads" : "Commands");
      const groups = new Map<string, Candidate[]>();
      for (const c of list) groups.set(kind(c), [...(groups.get(kind(c)) ?? []), c]);
      const sections = [...groups].map(
        ([name, items]) =>
          `### ${name} (${items.length})\n\n| Option | Description |\n|---|---|\n`
          + items.map((c) => `| \`${c.key.replace(/\|/g, "\\|")}\` | ${c.description.replace(/\|/g, "\\|").replace(/\s+/g, " ")} |`).join("\n"),
      );
      return {
        text: [
          `## Jev candidates: ${list.length + 1} options`,
          `_For the last prompt: "${clip(ctx?.request ?? "(none)", 60)}". Plus \`claude\`: leave the step to Claude._`,
          ...sections,
        ].join("\n\n"),
      };
    }
    if (arg === "clear") {
      await clearLog($);
      return { text: "Jev pilot: log cleared." };
    }
    if (arg === "export") {
      const log = await readLog($);
      const path = `${await $.session.cwd()}/.jev/decisions.jsonl`;
      try {
        await $.fs.write(path, log.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
        return { text: `Jev pilot: wrote ${log.length} entries to ${path}` };
      } catch (err) {
        return { text: `Jev pilot: could not write ${path}: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    const missing = await jevMissing($);
    const counts = Object.entries(await stats($)).map(([k, v]) => `${k}=${v}`).join(", ") || "none yet";
    const lines = recentDecisions()
      .slice(-10)
      .map((d) => `- ${d.kind}${d.applied ? "" : " (pass)"}: ${d.text}${d.ms !== undefined ? ` [${Math.round(d.ms)}ms]` : ""}`);
    return {
      text: [
        ...(missing.length ? [`Jev pilot: inactive, the jev-api tools are missing (${missing.join(", ")}). jevfort needs jev-api 0.2.0 or later and no permissions.deny rule matching its tools; then restart Claude Code.`] : []),
        `Jev pilot: routing ${routing}, take steps ${takeSteps} (p ≥ ${takeThreshold}), done check ${doneCheck}, subagents ${subagents}`,
        `Decisions (all sessions): ${counts}`,
        lines.length ? `Recent:\n${lines.join("\n")}` : "No decisions this session yet.",
        "Full analysis: /jev report",
      ].join("\n"),
    };
  });

  on("turn.complete", async function onTurnComplete($: Engine, e: TurnEnd, next: Next<TurnEnd, unknown>): Promise<unknown> {
    if ((await jevMissing($)).length) return next(e);
    turns.delete(e.turnId);
    if (e.reason === "aborted" || e.reason === "error") {
      await record($, { kind: "turn", applied: false, text: `turn ${e.reason}`, turnId: e.turnId, data: { reason: e.reason } });
    }
    if (lostFollowUp !== undefined) {
      await record($, { kind: "error", applied: false, text: `done follow-up not sent: ${lostFollowUp}` }).catch(() => undefined);
      lostFollowUp = undefined;
    }
    // Done check: runs here because cc-plugin-sec-default passes classic.Stop on past every user-tier hook.
    if (e.agentId === undefined) {
      const exempt = donePending;
      donePending = false;
      if (doneCheck && !exempt && e.reason === "answer") {
        try {
          if (await checkDone($, e, doneThreshold)) {
            // Not awaited: it resolves only once the new turn starts, which waits for this turn to end. No `$` call in the
            // rejection handler: it runs after this frame, so the next turn.complete logs the error in-frame.
            $.prompt.submit({ text: DONE_PROMPT }).catch((err: unknown) => {
              donePending = false;
              lostFollowUp = String(err);
            });
          }
        } catch (err) {
          await record($, { kind: "error", applied: false, text: `done check failed: ${String(err)}` }).catch(() => undefined);
        }
      }
    }
    return next(e);
  });

  // Answers the estimate_effort tool itself (never `next(e)`: a registered tool no hook answers fails), and logs the
  // outcome of each call Jev made itself, for the report.
  on("tool.call", async function onToolCall($: Engine, e: ToolCall, next: Next<ToolCall, ToolResult>): Promise<ToolResult> {
    if ((await jevMissing($)).length) return next(e);
    if (e.tool === ESTIMATE_TOOL) {
      const input = parseEstimateInput(e);
      if (typeof input === "string") return { isError: true, result: `estimate_effort: ${input}` };
      const r = await askJev($, { request: clip(input.prompt, 4000) }, { effort: effortQuestion, mechanical: mechanicalQuestion });
      const est = estimateEffort(r.ok ? score(r.answers, "effort") : undefined, r.ok ? noul(r.answers, "mechanical") : undefined, input);
      await record($, {
        kind: "estimate",
        applied: est.source !== "fallback",
        text: `${input.model}: ${est.effort} (${est.source}${r.ok ? "" : `, ${r.error}`})`,
        ms: r.ms,
        data: { model: input.model, effort: est.effort, source: est.source, error: r.ok ? undefined : r.error },
      });
      return { result: JSON.stringify(est) };
    }
    const result = await next(e);
    if (e.tool_use_id && ownCalls.has(e.tool_use_id)) {
      const isError = result.deny !== undefined || result.isError === true;
      ownCalls.delete(e.tool_use_id);
      await record($, { kind: "outcome", applied: true, text: `${e.tool} ${isError ? "failed" : "ok"}`, data: { id: e.tool_use_id, isError } });
      // A skill the Skill tool refused is never offered to Jev again.
      const skill = e.skill;
      if (isError && e.tool === "Skill" && typeof skill === "string") await blockSkill($, skill);
    }
    return result;
  });

  // Each model request: Jev may take the step itself, and at step 0 estimates the turn's effort (every turn on
  // Opus/Sonnet, the loop's first turn only on Haiku/Fable, which then hold it) and rates its difficulty to lower the
  // model. One Jev request carries all of it. Every answer is logged; when Claude takes the step, its call is compared
  // with Jev's top action so the take threshold can be calibrated.
  on("turn.step", async function* onTurnStep($: Engine, e: Step, next: (e: Step) => StepRun): StepRun {
    if ((await jevMissing($)).length) return yield* next(e);
    if (e.agentId && !subagents) return yield* next(e);

    const turn = turns.get(e.turnId) ?? { taken: 0 };
    turns.set(e.turnId, turn);

    const ctx = await readTurn($, e.agentId);
    if (!ctx) return yield* next(e);
    const calls = toolCalls(ctx.steps);
    const last = calls.at(-1);

    // Whole-turn bypass: Jev took the one action this simple request needs; a small model reports its result and
    // Claude is not asked at all.
    if (turn.bypassId && e.index > 0) {
      const id = turn.bypassId;
      turn.bypassId = undefined;
      const done = calls.find((c) => c.tool_use_id === id);
      if (done?.text !== undefined) {
        const s = await summarizeResult($, ctx.request, turn.bypassAction ?? done.tool, done.text);
        await record($, {
          kind: "bypass",
          applied: s.ok,
          text: s.ok ? `answered with ${SUMMARY_MODEL} after ${turn.bypassAction}` : `summary failed (${s.reason}), Claude answers`,
          turnId: e.turnId,
          data: { action: turn.bypassAction, model: SUMMARY_MODEL, ...(s.ok ? { usage: s.usage } : { reason: s.reason }) },
        });
        if (s.ok) {
          const usage = { ...s.usage, model: SUMMARY_MODEL };
          yield { kind: "text", index: 0, text: s.text };
          yield { kind: "stop", stopReason: "end_turn", usage };
          return { turnId: e.turnId, index: e.index, answer: s.text, toolUses: [], stopReason: "end_turn", usage };
        }
      }
    }

    const questions: Record<string, Question> = {};
    let candidates: Candidate[] = [];
    if (takeSteps && turn.taken < MAX_TAKES_PER_TURN && (!takeOnlyForBypass || (bypass && e.index === 0 && !e.agentId))) {
      candidates = (await buildCandidates($, ctx.request, ctx.steps, calls, e.index)).filter((c) => !(last && sameCall(last, { tool: c.tool, input: c.input })));
      if (candidates.length) questions.next_action = nextActionQuestion(candidates);
    }
    // Step 0: the difficulty (only for model routing) and the effort estimate, or a Haiku/Fable turn's held first-turn
    // estimate.
    let estimate: EstimateBounds | undefined;
    let held: Effort | undefined;
    let firstTurn: { family?: EstimateModel; from: unknown; effort?: Effort } | undefined;
    if (routing !== "off" && e.index === 0) {
      if (routing === "model") questions.difficulty = difficultyQuestion;
      const loop = e.agentId ?? "";
      const first = firstTurns.get(loop);
      const family = modelFamily(e.model);
      // A model switch starts a new first turn, so a switch to Haiku/Fable gets its own estimate.
      const fresh = !first || first.family !== family;
      // Written before asking Jev: a failed first turn still counts, so later Haiku/Fable turns never re-ask.
      if (fresh) {
        firstTurn = { family, from: e.effort };
        firstTurns.set(loop, firstTurn);
      }
      const sessionEffort = isEffort(e.effort) ? e.effort : undefined;
      estimate = family && sessionEffort && (fresh || EVERY_TURN_MODELS.includes(family)) ? { model: family, defaultEffort: sessionEffort, ...effortRange } : undefined;
      if (estimate) {
        questions.effort = effortQuestion;
        questions.mechanical = mechanicalQuestion;
      }
      // Haiku/Fable after the first turn: hold the first turn's estimate while model and session effort are unchanged.
      held = !estimate && first?.effort && first.family === family && first.from === e.effort ? first.effort : undefined;
      if (held && held !== e.effort) turn.effort = held;
    }
    if (bypass && e.index === 0 && questions.next_action && !e.agentId) questions.single_action = singleActionQuestion;
    // The turn's effort, set at step 0, holds for every step of the turn whatever model the step runs on.
    const routed = (step: Step): Step => {
      if (!turn.route && !turn.effort) return step;
      const effort = turn.effort;
      const model = lowerModel(step.model, turn.route?.model);
      return effort || model ? { ...step, ...(effort ? { effort } : {}), ...(model ? { model } : {}) } : step;
    };

    if (!Object.keys(questions).length) {
      // Inside a longer turn Jev doesn't take steps, but is asked in parallel with Claude which action it would
      // take, so the take threshold can be measured without adding a delay.
      let measure: Promise<JevResult> | undefined;
      let measured: Candidate[] = [];
      if (measureSteps && takeSteps && e.index > 0 && !e.agentId) {
        measured = (await buildCandidates($, ctx.request, ctx.steps, calls, e.index)).filter((c) => !(last && sameCall(last, { tool: c.tool, input: c.input })));
        if (measured.length) {
          measure = askJev($, { request: clip(ctx.request, 4000), recent: summarize(ctx.steps), cwd: await $.session.cwd() }, { next_action: nextActionQuestion(measured) });
        }
      }
      const claudeResult = yield* next(routed(e));
      const measureResult = await measure;
      const measureAnswer = measureResult?.ok ? choice(measureResult.answers, "next_action") : undefined;
      if (measureAnswer) await recordCompare($, e.turnId, e.index, ctx.request, measureAnswer, measured, claudeResult.toolUses, true);
      return claudeResult;
    }

    // A short follow-up ("yes", "do it") is only rated with confidence when Jev sees what it answers: 0.0–0.2
    // without, 0.5–0.8 with.
    const previous = e.index === 0 && !e.agentId ? await previousReply($) : undefined;
    const state = {
      request: clip(ctx.request, 4000),
      ...(previous ? { previous_reply: previous } : {}),
      recent: summarize(ctx.steps),
      cwd: await $.session.cwd(),
    };
    const r = await askJev($, state, questions);
    if (!r.ok) {
      await record($, { kind: "error", applied: false, text: `unavailable: ${r.error}`, ms: r.ms, turnId: e.turnId });
      return yield* next(routed(e));
    }

    if (questions.difficulty || estimate) {
      const difficulty = questions.difficulty ? score(r.answers, "difficulty") : undefined;
      turn.route = difficulty ? route(difficulty, "model") : undefined;
      const model = lowerModel(e.model, turn.route?.model);
      const mechanical = noul(r.answers, "mechanical");
      const est = estimate ? estimateEffort(score(r.answers, "effort"), mechanical, estimate) : undefined;
      if (est) {
        turn.effort = est.effort !== e.effort ? est.effort : undefined;
        if (firstTurn) firstTurn.effort = est.effort;
      }
      const effort = turn.effort;
      const raised = effort !== undefined && EFFORT_ORDER.indexOf(effort) > (isEffort(e.effort) ? EFFORT_ORDER.indexOf(e.effort) : -1);
      const lowered = Boolean((effort && !raised) || model);
      const source = est?.source ?? (held ? "held" : undefined);
      await record($, {
        kind: "route",
        applied: lowered || raised,
        text: `${difficulty ? `difficulty ${difficulty.score.toFixed(2)}` : "effort"} → ${lowered || raised ? `${model ?? e.model}, effort ${effort ?? String(e.effort)}` : "no change"}${source ? ` · ${source}` : ""}`,
        ms: r.ms,
        turnId: e.turnId,
        data: { score: difficulty?.score, confidence: difficulty?.confidence, effort, model, lowered, raised, estimate: est?.effort, source, mechanical },
      });
    }

    const answer = choice(r.answers, "next_action");
    const best = bestAction(answer);
    const singleAction = noul(r.answers, "single_action") ?? 0;
    const pick = takeOnlyForBypass && singleAction < SINGLE_ACTION ? undefined : pickCandidate(answer, candidates, takeThreshold);
    if (answer) {
      const p = answer.probabilities[answer.choice] ?? 0;
      await record($, {
        kind: "take",
        applied: pick !== undefined,
        text: `${answer.choice} (p=${p.toFixed(2)})${pick ? "" : best ? `; best action ${best.key} p=${best.p.toFixed(2)}` : ""}`,
        ms: r.ms,
        turnId: e.turnId,
        data: {
          pick: answer.choice,
          p,
          best: best?.key,
          bestP: best?.p,
          candidates: candidates.length,
          threshold: takeThreshold,
          singleAction: noul(r.answers, "single_action"),
          agentId: e.agentId,
        },
      });
    }

    if (pick) {
      turn.taken += 1;
      const id = `toolu_jev_${crypto.randomUUID().replace(/-/g, "")}`;
      ownCalls.add(id);
      if (singleAction >= SINGLE_ACTION) {
        turn.bypassId = id;
        turn.bypassAction = pick.key;
      }
      yield { kind: "tool", index: 0, id, name: pick.tool };
      yield { kind: "input", index: 0, json: JSON.stringify(pick.input) };
      yield { kind: "stop", stopReason: "tool_use", usage: null };
      return { turnId: e.turnId, index: e.index, answer: "", toolUses: [{ name: pick.tool, input: pick.input }], stopReason: "tool_use", usage: null };
    }

    const result = yield* next(routed(e));

    // Compare Claude's own next call with Jev's top action.
    if (answer) await recordCompare($, e.turnId, e.index, ctx.request, answer, candidates, result.toolUses, false);
    return result;
  });

  // The scratchpad lookups, resolved once: neither the temp roots nor the session id change within a session.
  let scratchpad: { roots: string[]; sid: string } | undefined;
  // Permission check: approves Jev's own vetted calls and writes into this session's scratchpad; every other verdict stays Claude Code's.
  on("tool.check", async function onToolCheck($: Engine, e: Check, next: Next<Check, Verdict>): Promise<Verdict> {
    if ((await jevMissing($)).length) return next(e);
    const base = await next(e);
    // Jev's own calls come from the vetted candidate list: approve them so auto mode's classifier doesn't refuse
    // them. This and the scratchpad branch are the only places jevfort loosens Claude Code's verdict. A settings deny rule still wins.
    // The estimate tool is answered by this hook, so there is nothing to prompt for.
    if (e.tool === ESTIMATE_TOOL && base.decision !== "deny") return { ...base, decision: "allow", reason: "jevfort: estimate_effort is answered locally" };
    if (e.tool_use_id && ownCalls.has(e.tool_use_id)) {
      if (base.decision === "deny") return base;
      return { ...base, decision: "allow", reason: "Jev pilot: vetted action from its read-only/project-script list" };
    }
    const input = (e.input ?? {}) as Record<string, unknown>;
    // Writes into this session's scratchpad are allowed in every permission mode.
    // A mode's ask becomes allow; a settings deny or ask rule (`rule` set) still wins.
    if (WRITE_TOOLS.has(e.tool) && base.decision !== "deny" && !(base.decision === "ask" && base.rule !== undefined)) {
      scratchpad ??= {
        roots: [await $.env.get("CLAUDE_CODE_TMPDIR"), await $.env.get("TMPDIR"), "/tmp"].filter((r): r is string => Boolean(r)),
        sid: await $.session.id(),
      };
      if (inScratchpad(asText(input.file_path ?? input.notebook_path ?? ""), scratchpad.sid, scratchpad.roots)) {
        return { ...base, decision: "allow", reason: "jevfort: write inside this session's scratchpad" };
      }
    }
    return base;
  });
};
