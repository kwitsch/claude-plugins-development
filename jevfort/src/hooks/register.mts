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
import { CACHE_TTL, cacheColor, cacheLabel, minutesLeft, nextTtl } from "./cache.mjs";
import type { CacheTtl } from "./cache.mjs";
import { absolute, AUTH_TOOL, bash, BUILTIN_COMMANDS, clipScript, dedupeSkills, isSafeScript, isSafeToOffer, MAX_READS, MAX_STATS, mentionedPaths, quotedTerms, relevant, SAFE_MAKE, sameCall, SKILL_BLOCKLIST_KEY } from "./candidates.mjs";
import type { Candidate } from "./candidates.mjs";
import { COMPACT_MAX_TOKENS, COMPACT_MODEL, COMPACT_SYSTEM, compactInstructions, compactItems, haikuTranscript, RELEVANCE } from "./compact.mjs";
import { clip, splitTurn, summarize, toolCalls } from "./context.mjs";
import type { SessionMessage, ToolUse, TurnContext } from "./context.mjs";
import { choice, COMPACT_API_TIMEOUT_S, COMPACT_TIMEOUT_MS, HAIKU_API_TIMEOUT_S, HAIKU_TIMEOUT_MS, isAnswer, JEV_API_TIMEOUT_S, JEV_BATCH, JEV_TOOL_PREFIX, JEV_TOOLS, MAX_CHOICE_OPTIONS, MAX_ERROR, MAX_PAUSE_MS, missingJevTools, noul, PAUSE_MS, score, TIMEOUT_MS } from "./jev.mjs";
import type { Answer, JevResult, Question } from "./jev.mjs";
import { bounds, EFFORT_ORDER, effortQuestion, ESTIMATE_SPEC, ESTIMATE_TOOL, estimateEffort, EVERY_TURN_MODELS, inBandRange, inScratchpad, isEffort, mechanicalQuestion, modelFamily, nextActionQuestion, parseEstimateInput, pickCandidate, singleActionQuestion, taskEndQuestion } from "./policy.mjs";
import type { Effort, EstimateBounds, EstimateModel } from "./policy.mjs";
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
  clock: {
    now(): Promise<number>;
    /** Calls `fn` once after `ms` unless cancelled (the budget races cancel it: `sleep` has no cancel and stays pending). */
    after(ms: number, fn: () => void): { cancel(): void };
    /** Calls `fn` every `ms` until cancelled; the engine does not wait for `fn`, so a slow call overlaps the next. */
    every(ms: number, fn: () => void): { cancel(): void };
  };
  /** Environment of the Claude Code process. */
  env: { get(name: string): Promise<string | undefined> };
  /** This plugin's key-value store. */
  store: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown> };
  /** The session's transcript, directory and id. */
  session: {
    messages(opts: { agentId?: string }): Promise<SessionMessage[]>;
    cwd(): Promise<string>;
    id(): Promise<string>;
    /** The context fill (`percent`, 0–100) and token counts. */
    usage(): Promise<{ context: { tokens?: number; window?: number; percent?: number } }>;
  };
  /** Filesystem. */
  fs: {
    exists(path: string): Promise<boolean>;
    stat(path: string): Promise<{ kind: string; size: number; isLink?: boolean }>;
    read(path: string): Promise<string>;
  };
  /** Slash commands. */
  command: {
    list(): Promise<CommandInfo[]>;
    /** Runs a slash command as if typed: queued until the session is idle, resolves once it ran, rejects when refused. */
    run(spec: { command: string; args: string }): Promise<unknown>;
  };
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
    /** Writes a line to Claude Code's debug log (`--debug`), nowhere else. */
    log(text: string, options?: { to?: "transcript" | "debug" }): void;
    /** Redraws the render sites of an event (the effort band). */
    invalidate(event: "ui.render"): void;
    // The element factories are plain functions, called detached from the object (`const { Box } = …`).
    resolve(e: unknown): {
      /** Layout container. */
      Box: (props: Record<string, unknown>) => unknown;
      /** Styled text run. */
      Text: (props: Record<string, unknown>) => unknown;
      /** Pressable button. */
      Button: (props: Record<string, unknown>) => unknown;
    };
  };
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
/** An `agent.offer` event. */
type OfferEvent = { agent: string; description: string } & Record<string, unknown>;
/** A `session.compact` event. */
type CompactEvent = { agentId?: string; trigger: string; messages: readonly SessionMessage[]; instructions?: string } & Record<string, unknown>;
/** A `ui.render` event of the band above the prompt. */
type BandEvent = { props: { hasSurvey: boolean } } & Record<string, unknown>;
/** A `turn.complete` event. */
type TurnEnd = { turnId: string; reason?: string; agentId?: string; answer?: string } & Record<string, unknown>;
/** What `buildCandidates` already scanned for paths this turn: the request text, `steps` rows, and the calls by index. */
type PathScan = {
  /** The request the scan belongs to; unset before the first scan. */
  request?: string;
  /** How many `steps` rows were scanned. */
  steps: number;
  /** Indexes of the calls whose result text was scanned. */
  calls: Set<number>;
  /** The paths found so far, as written. */
  paths: Set<string>;
};
/** An empty path scan. */
const newScan = (): PathScan => ({ steps: 0, calls: new Set(), paths: new Set() });
/** A turn's `$.fs.stat` results by absolute path (`undefined`: missing or refused). */
type StatCache = Map<string, { kind: string; size: number; isLink?: boolean } | undefined>;
/** What one turn's `buildCandidates` calls share (dropped with the turn): stat results, the path scan, the cwd and the project's commands. */
type TurnCache = {
  /** Stat results by absolute path. */
  statted: StatCache;
  /** The path scan. */
  scan: PathScan;
  /** The cwd of the last build. */
  cwd?: string;
  /** The project's commands for `cwd`. */
  project?: Candidate[];
};
/** An empty turn cache. */
const newCache = (): TurnCache => ({ statted: new Map(), scan: newScan() });
/** The `on` the engine passes to `register`, one overload per hooked event. */
type On = {
  (event: "session.start", hook: Hook<unknown, unknown>): void;
  /** Raised for /clear and an in-process /resume, where no `session.start` follows. */
  (event: "session.end", hook: Hook<unknown, unknown>): void;
  (event: "turn.complete", hook: Hook<TurnEnd, unknown>): void;
  (event: "tool.call", hook: Hook<ToolCall, ToolResult>): void;
  (event: "tool.call", matcher: { tool: "Agent" }, hook: Hook<AgentCall, ToolResult>): void;
  (event: "turn.step", hook: ($: Engine, e: Step, next: (e: Step) => StepRun) => StepRun): void;
  (event: "tool.check", hook: Hook<Check, Verdict>): void;
  (event: "agent.offer", hook: Hook<OfferEvent, unknown>): void;
  (event: "session.compact", hook: Hook<CompactEvent, unknown>): void;
  /** Registers the effort band render hook for the `AbovePrompt` site. */
  (event: "ui.render", matcher: { component: "AbovePrompt" }, hook: ($: Engine, e: BandEvent, next: (e: BandEvent) => unknown) => unknown): void;
};
/** The plugin options the engine passes to `register` (the manifest's `userConfig` values). */
type Options = Partial<Record<string, unknown>>;

/** How often the cache countdown and the auto-compact check run. */
const CACHE_TICK_MS = 15_000;
/** How many steps Jev may take in one turn. */
const MAX_TAKES_PER_TURN = 3;
/** The file tools whose writes into the session scratchpad are always allowed. */
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

