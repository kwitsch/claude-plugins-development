// Shared test kit of jevfort: the fake environment, Jev's batch tool and the stubs beneath the mod, bound to the built
// plugin/hooks/register.mjs. Tests import only register.mjs through this module (the standard of jev-api).
import { createKit } from "claude-engine-vitest";
import type { On } from "claude-engine-vitest";

export const DEFAULTS = {
  routing: true,
  takeSteps: true,
  takeThreshold: 0.85,
  subagents: true,
  bypass: true,
  agentTypes: true,
  compaction: true,
  takeOnlyForBypass: true,
  minEffort: "low",
  maxEffort: "xhigh",
};


/** The kit's mock helpers, as createKit returns them. */
export type MockKit = ReturnType<typeof createKit>["mock"];

/**
 * A kit bound to the built register.mjs with the given userConfig options.
 *
 * @param options - The manifest defaults of the test.
 * @returns The kit's test and mock, and setup bound to that mock.
 */
export function makeKit(options: Record<string, unknown> = DEFAULTS) {
  const kit = createKit({ module: new URL("../../plugin/hooks/register.mjs", import.meta.url), plugin: "jevfort", options });
  return { ...kit, setup: (on: On, opts: SetupOpts) => setupWith(kit.mock, on, opts) };
}

export const CWD = "/proj";
export const SID = "sid-1";
/** The jev-api tool jevfort needs, as `$.tool.list()` lists it. */
/** jev-api's batch tool, the name jevfort asks Jev through. */
const JEV_BATCH = "mcp__jev-api__batch";
const JEV_TOOL_PREFIX = "mcp__jev-api__";

/**
 * The id of a batch question by its instructions (the start of each question jevfort asks).
 *
 * @param instructions - The question's instructions text.
 * @returns The id, or undefined for a question this kit does not know.
 */
export function questionId(instructions: string): string | undefined {
  const starts: [string, string][] = [
    ["An AI coding assistant is working on the user request in `request`", "next_action"],
    ["Can the user request in `request` be fully answered", "single_action"],
    ["How much reasoning effort does a mid-tier AI coding model", "effort"],
    ["Is the user request in `request` a purely mechanical task", "mechanical"],
    ["An AI coding assistant just ended a turn.", "end"],
  ];
  return starts.find(([start]) => instructions.startsWith(start))?.[1];
}

export const JEV_TOOLS = [{ name: JEV_BATCH, description: "Ask Jev several questions", mcp: true }];
/** jev-api 0.1's tools, which lack the batch tool. */
export const SINGLE_TOOLS = ["noul", "choice", "score"].map((t) => ({ name: JEV_TOOL_PREFIX + t, description: `Ask Jev a ${t} question`, mcp: true }));
/** What the fake answers a question the test's `jev` leaves open, by type: not true, leave it to Claude, an unconfident score. */
export const NEUTRAL: Record<string, Record<string, unknown>> = {
  noul: { type: "noul", noul: 0 },
  choice: { type: "choice", choice: "claude", probabilities: { claude: 1 }, confidence: 1 },
  score: { type: "score", score: 0, probabilities: {}, confidence: 0 },
};

/** One question of a batch call as the fake saw it: its id (its instructions when unknown), its input, the call's `state` (JSON text) and the call's index (0 for the first batch call). */
export type Asked = { id: string; type: string; instructions: string; state: string; criteria?: unknown; timeout?: unknown; call: number };
/** The fake Jev, called once per batch question: the answer object, a raw result string (the whole batch result), a number (an HTTP error status: the batch denies), `undefined` (a neutral answer), or a Promise that never settles (no answer). */
export type Jev = (q: Asked) => Record<string, unknown> | string | number | undefined | Promise<never>;
export type Msg = { role: "user" | "assistant"; text: string; toolUses: Record<string, unknown>[]; toolResults?: Record<string, unknown>[] };
export type Chunk = { kind: string; [k: string]: unknown };
/** The test's `$` (the kit does not export its type): `$.<ns>.<event>` fires an event. */
export type Runner = Parameters<Parameters<ReturnType<typeof makeKit>["test"]>[2]>[0];
/** The options of `setup`: the messages, Jev's answers and what the environment holds. */
export type SetupOpts = { messages: Msg[]; jev: Jev; cwd?: () => string; files?: string[]; links?: string[]; packageJson?: object | string; makefile?: string; env?: Record<string, string>; store?: Record<string, unknown>; existsDenied?: boolean; locks?: string[]; sizes?: Record<string, number>; tools?: { name: string; description: string; mcp: boolean }[] | null };