/**
 * Tells whether `tool.check` must return Claude Code's verdict unchanged: a deny, an allow (rewording it makes the
 * security plugin warn the user) or an ask from a settings rule (`rule` set). Only a mode's bare ask may become allow.
 *
 * @param base - The verdict of the hooks beneath.
 * @returns `true` when jevfort must not loosen it.
 */
function settled(base: Verdict): boolean {
  return base.decision === "deny" || base.decision === "allow" || (base.decision === "ask" && base.rule !== undefined);
}
/** From this `single_action` probability on, a taken step bypasses the whole turn. */
const SINGLE_ACTION = 0.8;
/**
 * Claude Code's error texts (2.1.325) for a call that never ran: rejected or denied by the user, a rule or a hook.
 * A bypass take refused this way goes back to Claude, which carries the user's feedback or tries another way; a
 * failed run (non-zero exit) does not match and is still summarized.
 */
const REFUSED = /^(The user doesn't want to proceed with this tool use|Permission for this tool use was denied|Permission to use .*has been denied|Hook '[^']*' blocked)/s;
/**
 * `String(v)` for a tool-input field, typed `unknown` so the lint's base-to-string check accepts a `?? ""` fallback.
 *
 * @param v - The field.
 * @returns Its string form.
 */
const asText = (v: unknown): string => String(v);

/**
 * Jev did not answer in time: no new request is sent until `until` (a dead endpoint would otherwise cost the full budget
 * at every prompt and step). `ms` is the pause that follows the next timeout, `at` the time of the last one (a clock that
 * went back, as in a new session, ends the pause).
 */
const jevPause = { until: 0, ms: 0, at: 0, error: "" };

/** jev-api's own timeout text (`timeout after 4000ms`, with Haiku answering `fallback: timeout after 14000ms`): it reaches `askJev` as an error when jev-api's clock ends before jevfort's, as Haiku's 14 s does before the 15 s budget. */
const API_TIMEOUT = /\btimeout after \d+ms\b/;

/**
 * Starts the pause after a timeout of Jev, or doubles it. Only a call that started after the previous pause lengthens
 * it: parallel calls of one outage time out together and count once.
 *
 * @param startedAt - When the timed-out call started.
 * @param budgetMs - The call's budget.
 * @param error - The timeout text the paused answer reports.
 */
function pauseAfterTimeout(startedAt: number, budgetMs: number, error: string): void {
  if (startedAt < jevPause.until) return;
  jevPause.ms = jevPause.ms ? Math.min(jevPause.ms * 2, MAX_PAUSE_MS) : PAUSE_MS;
  jevPause.until = startedAt + budgetMs + jevPause.ms;
  jevPause.at = startedAt;
  jevPause.error = error;
}

/**
 * Asks Jev through the jev-api plugin's `batch` tool; never throws. All questions go out in one `$.tool.call` (one
 * System One request) inside the calling hook's frame, raced against its budget (`TIMEOUT_MS`, `COMPACT_TIMEOUT_MS` for the compaction ranking, `HAIKU_TIMEOUT_MS` while Haiku answers). All or nothing: a failed call, a
 * timeout or a wrong answer is `{ ok: false }`, so callers fall back to Claude Code's own behaviour. A call still
 * running when the budget ends is ignored.
 *
 * @param $ - Engine interface.
 * @param state - The facts the questions are about; sent as JSON text.
 * @param questions - The questions by id.
 * @param slow - The call is off the interactive path (a compaction ranking): it gets the longer {@link COMPACT_TIMEOUT_MS} budget.
 * @returns The answers, or the error, with the time taken.
 */
async function askJev($: Engine, state: unknown, questions: Record<string, Question>, slow = false): Promise<JevResult> {
  // A refused clock read must not throw out of askJev (its caller may be past `next`): the wall clock stands in.
  const startedAt = await $.clock.now().catch(() => Date.now());
  if (startedAt < jevPause.at) Object.assign(jevPause, { until: 0, ms: 0, at: 0, error: "" });
  const done = async (r: { ok: true; answers: Record<string, Answer> } | { ok: false; error: string }): Promise<JevResult> => ({ ...(r.ok ? r : { ok: false as const, error: clip(r.error, MAX_ERROR) }), ms: (await $.clock.now().catch(() => Date.now())) - startedAt });

  // No `ms`: nothing was sent, so the report must not count it as a Jev call.
  if (startedAt < jevPause.until) return { ok: false, error: `paused for ${Math.ceil((jevPause.until - startedAt) / 1000)} s after a timeout (${jevPause.error})` };
  // Without Jev access jev-api answers through Haiku, which needs a longer budget (jev-api reads the same three variables).
  // Read once per turn (`haikuPath`): a settings `env` change takes effect from the next turn.
  const haiku = await (haikuPath ??= Promise.all([$.env.get("TYPESAFE_API_KEY"), $.env.get("TYPESAFE_BASE_URL"), $.env.get("JEV_URL")]).then((vals) => !vals.some((v) => v?.trim()), () => true));
  const budgetMs = haiku ? HAIKU_TIMEOUT_MS : slow ? COMPACT_TIMEOUT_MS : TIMEOUT_MS;
  const apiTimeoutS = haiku ? HAIKU_API_TIMEOUT_S : slow ? COMPACT_API_TIMEOUT_S : JEV_API_TIMEOUT_S;
  const entries = Object.entries(questions);
  const call = (async (): Promise<Record<string, Answer>> => {
    const r = await $.tool.call({ tool: JEV_BATCH, state: JSON.stringify(state), questions: entries.map(([, q]) => q), timeout: apiTimeoutS });
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
      const answer: unknown = list[i];
      if (!isAnswer(answer, q.type)) throw new Error(`batch: no valid ${q.type} answer for questions[${i}]`);
      return [id, answer];
    }));
  })();
  // A call abandoned at the timeout must not raise an unhandled rejection.
  call.catch(() => undefined);
  const timer = deadline($, budgetMs);

  try {
    const answers = await Promise.race([call, timer.elapsed]);
    if (!answers) {
      // Only a timeout pauses (a refused or failing endpoint answers fast and costs nothing).
      pauseAfterTimeout(startedAt, budgetMs, `timeout after ${budgetMs}ms`);
      return done({ ok: false, error: `timeout after ${budgetMs}ms` });
    }
    jevPause.ms = 0;
    jevPause.until = 0;
    return done({ ok: true, answers });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // jev-api's own timeout, answered before jevfort's clock ran out, is a timeout too.
    const timedOut = API_TIMEOUT.exec(error);
    if (timedOut) pauseAfterTimeout(startedAt, budgetMs, timedOut[0]);
    return done({ ok: false, error });
  } finally {
    timer.cancel();
  }
}

/**
 * A cancellable budget for `Promise.race` (`$.clock.sleep` has no cancel and would stay pending after the race settled).
 *
 * @param $ - Engine interface.
 * @param ms - The budget.
 * @returns `elapsed` resolves with `undefined` after `ms` (rejects only when `$.clock.after` throws; a timer the engine refuses later never fires, so `elapsed` stays pending), `cancel` stops the timer.
 */
function deadline($: Engine, ms: number): { elapsed: Promise<undefined>; cancel(): void } {
  let timer: { cancel(): void } | undefined;
  const elapsed = new Promise<undefined>((resolve) => {
    timer = $.clock.after(ms, () => resolve(undefined));
  });
  return { elapsed, cancel: () => timer?.cancel() };
}