// Answers every call the mod makes on `$`. The batch tool is listed and answered from `jev`; a mod's `$.tool.call`
// resolves to the stub's `value`: the tool result `{ result }`, or `{ deny }` as the real engine resolves a deny (a bare
// `{ deny }` stub answer would make the kit reject instead). Other tools go on to the test's own `tool.call` stub.
export function setupWith(mock: MockKit, on: On, opts: SetupOpts) {
  const sent: Asked[] = [];
  let batchCalls = 0;
  let reads = 0;
  const statted: string[] = [];
  mock.env(on, opts.env ?? {});
  mock.store(on, opts.store ?? {});
  const clock = mock.clock(on);
  on("session.messages", () => {
    reads++;
    return { value: [...opts.messages] };
  });
  on("session.cwd", () => ({ value: opts.cwd?.() ?? CWD }));
  on("session.id", () => ({ value: SID }));
  // `existsDenied` refuses every `fs.exists` probe, as a hook above or the engine may; `locks` are the project's lock files.
  on("fs.exists", (_$, e) => (opts.existsDenied ? { deny: "EACCES" } : { value: (Boolean(opts.packageJson) && e.path === `${CWD}/package.json`) || (opts.locks ?? []).some((f) => e.path === `${CWD}/${f}`) }));
  on("fs.stat", (_$, e) => {
    statted.push(String(e.path));
    const isLink = (opts.links ?? []).includes(String(e.path));
    return isLink || (opts.files ?? []).includes(String(e.path)) ? { value: { kind: "file", size: opts.sizes?.[String(e.path)] ?? 100, mtimeMs: 0, isLink } } : { deny: "ENOENT" };
  });
  on("fs.read", (_$, e) => {
    if (opts.makefile !== undefined && e.path === `${CWD}/Makefile`) return { value: opts.makefile };
    return opts.packageJson && e.path === `${CWD}/package.json` ? { value: typeof opts.packageJson === "string" ? opts.packageJson : JSON.stringify(opts.packageJson) } : { deny: "ENOENT" };
  });
  on("ui.status", () => ({ value: undefined }));
  // `tools: null` makes the listing fail.
  on("tool.list", () => (opts.tools === null ? { deny: "tool.list failed" } : { value: opts.tools ?? JEV_TOOLS }));
  on("tool.call", async (_$, e, next) => {
    if (e.tool !== JEV_BATCH) return next(e);
    // As the engine: a tool that is not listed is unknown, so the mod's call rejects (a bare `{ deny }`).
    if (opts.tools === null || (opts.tools !== undefined && !opts.tools.some((t) => t.name === JEV_BATCH))) return { deny: `unknown tool ${JEV_BATCH}` };
    const call = batchCalls++;
    const asked = (e.questions as { type: string; instructions: string; criteria?: unknown }[]).map((b): Asked => ({ ...b, id: questionId(b.instructions) ?? b.instructions, state: String(e.state), timeout: e.timeout, call }));
    sent.push(...asked);
    const answers = await Promise.all(asked.map(async (q) => opts.jev(q)));
    // `{ __deny: text }` makes the batch deny with that text (an error body of any size).
    const denied = answers.find((a) => typeof a === "object" && a !== null && "__deny" in a) as { __deny: string } | undefined;
    if (denied) return { value: { deny: denied.__deny } };
    const status = answers.find((a) => typeof a === "number");
    if (status !== undefined) return { value: { deny: `batch: HTTP ${status}` } };
    const raw = answers.find((a) => typeof a === "string");
    return { value: { result: raw ?? JSON.stringify(answers.map((a, i) => a ?? NEUTRAL[asked[i].type])) } };
  });
  return { sent, clock, statted, calls: () => batchCalls, reads: () => reads };
}

// Stubs beneath the mod: the turn's end, and the prompts submitted through it (their texts).
export function followUps(on: On) {
  const submitted: string[] = [];
  on("turn.complete", () => ({ text: "" }));
  on("prompt.submit", (_$, e) => {
    submitted.push(String(e.text));
    return { value: {} };
  });
  return submitted;
}

// A main-loop `turn.complete` that ended with an answer; `extra` adds or overrides fields (an `agentId`).
export const answered = (turnId: string, answer: string, extra: Record<string, unknown> = {}) => ({ turnId, reason: "answer", answer, durationMs: 1, isAborted: false, ...extra });

export const user = (text: string): Msg => ({ role: "user", text, toolUses: [] });