/** This turn's jev-api listing, shared by concurrent hooks; dropped at every main-loop `turn.complete` and at `session.start`. */
let jevTools: Promise<string[]> | undefined;
/** The whole `$.tool.list()` answer behind `jevTools`: step 0 offers its deferred tools without a second listing. */
let toolListing: Promise<ToolInfo[]> | undefined;
/** This turn's offerable skills (listed, not built in, not blocklisted, deduped), offered at step 0; dropped with `jevTools` and by a new block. */
let skillList: Promise<CommandInfo[]> | undefined;
/** This turn's "none of jev-api's three env values is set, Haiku answers" decision; dropped with `jevTools`. */
let haikuPath: Promise<boolean> | undefined;

/** Drops the per-turn engine reads shared across hooks: at every main-loop `turn.complete`, at `session.start`'s baseline. */
function dropTurnReads(): void {
  jevTools = undefined;
  toolListing = undefined;
  skillList = undefined;
  haikuPath = undefined;
}
/** The missing tools of the last applied listing joined by ", " ("" = ready); undefined until `session.start` set the session's baseline. */
let jevState: string | undefined;
/** Whether `estimate_effort` is registered in this session; a failed registration is retried by the next listing. */
let estimateRegistered = false;
/** Set when the band's button could not redraw out of frame; the next applied listing redraws it. */
let bandStale = false;

/** When the main loop's prompt cache goes cold (`0`: no response seen yet, or a compaction just rewrote it). */
let cacheExpires = 0;
/** The cache write lifetime in force. */
let cacheTtl: CacheTtl = "1h";
/** When the last main-loop response came back. */
let lastResponseAt: number | undefined;
/** The minutes left the band was last drawn for (`null`: no countdown). */
let shownMinutes: number | null = null;
/** A main-loop turn is running: no auto-compact then. */
let turnRunning = false;
/** This cold period was already compacted (reset by the next response). */
let coldCompacted = false;
/** A context-fill compaction is already queued for this fill period (cleared when a compaction stands, by `resetCache`). */
let compactQueued = false;
/** The session's cache tick, cancelled and started again by each `session.start`. */
let cacheTimer: { cancel(): void } | undefined;

/**
 * Remembers the minutes the band shows and redraws it when they changed.
 *
 * @param $ - Engine interface.
 * @param minutes - From `minutesLeft`.
 */
function showMinutes($: Engine, minutes: number | null): void {
  if (minutes === shownMinutes) return;
  shownMinutes = minutes;
  try {
    $.ui.invalidate("ui.render");
  } catch { /* no mounted render site */ }
}

/**
 * Starts the countdown over: a conversation that just began (or a new session) has no warm cache and nothing of the
 * old one stays on screen. Always redraws the band: its callers have just forgotten the old conversation's efforts too.
 *
 * @param $ - Engine interface.
 */
function resetCache($: Engine): void {
  cacheExpires = 0;
  cacheTtl = "1h";
  lastResponseAt = undefined;
  coldCompacted = false;
  compactQueued = false;
  shownMinutes = null;
  try {
    $.ui.invalidate("ui.render");
  } catch { /* no mounted render site */ }
}

/**
 * Redraws the band when the countdown's minute changed and, once the cache is cold and the chat full enough,
 * compacts it. Run by the session's 15 s timer.
 *
 * @param $ - Engine interface.
 * @param autoCompactPercent - The `autoCompactPercent` option: the context fill from which a chat with a cold cache is compacted; 0 is off.
 */
async function cacheTick($: Engine, autoCompactPercent: number): Promise<void> {
  // No response seen and nothing drawn: no engine call.
  if (cacheExpires <= 0 && shownMinutes === null) return;
  // Read once before the clock await: the minutes and the staleness check below must judge the same expiry.
  const expires = cacheExpires;
  const now = await $.clock.now();
  // A response or a reset during the await moved the expiry and drew the fresh countdown itself.
  if (cacheExpires !== expires) return;
  const minutes = minutesLeft(expires, now);
  showMinutes($, minutes);
  if (turnRunning || autoCompactPercent <= 0 || minutes !== 0 || coldCompacted) return;
  const percent = (await $.session.usage()).context.percent ?? 0;
  // The await yields: a tick that overlapped, a turn that started, a response that refreshed the cache (`cacheExpires`
  // moved) or a session reset (zeroed it) makes this decision stale, so the state is read again.
  // A non-finite fill (0/0, an empty window) is no fill: `NaN < x` is false and would compact.
  if (!Number.isFinite(percent) || percent < autoCompactPercent || coldCompacted || turnRunning || cacheExpires !== expires) return;
  coldCompacted = true;
  // The app's own /compact, run as if typed: queued until the session is idle, resolved once it ran. A compaction that
  // stands zeroes `cacheExpires` itself (the session.compact hook). A refusal (a Stop, DISABLE_COMPACT) is swallowed:
  // this cold period is not tried again.
  await $.command.run({ command: "compact", args: "" }).catch(() => undefined);
}

/**
 * Passes a step's chunks through and, when a main-loop response on the chat's own model reports usage, restarts the
 * cache countdown.
 *
 * @param $ - Engine interface.
 * @param original - The step event as the engine raised it.
 * @param run - The step run to watch.
 * @returns The same run.
 */
async function* cacheWatch($: Engine, original: Step, run: StepRun): StepRun {
  const result = yield* run;
  if (original.agentId === undefined && result.usage) {
    // A cosmetic feature must never fail the model step whose result is already in (the engine rethrows a hook's error after the request ran).
    try {
      const now = await $.clock.now();
      cacheTtl = nextTtl(result.usage, cacheTtl, lastResponseAt === undefined ? undefined : now - lastResponseAt);
      lastResponseAt = now;
      cacheExpires = now + CACHE_TTL[cacheTtl];
      coldCompacted = false;
      showMinutes($, minutesLeft(cacheExpires, now));
    } catch { /* the countdown skips this response */ }
  }
  return result;
}

/**
 * Phase 3: before a compaction, Jev scores how relevant each recent tool result is; the summarizer is told what to
 * keep. Returns the event with the ranking added to its instructions; unchanged when Jev is missing, fails or nothing
 * stands out.
 *
 * @param $ - Engine interface.
 * @param e - The compaction event.
 * @returns The event to continue with.
 */
async function withJevRanking($: Engine, e: CompactEvent): Promise<CompactEvent> {
  if ((await jevMissing($)).length) return e;
  if (e.trigger !== "manual" && e.trigger !== "auto") return e;
  const items = compactItems(e.messages);
  if (items.length < 3) return e;

  const request = turnOf([...e.messages])?.request ?? "";
  const questions: Record<string, Question> = {};
  items.forEach((it, i) => {
    questions[`item_${i}`] = {
      type: "score",
      instructions: `How relevant is this earlier tool call and its result to continuing the work on \`request\`? Call: ${it.label}. Result: ${it.result || "(no output)"}`,
      criteria: RELEVANCE,
    };
  });
  const r = await askJev($, { request: clip(request, 2000), item_count: items.length }, questions, true);
  if (!r.ok) return e;
  const scores = items.map((_, i) => score(r.answers, `item_${i}`)?.score);
  const added = compactInstructions(items, scores);
  return added ? { ...e, instructions: e.instructions ? `${e.instructions}\n\n${added}` : added } : e;
}

/**
 * The needed jev-api tools that are not listed; a non-empty answer turns jevfort's use of Jev off: every hook that
 * needs Jev passes through untouched. The render hooks, `estimate_effort` and the work that needs no Jev (the
 * cache countdown, the Haiku compaction, the auto-compact timer) go on. Listed once per turn (`jevTools`); a listing
 * that differs from the last applied one is applied by {@link jevApply}. A failed or malformed listing counts as all
 * missing, so the shared promise never rejects.
 *
 * @remarks
 * Module level, with its cache, because the engine accepts `$` passed only to top-level functions.
 *
 * @param $ - Engine interface.
 * @returns The missing full tool names, empty when jevfort can ask Jev.
 */
function jevMissing($: Engine): Promise<string[]> {
  return (jevTools ??= (toolListing = $.tool.list())
    .then((t) => missingJevTools(t.map((x) => x.name)))
    .catch(() => [...JEV_TOOLS])
    .then(async (missing) => {
      // Beneath session.start (jevState undefined) jev-api may not have registered yet: such a listing changes nothing.
      if (jevState !== undefined) await jevApply($, missing);
      return missing;
    }));
}

/**
 * Applies a jev-api listing once when it differs from the last applied one: becoming ready registers
 * `estimate_effort` (whatever `routing` says: Skills and subagents call it too); both directions redraw the effort band.
 * Never throws: a failed registration is caught.
 *
 * @remarks
 * Module level because the engine accepts `$` passed only to top-level functions; runs inside the awaited listing
 * promise of {@link jevMissing} (or `session.start`), so its `$.tool.register` stays in-frame.
 *
 * @param $ - Engine interface.
 * @param missing - The missing full tool names of the listing.
 */
async function jevApply($: Engine, missing: string[]): Promise<void> {
  const key = missing.join(", ");
  const changed = key !== jevState;
  if (!changed && !bandStale && (key || estimateRegistered)) return;
  jevState = key;
  bandStale = false;
  try {
    $.ui.invalidate("ui.render");
  } catch { /* no mounted render site (headless): the band just is not redrawn */ }
  if (key) return;
  try {
    if (!estimateRegistered) await $.tool.register(ESTIMATE_SPEC);
    estimateRegistered = true;
  } catch { /* retried by the next listing */ }
}

/**
 * The current turn of the main loop or of a subagent.
 *
 * @param $ - Engine interface.
 * @param agentId - The subagent, or none for the main loop.
 * @returns The request and the steps so far, or `undefined` without a request.
 */
async function readTurn($: Engine, agentId?: string): Promise<TurnContext | undefined> {
  return turnOf(await $.session.messages(agentId ? { agentId } : {}));
}

/**
 * The current turn of a transcript already read.
 *
 * @param messages - What `$.session.messages` answered.
 * @returns The request and the steps so far, or `undefined` without a request.
 */
function turnOf(messages: SessionMessage[] | undefined): TurnContext | undefined {
  if (!Array.isArray(messages)) return undefined;
  return splitTurn(messages);
}

/**
 * The end of the assistant's last reply, so short follow-ups are judged in context.
 *
 * @param messages - The main loop's transcript as `$.session.messages` answered it (the caller's one read per hook).
 * @returns The last 800 characters of the reply (a low surrogate left by the cut dropped), or `undefined`.
 */
function previousReply(messages: SessionMessage[] | undefined): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.text.trim()) return m.text.length > 800 ? `…${m.text.slice(-800).replace(/^[\uDC00-\uDFFF]/, "")}` : m.text;
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
  const locks = [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lockb", "bun"], ["bun.lock", "bun"]] as const;
  const found = await Promise.all(locks.map(([file]) => $.fs.exists(`${cwd}/${file}`).catch(() => false)));
  return locks.find((_, i) => found[i])?.[1] ?? "npm";
}

/**
 * The project's read-only git commands, safe scripts, Makefile targets and test runners; the probes run in parallel.
 *
 * @param $ - Engine interface.
 * @param cwd - The project directory.
 * @returns The candidates, in the order git, scripts, make, cargo, go, pytest.
 */