export const step = { turnId: "t1", index: 0, model: "claude-opus-5-5", effort: "high", messageCount: 1 };

export const easy = { type: "score", score: 0.2, probabilities: { "0": 0.85, "1": 0.1, "2": 0.05, "3": 0 }, confidence: 0.8 };

// A Jev score answer; a mechanical (noul) answer.
export const scored = (score: number, confidence = 0.9) => ({ type: "score", score, probabilities: {}, confidence });
export const mech = (p: number) => ({ type: "noul", noul: p });
/**
 * A fake Jev answering by question id; a question not listed gets the neutral answer.
 *
 * @param answers - The answers by question id.
 * @returns The fake.
 */
export const byId = (answers: Record<string, Record<string, unknown>>): Jev => (q) => answers[q.id];
/**
 * The ids of the questions asked so far, in call order.
 *
 * @param sent - The questions the fake saw.
 * @returns Their ids.
 */
export const ids = (sent: Asked[]) => sent.map((q) => q.id);
/**
 * The parsed `state` of the i-th question asked.
 *
 * @param sent - The questions the fake saw.
 * @param i - The question's index in `sent`.
 * @returns The state object.
 */
export const stateOf = (sent: Asked[], i: number) => JSON.parse(sent[i].state) as { request: string; previous_reply?: string };
/**
 * A fake Jev answering by question id, one answer set per batch call (one `askJev`) in call order.
 *
 * @param rounds - One answer set per call, by question id; the last repeats, and a number is an HTTP error status for
 * that whole call.
 * @returns The fake.
 */
export const inOrder = (...rounds: (Record<string, Record<string, unknown>> | number)[]): Jev => (q) => {
  const round = rounds[Math.min(q.call, rounds.length - 1)];
  return typeof round === "number" ? round : round[q.id];
};

export async function drain(stream: AsyncGenerator<unknown, unknown>) {
  const chunks: Chunk[] = [];
  for (;;) {
    const n = await stream.next();
    if (n.done) return { chunks, result: n.value };
    chunks.push(n.value as Chunk);
  }
}

export function claudeBeneath(on: On, seen: unknown[]) {
  on("turn.step", async function*(_$, e) {
    seen.push(e);
    yield { kind: "text", index: 0, text: "from claude" };
    yield { kind: "stop", stopReason: "end_turn", usage: null };
    return { turnId: e.turnId, index: e.index, answer: "from claude", toolUses: [], stopReason: "end_turn", usage: null };
  });
}

export const toolId = (chunks: Chunk[]) => (chunks.find((c) => c.kind === "tool")?.id as string | undefined) ?? "";

export const decision = async ($: Runner, input: Record<string, unknown>) => ((await $.tool.check(input)) as { decision?: string }).decision;

/** The `session.start` input of every test that starts a session. */
export const START = { cwd: CWD, surface: "terminal", isInteractive: true };

/**
 * The stubs `session.start` needs beneath jevfort: `estimate_effort` registration, the event's end.
 *
 * @param on - The test's `on`.
 * @returns The names passed to `$.tool.register`, in call order.
 */
export function sessionStubs(on: On) {
  const registered: unknown[] = [];
  on("tool.register", async (_$, e) => {
    registered.push(e.name);
    return { value: { tool: "mcp__jevfort__estimate_effort" } };
  });
  on("session.start", async () => ({}));
  return registered;
}

/** The band above the prompt as the terminal raises it (`ui.render`, component `AbovePrompt`). */
export const BAND = { plugin: "jevfort", component: "AbovePrompt", props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80 }, surface: "terminal" };
/** What a hook beneath jevfort draws in the band: seen when jevfort passes. */
export const BENEATH = { type: "Text", props: {}, children: ["beneath"] };
/** The part of a mounted site the band helpers read. */
export type Site = { find(q: { type?: string; text?: string | RegExp; key?: string }): Promise<{ props: Record<string, unknown> } | undefined> };
/**
 * The props of the band's Text for one effort level.
 *
 * @param ui - The mounted band.
 * @param level - The effort level.
 * @returns Its props (`bold`, `color`, `dimColor`), or `undefined` when not drawn.
 */
export const levelProps = async (ui: Site, level: string) => (await ui.find({ type: "Text", text: new RegExp(`^${level} $`) }))?.props;
/**
 * The label of the band's Auto button.
 *
 * @param ui - The mounted band.
 * @returns The label, or `undefined` when not drawn.
 */
export const autoLabel = async (ui: Site) => (await ui.find({ type: "Button", key: "auto" }))?.props.label;