async function projectCommands($: Engine, cwd: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const has = (file: string) => $.fs.exists(`${cwd}/${file}`).catch(() => false);
  const read = (file: string) => $.fs.read(`${cwd}/${file}`).catch(() => undefined);
  const [git, pkg, makefile, cargo, gomod, pytestIni, conftest, pyproject] = await Promise.all([has(".git"), read("package.json"), read("Makefile"), has("Cargo.toml"), has("go.mod"), has("pytest.ini"), has("conftest.py"), read("pyproject.toml")]);

  // Read-only git commands.
  if (git) {
    // One "what changed" option: status and diff --stat as two options split Jev's probability (0.75/0.24 live); merged it reaches 0.93.
    out.push(bash("git status --short && git diff --stat", "Show what changed: which files are modified, staged or untracked, with a per-file count of changed lines"));
    out.push(bash("git diff", "Show the full line-by-line diff of unstaged changes"));
    out.push(bash("git log --oneline -n 15", "Show the 15 most recent commits"));
  }

  // The project's own safe scripts and test runners.
  if (typeof pkg === "string") {
    let scripts: Record<string, string> = {};
    try {
      scripts = (JSON.parse(pkg.replace(/^\uFEFF/, "")) as { scripts?: Record<string, string> }).scripts ?? {};
    } catch {
      // a malformed package.json offers no scripts
    }
    const runner = await packageRunner($, cwd);
    for (const name of Object.keys(scripts).filter((n) => isSafeScript(n) && typeof scripts[n] === "string")) {
      const command = name === "test" ? `${runner} test` : `${runner} run ${name}`;
      out.push(bash(command, `Run the project's "${name}" script (${clipScript(scripts[name])})`));
    }
  }
  if (typeof makefile === "string") {
    const targets = new Set([...makefile.matchAll(/^([A-Za-z][\w-]*):(?!=)/gm)].map((m) => m[1]));
    for (const t of [...targets].filter((t) => SAFE_MAKE.test(t))) out.push(bash(`make ${t}`, `Run the Makefile's "${t}" target`));
  }
  if (cargo) {
    out.push(bash("cargo test", "Run the Rust tests"));
    out.push(bash("cargo check", "Type-check the Rust project"));
    out.push(bash("cargo clippy", "Lint the Rust project"));
  }
  if (gomod) {
    out.push(bash("go test ./...", "Run the Go tests"));
    out.push(bash("go vet ./...", "Vet the Go code"));
    out.push(bash("go build ./...", "Build the Go packages"));
  }
  if (pytestIni || conftest || /\[tool\.pytest/.test(String(pyproject ?? ""))) {
    out.push(bash("python -m pytest -q", "Run the Python tests"));
  }
  return out;
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
 * @param cache - The turn's shared reads, filled here (a fresh one by default, so nothing outlives the turn): the stat
 * results by absolute path (at most `MAX_STATS` new paths per call), the path scan (only new rows are scanned; a new request
 * row or a shorter step list, as after a mid-turn compaction or a delivered message, starts a new scan), the cwd
 * (read again every call) and the project's commands (dropped when the cwd changed).
 * @returns At most `MAX_CHOICE_OPTIONS - 1` candidates (one of jev-api's choice options is `claude`).
 */
async function buildCandidates($: Engine, request: string, steps: readonly SessionMessage[], calls: readonly ToolUse[], stepIndex: number, cache: TurnCache = newCache()): Promise<Candidate[]> {
  const { statted } = cache;
  // Read every step: a carried-over `cd` or EnterWorktree moves the cwd mid-turn, and the project commands with it.
  const cwd = await $.session.cwd();
  if (cache.cwd !== cwd) {
    cache.cwd = cwd;
    cache.project = undefined;
  }
  const out: Candidate[] = [];

  // Files named in the request or the turn's text/tool output, not yet read this turn.
  // Rows are final once seen, except a call's result, which may arrive a step later: calls count once they have text.
  // A new request row or fewer steps (a mid-turn compaction, a delivered message) is a new transcript: scan it again.
  if (cache.scan.request !== undefined && (cache.scan.request !== request || steps.length < cache.scan.steps)) cache.scan = newScan();
  const { scan } = cache;
  const texts = scan.request === undefined ? [request] : [];
  scan.request = request;
  for (; scan.steps < steps.length; scan.steps++) texts.push(steps[scan.steps].text);
  calls.forEach((c, i) => {
    if (c.text === undefined || scan.calls.has(i)) return;
    scan.calls.add(i);
    texts.push(c.text);
  });
  const alreadyRead = new Set(calls.filter((c) => c.tool === "Read").map((c) => absolute(cwd, String(c.input.file_path))));
  // Files offered in this build: one Read candidate per file, whatever spelling named it.
  const offered = new Set<string>();
  let reads = 0;
  let probes = 0;
  for (const p of mentionedPaths(texts, scan.paths)) {
    if (reads >= MAX_READS) break;
    if (p.startsWith("~")) continue;
    const file = absolute(cwd, p);
    if (offered.has(file) || alreadyRead.has(file) || !isSafeToOffer(file, cwd)) continue;
    if (!statted.has(file)) {
      // Past the budget only paths statted by an earlier step are still offered.
      if (probes >= MAX_STATS) continue;
      probes += 1;
      statted.set(file, await $.fs.stat(file).catch(() => undefined));
    }
    const stat = statted.get(file);
    // A symlink may lead outside the project: never offer one.
    if (stat?.kind !== "file" || stat.isLink || stat.size > 2_000_000) continue;
    out.push({ key: `read ${p}`, description: `Read the file ${p}`, tool: "Read", input: { file_path: file } });
    offered.add(file);
    reads += 1;
  }

  // Searches for terms the user quoted.
  for (const term of quotedTerms(request)) {
    out.push(bash(`grep -rnF --exclude-dir=node_modules --exclude-dir=.git -- '${term}' .`, `Search the project for the text "${term}"`));
  }

  // The project's git commands, scripts and test runners: probed once per turn and cwd (a file created later counts next turn).
  out.push(...(cache.project ??= await projectCommands($, cwd)));

  // First move of a turn only: a skill to invoke, or a deferred tool to load.
  if (stepIndex === 0) {
    // Only related skills, also when the prompt says "skill": every listed skill made the request outgrow the budget (F13).
    for (const c of relevant(request, await offerableSkills($))) {
      out.push({ key: `skill ${c.name}`, description: `Use the skill or command "${c.name}": ${clipScript(c.description)}`, tool: "Skill", input: { skill: c.name } });
    }
    const loaded = new Set(calls.filter((c) => c.tool === "ToolSearch").map((c) => String(c.input.query)));
    // jev-api's tools are jevfort's own Jev back end, never a tool for Claude to load.
    const tools = (await (toolListing ?? $.tool.list()).catch(() => [])).filter((t) => t.mcp && !AUTH_TOOL.test(t.name) && !t.name.startsWith(JEV_TOOL_PREFIX) && !loaded.has(`select:${t.name}`));
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
 * The plugin and user skills Jev may offer: listed, not built in, not `jev`, not blocklisted, deduped. Read once per turn
 * (`skillList`), offered at step 0; never rejects.
 *
 * @param $ - Engine interface.
 * @returns The skills.
 */
function offerableSkills($: Engine): Promise<CommandInfo[]> {
  return (skillList ??= (async () => {
    const commands = await $.command.list().catch(() => []);
    const blocked = new Set(((await $.store.get(SKILL_BLOCKLIST_KEY).catch(() => undefined)) as string[] | undefined) ?? []);
    return dedupeSkills(commands.filter((c) => (c.source === "plugin" || c.source === "user") && !BUILTIN_COMMANDS.has(c.name) && !blocked.has(c.name)));
  })());
}

/**
 * Writes the effort chosen for a turn to the debug log: one line per estimate, the only line jevfort logs.
 *
 * @param $ - Engine interface.
 * @param e - The step event: its model and session effort.
 * @param source - Where the effort came from (`jev`, `mechanical`, `fallback`, `held`, or why Jev gave none).
 * @param chosen - The effort jevfort set for the turn, `undefined` when it left the session effort.
 */
function debugEffort($: Engine, e: Step, source: string, chosen: string | undefined): void {
  try {
    // $.ui.log returns nothing (no promise to catch); a throw must not cost the step its effort.
    $.ui.log(`effort ${e.agentId ? `(agent ${e.agentId}) ` : ""}${String(e.model)}: session ${String(e.effort)} → ${chosen ?? "unchanged"} · ${source}`, { to: "debug" });
  } catch {
    // The log line is cosmetic.
  }
}

/**
 * Never offers skill `name` again (the Skill tool refused it).
 *
 * @param $ - Engine interface.
 * @param name - The skill.
 */
async function blockSkill($: Engine, name: string): Promise<void> {
  try {
    const list = ((await $.store.get(SKILL_BLOCKLIST_KEY)) as string[] | undefined) ?? [];
    if (!list.includes(name)) await $.store.set(SKILL_BLOCKLIST_KEY, [...list, name]);
    skillList = undefined;
  } catch {
    // A failing store (over its cap, a full disk) must not fail the tool call hook after the call ran.
  }
}

/**
 * Context-fill compaction at the end of a main-loop turn. From `fromPercent` the first turn Jev judges to have closed a
 * task queues the app's `/compact` (the `session.compact` hook makes it the jevfort-optimised one); from `forcePercent`
 * the next turn end queues it without asking. Queued once per fill period.
 *
 * @remarks
 * Module level because the engine accepts `$` passed only to top-level functions.
 *
 * @param $ - Engine interface.
 * @param e - The `turn.complete` event.
 * @param ready - jev-api is usable (the judgement needs it, the forced compaction does not).
 * @param fromPercent - Context fill from which a task end compacts; 0 is off.
 * @param forcePercent - Context fill from which any turn end compacts; 0 is off.
 */
async function contextCompact($: Engine, e: TurnEnd, ready: boolean, fromPercent: number, forcePercent: number): Promise<void> {
  if (e.agentId !== undefined || compactQueued || (fromPercent <= 0 && forcePercent <= 0)) return;
  const percent = await fillPercent($);
  const forced = forcePercent > 0 && percent >= forcePercent;
  if (!forced && (fromPercent <= 0 || percent < fromPercent || !ready || e.reason !== "answer")) return;
  if (!forced) {
    const ctx = await readTurn($);
    if (!ctx) return;
    const r = await askJev($, { request: clip(ctx.request, 3000), final_message: clip(e.answer ?? "", 2000), recent: summarize(ctx.steps) }, { end: taskEndQuestion });
    if (!r.ok) return;
    const end = noul(r.answers, "end");
    if (end === undefined || end < 0.5) return;
  }
  // Re-read after the awaits: a concurrent turn end may have queued it.
  if (compactQueued) return;
  compactQueued = true;
  // Not awaited: it resolves only once the compaction ran, after this turn ended. No `$` call in the handlers. The
  // resolve clears the flag too: cc-plugin-sec-default bypasses the session.compact hook that would (2.1.325).
  $.command.run({ command: "compact", args: "" }).then(() => {
    compactQueued = false;
  }, () => {
    compactQueued = false;
  });
}

/**
 * The context fill in percent; a non-finite fill (0/0, an empty window) is no fill: `Infinity >= x` would force a compaction.
 *
 * @param $ - Engine interface.
 * @returns The fill, 0 when unreadable or not finite.
 */
async function fillPercent($: Engine): Promise<number> {
  const reported = (await $.session.usage().catch(() => undefined))?.context.percent ?? 0;
  return Number.isFinite(reported) ? reported : 0;
}

/**
 * Module entry point called by the engine.
 *
 * @param on - Registers a hook for an event.
 * @param options - The manifest's `userConfig` values.
 */
export const register = (on: On, options: Options): void => {
  // Only an explicit `false` turns effort routing (and the band's effort row) off: any other value is the default, on.
  const routing = options.routing !== false;
  const takeSteps = options.takeSteps !== false;
  const takeThreshold = typeof options.takeThreshold === "number" ? options.takeThreshold : 0.85;
  const subagents = options.subagents !== false;
  const bypass = options.bypass !== false;
  // Benchmark (2026-10-14): taking steps inside multi-step coding turns only added turns (+6, +3% cost); taking pays off when the whole turn is bypassed.
  const takeOnlyForBypass = options.takeOnlyForBypass !== false;
  const threshold = (key: string, fallback: number): number => {
    const v = options[key];
    return typeof v === "number" ? v : fallback;
  };
  // The bounds of the turn-start effort estimate; invalid or inverted options fall back to low..xhigh together.
  const configuredRange = bounds(options.minEffort, options.maxEffort);
  const effortRange: { minEffort: Effort; maxEffort: Effort } = configuredRange ?? { minEffort: "low", maxEffort: "xhigh" };

  const jevRanking = options.compaction !== false;
  const haikuCompact = options.haikuCompact !== false;
  const autoCompactPercent = threshold("autoCompactPercent", 60);
  const taskCompactPercent = threshold("taskCompactPercent", 80);
  const forceCompactPercent = threshold("forceCompactPercent", 95);

  /** The effort band: the session effort and Jev's chosen effort seen at the last main-loop turn's step 0. */
  let band: { configured?: Effort; chosen?: Effort } = {};
  /** Temporary off switch of the automatic effort choice, pressed in the band; reset when a conversation ends. */
  let autoOff = false;

  // The effort band above the prompt: the levels between the configured minimum and maximum (plus the session effort when outside), the session effort bold, Jev's choice for the turn blue, and the
  // Auto button, then the cache countdown. Without the effort row (jevfort inactive, also before the session
  // baseline, or `routing: false`) only the countdown shows, above whatever another plugin draws in the band beneath
  // (the effort row takes the whole band); a survey holds the band.
  on("ui.render", { component: "AbovePrompt" }, async function onRenderBand($: Engine, e: BandEvent, next: (e: BandEvent) => unknown): Promise<unknown> {
    // The cache countdown needs no Jev: it shows also while the effort row is hidden.
    const effortRow = routing && jevState === "";
    if (e.props.hasSurvey || (!effortRow && shownMinutes === null)) return next(e);
    const { Box, Text, Button } = $.ui.resolve(e);
    const color = shownMinutes === null ? undefined : cacheColor(shownMinutes);
    const cache = shownMinutes === null ? [] : [Text({ ...(color ? { color } : { dimColor: true }), children: [` ${cacheLabel(shownMinutes)}`] })];
    if (!effortRow) return Box({ flexDirection: "column", children: [Box({ flexDirection: "row", children: cache }), await next(e)] });
    return Box({
      flexDirection: "row",
      children: [
        ...EFFORT_ORDER.filter((level) => inBandRange(level, effortRange) || level === band.configured || level === band.chosen).map((level) =>
          Text({
            ...(level === band.configured ? { bold: true } : {}),
            ...(level === band.chosen ? { color: "blue" } : {}),
            ...(level !== band.configured && level !== band.chosen ? { dimColor: true } : {}),
            children: [`${level} `],
          })
        ),
        Button({
          key: "auto",
          label: `Jev auto: ${autoOff ? "off" : "on"}`,
          onPress: () => {
            autoOff = !autoOff;
            // Raised after the hook frame ended: if the engine refuses, the next applied listing redraws.
            try {
              $.ui.invalidate("ui.render");
            } catch {
              bandStale = true;
            }
          },
        }),
        ...cache,
      ],
    });
  });

  // Bumped at every main-loop turn.complete: the turn an agent type was last offered in (Jev's agent-switch options).
  let agentTurn = 0;
  // Phase 3: when Claude starts a general-purpose subagent, Jev may pick a more specialised agent type.
  if (options.agentTypes !== false) {
    // Agent types as the engine offers them to the model, with their descriptions and the main-loop turn of the offer.
    const offered = new Map<string, { description: string; turn: number }>();

    on("agent.offer", async function onAgentOffer($: Engine, e: OfferEvent, next: Next<OfferEvent, unknown>): Promise<unknown> {
      if ((await jevMissing($)).length) return next(e);
      const r = await next(e);
      // Only types the model is really offered are Jev's options: a hook beneath may withhold one, and its dispatch is then refused.
      if ((r as { isOffered?: boolean } | undefined)?.isOffered === false) offered.delete(e.agent);
      else offered.set(e.agent, { description: e.description, turn: agentTurn });
      return r;
    });

    on("tool.call", { tool: "Agent" }, async function onAgentCall($: Engine, e: AgentCall, next: Next<AgentCall, ToolResult>): Promise<ToolResult> {
      if ((await jevMissing($)).length) return next(e);
      const claudeType = e.subagent_type ?? "";
      // The engine offers its whole agent listing anew every turn: a type missing from the latest listing is gone
      // (its plugin unloaded, its agent file removed) and must not become a switch target.
      const latest = Math.max(...[...offered.values()].map((o) => o.turn));
      for (const [name, o] of offered) if (o.turn < latest) offered.delete(name);
      // A specific type is never switched, so asking would only cost latency.
      if (offered.size < 2 || !GENERAL.has(claudeType)) return next(e);

      const criteria: Record<string, string> = {};
      // shortcut: past jev-api's choice limit later-offered agent types are left out; rank them if users hit it.
      for (const [name, o] of [...offered].slice(0, MAX_CHOICE_OPTIONS)) criteria[name] = clip(o.description, 200);
      const r = await askJev(
        $,
        { task: clip(e.prompt, 3000), description: e.description },
        { agent_type: { type: "choice", instructions: "Which agent type is best suited to carry out `task`?", criteria } },
      );
      if (!r.ok) return next(e);
      const answer = choice(r.answers, "agent_type");
      if (!answer) return next(e);
      const p = answer.probabilities[answer.choice] ?? 0;
      // Only to a type Jev was offered: an answer outside `criteria` may name one that is gone.
      const canSwitch = !GENERAL.has(answer.choice) && Object.hasOwn(criteria, answer.choice) && p >= SWITCH_AT;
      return canSwitch ? next({ ...e, subagent_type: answer.choice }) : next(e);
    });
  }

  /**
   * Compaction: Jev ranks the recent tool results (the summarizer is told what to keep), then Haiku 5.5 writes the
   * summary (a fraction of the chat model's price); any failure falls through to Claude Code's own compaction. Works
   * without jev-api: only the ranking needs Jev.
   */
  on("session.compact", async function onCompact($: Engine, e: CompactEvent, next: Next<CompactEvent, unknown>): Promise<unknown> {
    if (e.agentId) return next(e);
    const ranked = jevRanking ? await withJevRanking($, e) : e;
    // The rest of the chain (Claude Code's own compaction). Whoever writes the summary, the next request rewrites the
    // whole cache, so the countdown restarts at the next response: but only once a compaction stands, not for a
    // precompute (it installs nothing) nor one that a hook beneath vetoes.
    const passOn = async (): Promise<unknown> => {
      const r = await next(ranked);
      if (e.trigger !== "precompute" && (r as { skip?: unknown } | undefined)?.skip === undefined) {
        cacheExpires = 0;
        compactQueued = false;
      }
      return r;
    };
    if (!haikuCompact) return passOn();
    // A summary computed ahead of time would be written by the chat's model and then not used.
    if (e.trigger === "precompute") return { skip: "jevfort compacts with Haiku when it is time" };
    const transcript = haikuTranscript(ranked.messages);
    if (transcript === undefined) return passOn();
    const focus = ranked.instructions?.trim();
    const r = await $.model.complete({
      model: COMPACT_MODEL,
      system: COMPACT_SYSTEM,
      prompt: `${transcript}\n\n---\nWrite the summary now.${focus ? `\nThe summary should keep or stress: ${focus}` : ""}`,
      maxTokens: COMPACT_MAX_TOKENS,
      timeoutMs: 240_000,
    }).catch((err: unknown): Completion => ({ isAnswered: false, reason: String(err).slice(0, 80) }));
    const text = r.isAnswered ? r.text.trim() : "";
    // A usable summary: shorter ones are an empty reply, one that used all its tokens was cut off.
    const written = text.length > 200 && r.isAnswered && r.usage.output_tokens < COMPACT_MAX_TOKENS;
    if (!written) return passOn();
    cacheExpires = 0;
    compactQueued = false;
    return {
      messages: [{
        role: "user" as const,
        text: `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation, written by Haiku 5.5 for jevfort.\n\n${text}\n\nContinue the conversation from where it left off without asking the user any further questions.`,
        toolUses: [],
      }],
    };
  });

  // Per-turn state: the effort sent on every step of the turn, Jev's takes, the bypass and the
  // stat results of mentioned paths (dropped with the turn, so a file created later is offered in the next turn).
  const turns = new Map<string, { effort?: Effort; taken: number; bypassId?: string; bypassAction?: string; cache: TurnCache }>();
  // What each loop's first turn (key `agentId`, `""` for the main loop) saw and estimated: the session model's family,
  // the session effort (`from`) and the estimate (unset when none was made or Jev failed). Drives the Haiku/Fable hold.
  const firstTurns = new Map<string, { family?: EstimateModel; from: unknown; effort?: Effort }>();
  // Calls Jev made itself: `tool.check` approves them, their commands come from a vetted list.
  const ownCalls = new Set<string>();
  // The scratchpad lookups, resolved once per conversation: /clear and an in-process /resume give the session a new id
  // and with it a new scratchpad directory.
  let scratchpad: { roots: string[]; sid: string } | undefined;
  /** Forgets what belongs to one conversation: its first-turn estimates, the band, the Auto switch, and the scratchpad lookups. */
  const forgetConversation = (): void => {
    firstTurns.clear();
    band = {};
    autoOff = false;
    scratchpad = undefined;
  };
  on("session.start", async function onSessionStart($: Engine, e: unknown, next: Next<unknown, unknown>): Promise<unknown> {
    // A new session (a start, a reload) gets its own first-turn estimate, an empty band, Auto on and a fresh cache
    // countdown; session.end does the same for /clear and /resume, where no session.start follows.
    forgetConversation();
    resetCache($);
    // Until the baseline below, a listing raised beneath `next(e)` (before jev-api registered) applies nothing.
    jevState = undefined;
    estimateRegistered = false;
    bandStale = false;
    // The cache tick's timer lives here: one started inside a request ends with it.
    cacheTimer?.cancel();
    cacheTimer = $.clock.every(CACHE_TICK_MS, () => void cacheTick($, autoCompactPercent).catch(() => undefined));
    // After `next(e)`: jev-api registers its tools in its own session.start, which may run beneath this hook.
    const result = await next(e);
    // The session's baseline, listed only now: a jevfort hook raised inside `next(e)` (another plugin's session.start
    // making a tool call) may have cached a listing from before jev-api registered. Registers estimate_effort when ready.
    dropTurnReads();
    await jevApply($, await jevMissing($));
    // MCP servers may still be connecting: the first step 0 lists the deferred tools itself.
    toolListing = undefined;
    return result;
  });

  /**
   * /clear and an in-process /resume end a conversation without a session.start for the next one: its countdown,
   * first-turn estimates, band and Auto switch end here.
   */
  on("session.end", async function onSessionEnd($: Engine, e: unknown, next: Next<unknown, unknown>): Promise<unknown> {
    forgetConversation();
    resetCache($);
    return next(e);
  });

  on("turn.complete", async function onTurnComplete($: Engine, e: TurnEnd, next: Next<TurnEnd, unknown>): Promise<unknown> {
    if (e.agentId === undefined) {
      turnRunning = false;
      agentTurn += 1;
    }
    const missing = await jevMissing($);
    // No engine event reports a changed tool list: the next main-loop turn's first hook lists the jev-api tools again
    // (a subagent's completion does not drop it, so a mid-turn listing glitch cannot flap the band).
    if (e.agentId === undefined) dropTurnReads();
    if (missing.length) {
      await contextCompact($, e, false, taskCompactPercent, forceCompactPercent).catch(() => undefined);
      return next(e);
    }
    turns.delete(e.turnId);
    await contextCompact($, e, true, taskCompactPercent, forceCompactPercent).catch(() => undefined);
    // The compaction check above may have read the env: drop it again so the next turn reads the settings `env` afresh.
    if (e.agentId === undefined) haikuPath = undefined;
    return next(e);
  });

  // Answers the estimate_effort tool itself, before the readiness guard (never `next(e)`: a registered tool no hook
  // answers fails, and the tool stays registered after jev-api goes away), and blocklists a skill whose call Jev made
  // itself failed.
  on("tool.call", async function onToolCall($: Engine, e: ToolCall, next: Next<ToolCall, ToolResult>): Promise<ToolResult> {
    if (e.tool === ESTIMATE_TOOL) {
      const input = parseEstimateInput(e);
      if (typeof input === "string") return { deny: `estimate_effort: ${input}` }; // a hook's own isError never reaches the model (live, 2.1.325); a deny does, as an error
      const r = await askJev($, { request: clip(input.prompt, 4000) }, { effort: effortQuestion, mechanical: mechanicalQuestion });
      const effortAnswer = r.ok ? score(r.answers, "effort") : undefined;
      const est = estimateEffort(effortAnswer, r.ok ? noul(r.answers, "mechanical") : undefined, input);
      return { result: JSON.stringify(est) };
    }
    if ((await jevMissing($)).length) return next(e);
    const result = await next(e);
    if (e.tool_use_id && ownCalls.has(e.tool_use_id)) {
      const isError = result.deny !== undefined || result.isError === true;
      ownCalls.delete(e.tool_use_id);
      // A skill the Skill tool refused is never offered to Jev again.
      const skill = e.skill;
      if (isError && e.tool === "Skill" && typeof skill === "string") await blockSkill($, skill);
    }
    return result;
  });

  // Each model request: Jev may take the step itself, and at step 0 estimates the turn's effort (every turn on
  // Opus/Sonnet, the loop's first turn only on Haiku/Fable, which then hold it). One Jev request carries all of it.
  on("turn.step", async function* onTurnStep($: Engine, e: Step, rawNext: (e: Step) => StepRun): StepRun {
    // Every main-loop response restarts the cache countdown (the work is jev-api independent).
    if (e.agentId === undefined) turnRunning = true;
    const next = (request: Step): StepRun => cacheWatch($, e, rawNext(request));
    if ((await jevMissing($)).length) return yield* next(e);
    if (e.agentId && !subagents) return yield* next(e);

    const turn = turns.get(e.turnId) ?? { taken: 0, cache: newCache() };
    turns.set(e.turnId, turn);

    // A new main-loop turn: the session effort bold, the last turn's choice cleared (also for a turn without a request).
    if (routing && e.index === 0 && !e.agentId) {
      band = isEffort(e.effort) ? { configured: e.effort } : {};
      $.ui.invalidate("ui.render");
    }

    // One transcript read per step: the turn and, at main-loop step 0, the previous reply.
    const messages = await $.session.messages(e.agentId ? { agentId: e.agentId } : {});
    const ctx = turnOf(messages);
    if (!ctx) return yield* next(e);
    const calls = toolCalls(ctx.steps);
    const last = calls.at(-1);

    // Whole-turn bypass: Jev took the one action this simple request needs; a small model reports its result and
    // Claude is not asked at all.
    if (turn.bypassId && e.index > 0) {
      const id = turn.bypassId;
      turn.bypassId = undefined;
      const done = calls.find((c) => c.tool_use_id === id);
      if (done?.text !== undefined && !(done.isError && REFUSED.test(done.text))) {
        const s = await summarizeResult($, ctx.request, turn.bypassAction ?? done.tool, done.text);
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
    // Not on a slash-command turn: its skill text is not in the transcript, so Jev (and the Haiku summary) would answer the bare command and the skill never runs.
    if (takeSteps && !ctx.command && turn.taken < MAX_TAKES_PER_TURN && (!takeOnlyForBypass || (bypass && e.index === 0 && !e.agentId))) {
      candidates = (await buildCandidates($, ctx.request, ctx.steps, calls, e.index, turn.cache)).filter((c) => !(last && sameCall(last, { tool: c.tool, input: c.input })));
      if (candidates.length) questions.next_action = nextActionQuestion(candidates);
    }
    // Step 0: the effort estimate, or a Haiku/Fable turn's held first-turn estimate.
    let estimate: EstimateBounds | undefined;
    let firstTurn: { family?: EstimateModel; from: unknown; effort?: Effort } | undefined;
    if (routing && e.index === 0) {
      const sessionEffort = isEffort(e.effort) ? e.effort : undefined;
      // Auto off (the band's button): no first-turn record, no estimate, no hold; the turn runs at the session effort.
      if (!autoOff) {
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
        estimate = family && sessionEffort && (fresh || EVERY_TURN_MODELS.includes(family)) ? { model: family, defaultEffort: sessionEffort, ...effortRange } : undefined;
        if (estimate) {
          questions.effort = effortQuestion;
          questions.mechanical = mechanicalQuestion;
        }
        // Haiku/Fable after the first turn: hold the first turn's estimate while model and session effort are unchanged.
        const held = !estimate && first?.effort && first.family === family && first.from === e.effort ? first.effort : undefined;
        if (held && held !== e.effort) turn.effort = held;
        if (held) debugEffort($, e, "held", held);
        if (held && !e.agentId) {
          band.chosen = held;
          $.ui.invalidate("ui.render");
        }
      }
    }
    if (bypass && e.index === 0 && questions.next_action && !e.agentId) questions.single_action = singleActionQuestion;
    // The turn's effort, set at step 0, holds for every step of the turn.
    const routed = (step: Step): Step => (turn.effort ? { ...step, effort: turn.effort } : step);

    if (!Object.keys(questions).length) return yield* next(routed(e));

    // A short follow-up ("yes", "do it") is only rated with confidence when Jev sees what it answers: 0.0–0.2
    // without, 0.5–0.8 with.
    const previous = e.index === 0 && !e.agentId ? previousReply(messages) : undefined;
    const state = {
      request: clip(ctx.request, 4000),
      ...(previous ? { previous_reply: previous } : {}),
      recent: summarize(ctx.steps),
      cwd: turn.cache.cwd ??= await $.session.cwd(),
    };
    const r = await askJev($, state, questions);
    if (!r.ok) {
      if (estimate) debugEffort($, e, `jev unavailable (${r.error})`, undefined);
      return yield* next(routed(e));
    }

    if (estimate) {
      const mechanical = noul(r.answers, "mechanical");
      const effortAnswer = score(r.answers, "effort");
      const est = estimateEffort(effortAnswer, mechanical, estimate);
      turn.effort = est.effort !== e.effort ? est.effort : undefined;
      if (firstTurn) firstTurn.effort = est.effort;
      debugEffort($, e, `${est.source}${effortAnswer ? ` (score ${effortAnswer.score.toFixed(2)})` : ""}`, est.effort);
      if (!e.agentId) {
        band.chosen = est.effort;
        $.ui.invalidate("ui.render");
      }
    }

    const answer = choice(r.answers, "next_action");
    const singleAction = noul(r.answers, "single_action") ?? 0;
    const picked = pickCandidate(answer, candidates, takeThreshold);
    // takeOnlyForBypass: only a read-only Read or Bash that is the whole prompt; a skill or tool load run by Jev would end the turn on a summary of "Launching skill".
    const pick = takeOnlyForBypass && (singleAction < SINGLE_ACTION || (picked?.tool !== "Read" && picked?.tool !== "Bash")) ? undefined : picked;

    if (pick) {
      turn.taken += 1;
      const id = `toolu_jev_${crypto.randomUUID().replace(/-/g, "")}`;
      ownCalls.add(id);
      if (singleAction >= SINGLE_ACTION && (pick.tool === "Read" || pick.tool === "Bash")) {
        turn.bypassId = id;
        turn.bypassAction = pick.key;
      }
      yield { kind: "tool", index: 0, id, name: pick.tool };
      yield { kind: "input", index: 0, json: JSON.stringify(pick.input) };
      yield { kind: "stop", stopReason: "tool_use", usage: null };
      return { turnId: e.turnId, index: e.index, answer: "", toolUses: [{ name: pick.tool, input: pick.input }], stopReason: "tool_use", usage: null };
    }

    return yield* next(routed(e));
  });

  // Permission check: approves Jev's own vetted calls and writes into this session's scratchpad; every other verdict stays Claude Code's.
  on("tool.check", async function onToolCheck($: Engine, e: Check, next: Next<Check, Verdict>): Promise<Verdict> {
    // The estimate tool is answered by the tool.call hook, also while inactive, so there is nothing to prompt for. A settings deny or ask rule
    // still wins; an existing allow is returned unchanged (rewording it makes the security plugin warn the user).
    if (e.tool === ESTIMATE_TOOL) {
      const base = await next(e);
      return settled(base) ? base : { ...base, decision: "allow", reason: "jevfort: estimate_effort is answered locally" };
    }
    if ((await jevMissing($)).length) return next(e);
    const base = await next(e);
    // Jev's own calls come from the vetted candidate list: approve them so auto mode's classifier doesn't refuse
    // them. This and the scratchpad branch are the only places jevfort loosens Claude Code's verdict. A settings deny or ask rule still wins.
    if (e.tool_use_id && ownCalls.has(e.tool_use_id)) {
      // Claude Code already allows in-project reads: its ask on a Read means the path resolves outside the working directories.
      if (settled(base) || e.tool === "Read") return base;
      return { ...base, decision: "allow", reason: "Jev pilot: vetted action from its read-only/project-script list" };
    }
    const input = (e.input ?? {}) as Record<string, unknown>;
    // Writes into this session's scratchpad are allowed in every permission mode.
    // A mode's ask becomes allow; a settings deny or ask rule (`rule` set) still wins.
    if (WRITE_TOOLS.has(e.tool) && !settled(base)) {
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
