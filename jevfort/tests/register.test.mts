// Hook-wiring tests for the built plugin/hooks/register.mjs: a port of upstream jev-pilot's tests/pilot.test.ts onto
// claude-engine-vitest (types dropped, `expect` from vitest, `test`/`mock` from createKit). Upstream's "shadow mode
// logs a take but lets Claude act" is gone with the mode; its shadow compare test runs on the measure path instead.
// Jev is the jev-api plugin's batch tool: a fake `tool.call` answers `mcp__jev-api__batch` question by question.
import { createKit } from "claude-engine-vitest";
import type { On } from "claude-engine-vitest";
import { expect } from "vitest";
import { JEV_BATCH, JEV_TOOL_PREFIX } from "../plugin/hooks/jev.mjs";
import { difficultyQuestion, doneQuestion, effortQuestion, mechanicalQuestion, nextActionQuestion, singleActionQuestion, taskEndQuestion } from "../plugin/hooks/policy.mjs";

// The manifest defaults (jevfort/package.json claudePlugin.userConfig): the kit does not fill userConfig defaults.
const DEFAULTS = {
  routing: "effort",
  takeSteps: true,
  doneCheck: true,
  takeThreshold: 0.85,
  subagents: true,
  doneThreshold: 0.15,
  bypass: true,
  classify: true,
  agentTypes: true,
  compaction: true,
  takeOnlyForBypass: true,
  measureSteps: true,
  minEffort: "low",
  maxEffort: "xhigh",
};

const { test, mock } = createKit({ module: new URL("../plugin/hooks/register.mjs", import.meta.url), plugin: "jevfort", options: DEFAULTS });

const CWD = "/proj";
const SID = "sid-1";
/** The jev-api tool jevfort needs, as `$.tool.list()` lists it. */
const JEV_TOOLS = [{ name: JEV_BATCH, description: "Ask Jev several questions", mcp: true }];
/** jev-api 0.1's tools, which lack the batch tool. */
const SINGLE_TOOLS = ["noul", "choice", "score"].map((t) => ({ name: JEV_TOOL_PREFIX + t, description: `Ask Jev a ${t} question`, mcp: true }));
/** The first line of /jev while the batch tool is missing. */
const INACTIVE = "Jev pilot: inactive, the jev-api tools are missing (mcp__jev-api__batch). jevfort needs jev-api 0.2.0 or later and no permissions.deny rule matching its tools; it looks again at the next turn.";
/** The question id each instructions text belongs to (batch questions carry no id; the fake finds it by the text). */
const QUESTION_IDS = new Map<string, string>([
  [nextActionQuestion([]).instructions, "next_action"],
  [singleActionQuestion.instructions, "single_action"],
  [difficultyQuestion.instructions, "difficulty"],
  [effortQuestion.instructions, "effort"],
  [mechanicalQuestion.instructions, "mechanical"],
  [doneQuestion.instructions, "done"],
  [taskEndQuestion.instructions, "end"],
]);
/** What the fake answers a question the test's `jev` leaves open, by type: not true, leave it to Claude, an unconfident score. */
const NEUTRAL: Record<string, Record<string, unknown>> = {
  noul: { type: "noul", noul: 0 },
  choice: { type: "choice", choice: "claude", probabilities: { claude: 1 }, confidence: 1 },
  score: { type: "score", score: 0, probabilities: {}, confidence: 0 },
};

/** One question of a batch call as the fake saw it: its id (its instructions when unknown), its input, the call's `state` (JSON text) and the call's index (0 for the first batch call). */
type Asked = { id: string; type: string; instructions: string; state: string; criteria?: unknown; timeout?: unknown; call: number };
/** The fake Jev, called once per batch question: the answer object, a raw result string (the whole batch result), a number (an HTTP error status: the batch denies), `undefined` (a neutral answer), or a Promise that never settles (no answer). */
type Jev = (q: Asked) => Record<string, unknown> | string | number | undefined | Promise<never>;
type Msg = { role: "user" | "assistant"; text: string; toolUses: Record<string, unknown>[]; toolResults?: Record<string, unknown>[] };
type Chunk = { kind: string; [k: string]: unknown };
/** The test's `$` (the kit does not export its type): `$.<ns>.<event>` fires an event. */
type Runner = Parameters<Parameters<typeof test>[2]>[0];

// Answers every call the mod makes on `$`. The batch tool is listed and answered from `jev`; a mod's `$.tool.call`
// resolves to the stub's `value`: the tool result `{ result }`, or `{ deny }` as the real engine resolves a deny (a bare
// `{ deny }` stub answer would make the kit reject instead). Other tools go on to the test's own `tool.call` stub.
function setup(on: On, opts: { messages: Msg[]; jev: Jev; cwd?: () => string; files?: string[]; links?: string[]; packageJson?: object; env?: Record<string, string>; agents?: { status: string }[]; store?: Record<string, unknown>; tools?: { name: string; description: string; mcp: boolean }[] | null }) {
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
  on("fs.exists", (_$, e) => ({ value: Boolean(opts.packageJson) && e.path === `${CWD}/package.json` }));
  on("fs.stat", (_$, e) => {
    statted.push(String(e.path));
    const isLink = (opts.links ?? []).includes(String(e.path));
    return isLink || (opts.files ?? []).includes(String(e.path)) ? { value: { kind: "file", size: 100, mtimeMs: 0, isLink } } : { deny: "ENOENT" };
  });
  on("fs.read", (_$, e) => (opts.packageJson && e.path === `${CWD}/package.json` ? { value: JSON.stringify(opts.packageJson) } : { deny: "ENOENT" }));
  on("ui.status", () => ({ value: undefined }));
  on("agent.list", () => ({ value: opts.agents ?? [] }));
  // `tools: null` makes the listing fail.
  on("tool.list", () => (opts.tools === null ? { deny: "tool.list failed" } : { value: opts.tools ?? JEV_TOOLS }));
  on("tool.call", async (_$, e, next) => {
    if (e.tool !== JEV_BATCH) return next(e);
    // As the engine: a tool that is not listed is unknown, so the mod's call rejects (a bare `{ deny }`).
    if (opts.tools === null || (opts.tools !== undefined && !opts.tools.some((t) => t.name === JEV_BATCH))) return { deny: `unknown tool ${JEV_BATCH}` };
    const call = batchCalls++;
    const asked = (e.questions as { type: string; instructions: string; criteria?: unknown }[]).map((b): Asked => ({ ...b, id: QUESTION_IDS.get(b.instructions) ?? b.instructions, state: String(e.state), timeout: e.timeout, call }));
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

// Stubs beneath the done check: the turn's end, and the follow-up messages the mod submits (their texts).
function followUps(on: On) {
  const submitted: string[] = [];
  on("turn.complete", () => ({ text: "" }));
  on("prompt.submit", (_$, e) => {
    submitted.push(String(e.text));
    return { value: {} };
  });
  return submitted;
}

// A main-loop `turn.complete` that ended with an answer; `extra` adds or overrides fields (an `agentId`).
const answered = (turnId: string, answer: string, extra: Record<string, unknown> = {}) => ({ turnId, reason: "answer", answer, durationMs: 1, isAborted: false, ...extra });

const user = (text: string): Msg => ({ role: "user", text, toolUses: [] });

const step = { turnId: "t1", index: 0, model: "claude-opus-5-5", effort: "high", messageCount: 1 };

const easy = { type: "score", score: 0.2, probabilities: { "0": 0.85, "1": 0.1, "2": 0.05, "3": 0 }, confidence: 0.8 };

// A Jev score answer; a mechanical (noul) answer.
const scored = (score: number, confidence = 0.9) => ({ type: "score", score, probabilities: {}, confidence });
const mech = (p: number) => ({ type: "noul", noul: p });
/**
 * A fake Jev answering by question id; a question not listed gets the neutral answer.
 *
 * @param answers - The answers by question id.
 * @returns The fake.
 */
const byId = (answers: Record<string, Record<string, unknown>>): Jev => (q) => answers[q.id];
/**
 * The ids of the questions asked so far, in call order.
 *
 * @param sent - The questions the fake saw.
 * @returns Their ids.
 */
const ids = (sent: Asked[]) => sent.map((q) => q.id);
/**
 * The parsed `state` of the i-th question asked.
 *
 * @param sent - The questions the fake saw.
 * @param i - The question's index in `sent`.
 * @returns The state object.
 */
const stateOf = (sent: Asked[], i: number) => JSON.parse(sent[i].state) as { request: string; previous_reply?: string };
/**
 * A fake Jev answering by question id, one answer set per batch call (one `askJev`) in call order.
 *
 * @param rounds - One answer set per call, by question id; the last repeats, and a number is an HTTP error status for
 * that whole call.
 * @returns The fake.
 */
const inOrder = (...rounds: (Record<string, Record<string, unknown>> | number)[]): Jev => (q) => {
  const round = rounds[Math.min(q.call, rounds.length - 1)];
  return typeof round === "number" ? round : round[q.id];
};

async function drain(stream: AsyncGenerator<unknown, unknown>) {
  const chunks: Chunk[] = [];
  for (;;) {
    const n = await stream.next();
    if (n.done) return { chunks, result: n.value };
    chunks.push(n.value as Chunk);
  }
}

function claudeBeneath(on: On, seen: unknown[]) {
  on("turn.step", async function*(_$, e) {
    seen.push(e);
    yield { kind: "text", index: 0, text: "from claude" };
    yield { kind: "stop", stopReason: "end_turn", usage: null };
    return { turnId: e.turnId, index: e.index, answer: "from claude", toolUses: [], stopReason: "end_turn", usage: null };
  });
}

const toolId = (chunks: Chunk[]) => (chunks.find((c) => c.kind === "tool")?.id as string | undefined) ?? "";

const runJev = async ($: Runner, args: string) => String(((await $.command.run({ command: "jev", args, origin: { kind: "composer" }, presentation: { isFullscreen: false, columns: 80 } })) as { text?: string }).text ?? "");

const decision = async ($: Runner, input: Record<string, unknown>) => ((await $.tool.check(input)) as { decision?: string }).decision;

/** The `session.start` input of every test that starts a session. */
const START = { cwd: CWD, surface: "terminal", isInteractive: true };

/**
 * The stubs `session.start` needs beneath jevfort: `/jev` registration, `estimate_effort` registration, the event's end.
 *
 * @param on - The test's `on`.
 * @returns The names passed to `$.tool.register`, in call order.
 */
function sessionStubs(on: On) {
  const registered: unknown[] = [];
  on("command.register", async () => ({ value: undefined }));
  on("tool.register", async (_$, e) => {
    registered.push(e.name);
    return { value: { tool: "mcp__jevfort__estimate_effort" } };
  });
  on("session.start", async () => ({}));
  return registered;
}

/** The band above the prompt as the terminal raises it (`ui.render`, component `AbovePrompt`). */
const BAND = { plugin: "jevfort", component: "AbovePrompt", props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80 }, surface: "terminal" };
/** What a hook beneath jevfort draws in the band: seen when jevfort passes. */
const BENEATH = { type: "Text", props: {}, children: ["beneath"] };
/** The part of a mounted site the band helpers read. */
type Site = { find(q: { type?: string; text?: string | RegExp; key?: string }): Promise<{ props: Record<string, unknown> } | undefined> };
/**
 * The props of the band's Text for one effort level.
 *
 * @param ui - The mounted band.
 * @param level - The effort level.
 * @returns Its props (`bold`, `color`, `dimColor`), or `undefined` when not drawn.
 */
const levelProps = async (ui: Site, level: string) => (await ui.find({ type: "Text", text: new RegExp(`^${level} $`) }))?.props;
/**
 * The label of the band's Auto button.
 *
 * @param ui - The mounted band.
 * @returns The label, or `undefined` when not drawn.
 */
const autoLabel = async (ui: Site) => (await ui.find({ type: "Button", key: "auto" }))?.props.label;

test("Jev takes a confident Read step without asking Claude", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  const seen: unknown[] = [];
  setup(on, {
    messages: [user("what does src/app.ts export?")],
    files: [`${CWD}/src/app.ts`],
    jev: byId({
      next_action: { type: "choice", choice: "read src/app.ts", probabilities: { "read src/app.ts": 0.95, claude: 0.05 }, confidence: 0.9 },
      difficulty: easy,
    }),
  });
  claudeBeneath(on, seen);

  const { chunks } = await drain($.turn.step(step));
  expect(seen).toHaveLength(0);
  expect(chunks).toContainEqual(expect.objectContaining({ kind: "tool", name: "Read" }));
  expect(chunks).toContainEqual({ kind: "input", index: 0, json: JSON.stringify({ file_path: `${CWD}/src/app.ts` }) });
});

test("An unsure Jev hands the step to Claude, with effort lowered for an easy turn", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  const seen: unknown[] = [];
  setup(on, {
    messages: [user("what does src/app.ts export?")],
    files: [`${CWD}/src/app.ts`],
    jev: byId({
      next_action: { type: "choice", choice: "read src/app.ts", probabilities: { "read src/app.ts": 0.6, claude: 0.4 }, confidence: 0.3 },
      difficulty: easy,
      effort: easy,
    }),
  });
  claudeBeneath(on, seen);

  await drain($.turn.step(step));
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ effort: "low", model: "claude-opus-5-5" });
});

test("subagents: false leaves a subagent step to Claude without asking Jev", { options: { subagents: false } }, async ($, on) => {
  const seen: unknown[] = [];
  const { calls } = setup(on, { messages: [user("what does this project do?")], jev: byId({ difficulty: easy, effort: easy }) });
  claudeBeneath(on, seen);

  await drain($.turn.step({ ...step, agentId: "a1" }));
  expect(calls()).toBe(0);
  expect(seen[0]).toMatchObject({ effort: "high", model: "claude-opus-5-5" });
});

test("model routing moves a trivial turn to Haiku", { options: { routing: "model" } }, async ($, on) => {
  const seen: unknown[] = [];
  setup(on, { messages: [user("hi, what time zone is UTC+2?")], jev: byId({ difficulty: easy, effort: easy }) });
  claudeBeneath(on, seen);

  await drain($.turn.step(step));
  expect(seen[0]).toMatchObject({ effort: "low", model: "claude-haiku-5-5" });
});

test("a step model routing lowered to Haiku leaves the countdown of the chat's own cache", { options: { routing: "model" } }, async ($, on) => {
  let difficulty: Record<string, unknown> = scored(3);
  const { clock } = setup(on, { messages: [user("what does this project do?")], jev: (q) => (q.id === "difficulty" ? difficulty : undefined) });
  const seen: { model: string }[] = [];
  const usage = { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 900 };
  on("turn.step", async function*(_$, e) {
    seen.push(e as { model: string });
    yield { kind: "stop", stopReason: "end_turn", usage };
    return { turnId: e.turnId, index: e.index, answer: "ok", toolUses: [], stopReason: "end_turn", usage };
  });
  sessionStubs(on);
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);
  const label = async () => ((await ui.find({ type: "Text", text: /cache/ })) as { children?: unknown[] } | undefined)?.children?.[0];
  // A response on the chat's own model starts the countdown.
  await drain($.turn.step(step));
  expect(seen.at(-1)?.model).toBe("claude-opus-5-5");
  await clock.advance(59 * 60_000 + 30_000);
  expect(await label()).toBe(" cache <1m");
  // A trivial step sent to Haiku writes Haiku's cache, not the Opus one: the Opus countdown still runs out.
  difficulty = easy;
  await drain($.turn.step({ ...step, turnId: "t2" }));
  expect(seen.at(-1)?.model).toBe("claude-haiku-5-5");
  await clock.advance(60_000);
  expect(await label()).toBe(" cache cold");
  await ui.unmount();
});

test("When Jev is unreachable the step goes to Claude unchanged", async ($, on) => {
  const seen: unknown[] = [];
  setup(on, { messages: [user("what does src/app.ts export?")], files: [`${CWD}/src/app.ts`], jev: () => 401 });
  claudeBeneath(on, seen);

  const { chunks } = await drain($.turn.step(step));
  expect(seen[0]).toMatchObject({ effort: "high", model: "claude-opus-5-5" });
  expect(chunks).toContainEqual({ kind: "text", index: 0, text: "from claude" });
});

// askJev: all questions of a decision go out in one jev-api batch call; `state` travels as JSON text.
test("A turn-start decision sends its questions in one jev-api batch call", async ($, on) => {
  const { sent, calls } = setup(on, { messages: [user("what does src/app.ts export?")], files: [`${CWD}/src/app.ts`], jev: () => undefined, env: { TYPESAFE_API_KEY: "k" } });
  claudeBeneath(on, []);

  await drain($.turn.step(step));
  expect(calls()).toBe(1);
  // Every interactive jev-api call gives jev-api an HTTP timeout equal to the 4 s askJev budget (14 s while Haiku answers because no Jev variable is set).
  expect(sent.every((q) => q.timeout === 4)).toBe(true);
  expect(sent.map((q) => [q.id, q.type])).toEqual([
    ["next_action", "choice"],
    ["effort", "score"],
    ["mechanical", "noul"],
    ["single_action", "noul"],
  ]);
  for (let i = 0; i < sent.length; i++) expect(stateOf(sent, i).request).toBe("what does src/app.ts export?");
  expect(sent[0].instructions).toBe(nextActionQuestion([]).instructions);
  expect(Object.keys(sent[0].criteria as object)).toEqual(["claude", "read src/app.ts"]);
  expect(sent[1].criteria).toEqual(effortQuestion.criteria);
});

test("A jev-api deny leaves the step to Claude and is logged with its text", async ($, on) => {
  const seen: unknown[] = [];
  setup(on, { messages: [user("what does this project do?")], jev: () => 503 });
  claudeBeneath(on, seen);

  await drain($.turn.step(step));
  expect(seen[0]).toMatchObject({ effort: "high", model: "claude-opus-5-5" });
  expect(await runJev($, "")).toContain("error (pass): unavailable: batch: HTTP 503");
});

test("One wrong answer discards the other answers of the same decision", async ($, on) => {
  const seen: unknown[] = [];
  // The easy effort score alone would lower the turn to low; the score answered for `mechanical` voids it.
  setup(on, { messages: [user("what does this project do?")], jev: (q) => (q.id === "mechanical" ? easy : scored(0.2)) });
  claudeBeneath(on, seen);

  await drain($.turn.step(step));
  expect(seen[0]).toMatchObject({ effort: "high" });
  expect(await runJev($, "")).toContain("unavailable: batch: no valid noul answer for questions[1]");
});

// One malformed answer per case, every other answer valid, so only the field under test can fail the decision.
const choiceOk = { type: "choice", choice: "claude", probabilities: { claude: 1 }, confidence: 0.9 };
for (
  const [name, id, answer, error] of [
    ["a choice without probabilities", "next_action", { type: "choice", choice: "claude", confidence: 0.9 }, "no valid choice answer for questions[0]"],
    ["a choice with a non-finite probability", "next_action", { ...choiceOk, probabilities: { claude: "1" } }, "no valid choice answer for questions[0]"],
    ["a choice without confidence", "next_action", { type: "choice", choice: "claude", probabilities: { claude: 1 } }, "no valid choice answer for questions[0]"],
    ["a choice whose choice is not text", "next_action", { ...choiceOk, choice: 5 }, "no valid choice answer for questions[0]"],
    ["a score whose score is not a number", "effort", { type: "score", score: "x", probabilities: {}, confidence: 0.9 }, "no valid score answer for questions[1]"],
    ["a noul given as text", "mechanical", { type: "noul", noul: "1" }, "no valid noul answer for questions[2]"],
  ] as const
) {
  test(`An answer with ${name} fails the decision instead of crashing a hook`, async ($, on) => {
    const seen: unknown[] = [];
    // Each would throw inside the hooks (bestAction, pickCandidate) or read "1" as >= 0.95.
    // A readable file makes step 0 ask next_action (questions[0]) ahead of effort and mechanical.
    setup(on, { messages: [user("what does src/app.ts export?")], files: [`${CWD}/src/app.ts`], jev: (q) => (q.id === id ? answer : q.id === "effort" ? scored(0.2) : undefined) });
    claudeBeneath(on, seen);

    await drain($.turn.step(step));
    expect(seen[0]).toMatchObject({ effort: "high" });
    // The newest /jev row: the recent list is module state, so an older case's identical row must not satisfy this one.
    expect((await runJev($, "")).split("\n").filter((l) => l.startsWith("- ")).at(-1)).toContain(`unavailable: batch: ${error}`);
  });
}

test("Core's error result for the batch call fails the decision with a batch: prefix", async ($, on) => {
  const seen: unknown[] = [];
  // Ahead of setup's fake: what core answers when jev-api's hook was skipped and no hook answered its tool.
  const error = "Error: jev-api registered the tool batch but no tool.call hook answered this call";
  on("tool.call", (_$, e, next) => (e.tool === JEV_BATCH ? { value: { isError: true, result: error, text: error } } : next(e)));
  setup(on, { messages: [user("what does this project do?")], jev: () => undefined });
  claudeBeneath(on, seen);

  await drain($.turn.step(step));
  expect(seen[0]).toMatchObject({ effort: "high" });
  expect(await runJev($, "")).toContain(`unavailable: batch: ${error}`);
});

for (const [name, answer, error] of [["of another type", mech(0.5), "batch: no valid score answer for questions[0]"], ["that is not JSON", "<html>", "batch: result is not JSON"], ["with too few answers", "[]", "batch: expected 2 answers"]] as const) {
  test(`A jev-api result ${name} fails the decision`, async ($, on) => {
    const seen: unknown[] = [];
    setup(on, { messages: [user("what does this project do?")], jev: (q) => (q.id === "effort" ? answer : undefined) });
    claudeBeneath(on, seen);

    await drain($.turn.step(step));
    expect(seen[0]).toMatchObject({ effort: "high" });
    expect(await runJev($, "")).toContain(`unavailable: ${error}`);
  });
}

test("An answered Jev call leaves no budget timer pending", async ($, on) => {
  let started = 0;
  let cancelled = 0;
  on("clock.after", (_$, e, next) => {
    started++;
    next.signal.addEventListener("abort", () => cancelled++, { once: true });
    return next(e);
  });
  const { clock } = setup(on, { messages: [user("what does this project do?")], jev: () => undefined, env: { TYPESAFE_API_KEY: "k" } });
  claudeBeneath(on, []);

  await drain($.turn.step(step));
  await clock.advance(0);
  expect(started).toBeGreaterThan(0);
  expect(cancelled).toBe(started);
});

test("Jev calls that do not answer within 4000 ms time out and Claude takes the step", async ($, on) => {
  const seen: unknown[] = [];
  const { sent, clock } = setup(on, { messages: [user("what does this project do?")], jev: () => new Promise<never>(() => {}), env: { JEV_URL: "https://jev.example/x" } });
  claudeBeneath(on, seen);

  const run = drain($.turn.step(step));
  // The module loads by dynamic import (file I/O), which one settle does not wait for: flush until both questions are out.
  while (sent.length < 2) await clock.advance(0);
  await clock.advance(3999);
  expect(seen).toHaveLength(0);
  await clock.advance(1);
  await run;
  expect(ids(sent)).toEqual(["effort", "mechanical"]);
  expect(seen[0]).toMatchObject({ effort: "high", model: "claude-opus-5-5" });
  expect(await runJev($, "")).toContain("unavailable: timeout after 4000ms");
});

test("After a timeout Jev is not asked again for 30 s, then once more", async ($, on) => {
  const seen: unknown[] = [];
  const { clock, calls } = setup(on, { messages: [user("what does this project do?")], jev: () => new Promise<never>(() => {}), env: { JEV_URL: "https://jev.example/x" } });
  claudeBeneath(on, seen);
  let run = drain($.turn.step(step));
  while (calls() < 1) await clock.advance(0);
  await clock.advance(4000);
  await run;
  expect(calls()).toBe(1);
  // Within the pause nothing is sent.
  await drain($.turn.step(step));
  expect(calls()).toBe(1);
  expect(await runJev($, "")).toContain("paused for");
  // After it, one probe goes out.
  await clock.advance(30_000);
  run = drain($.turn.step(step));
  while (calls() < 2) await clock.advance(0);
  await clock.advance(4000);
  await run;
  expect(calls()).toBe(2);
});

test("A second timeout doubles the pause to 60 s and a success resets it", async ($, on) => {
  let hang = true;
  const { clock, calls } = setup(on, { messages: [], jev: () => (hang ? new Promise<never>(() => {}) : undefined), env: { JEV_URL: "https://jev.example/x" } });
  const timeoutAt = async (n: number) => {
    const p = $.tool.call({ ...ESTIMATE });
    while (calls() < n) await clock.advance(0);
    await clock.advance(4000);
    await p;
  };
  const sentAfter = async (wait: number) => {
    const before = calls();
    await clock.advance(wait);
    const p = $.tool.call({ ...ESTIMATE });
    for (let i = 0; i < 20; i++) await clock.advance(0);
    const sent = calls() > before;
    if (sent && hang) await clock.advance(4000);
    await p;
    return sent;
  };
  await timeoutAt(1); // pause 30 s
  await clock.advance(30_000);
  await timeoutAt(2); // the probe times out too: the pause doubles to 60 s
  expect(await sentAfter(31_000)).toBe(false);
  hang = false;
  expect(await sentAfter(30_000)).toBe(true); // 61 s after: sent, answered, resets the pause
  hang = true;
  await timeoutAt(4); // the first timeout after a success pauses 30 s again
  expect(await sentAfter(31_000)).toBe(true);
});

test("Further timeouts double the pause up to 10 min and no further", async ($, on) => {
  const { clock, calls } = setup(on, { messages: [], jev: () => new Promise<never>(() => {}), env: { JEV_URL: "https://jev.example/x" } });
  const timeoutAt = async (n: number) => {
    const p = $.tool.call({ ...ESTIMATE });
    // The first call waits out the module's dynamic import (file I/O), which no settle count bounds.
    for (let i = 0; n === 1 ? calls() < n : i < 1000 && calls() < n; i++) await clock.advance(0);
    expect(calls()).toBe(n);
    await clock.advance(4000);
    await p;
  };
  // Pauses 30, 60, 120, 240, 480 s, then capped at 600 s twice.
  await timeoutAt(1);
  for (const [n, pause] of [[2, 30_000], [3, 60_000], [4, 120_000], [5, 240_000], [6, 480_000], [7, 600_000]] as const) {
    await clock.advance(pause);
    await timeoutAt(n);
  }
  await clock.advance(600_000);
  await timeoutAt(8);
  expect(calls()).toBe(8);
});

test("Parallel calls that time out in one outage lengthen the pause once", async ($, on) => {
  const { clock, calls } = setup(on, { messages: [], jev: () => new Promise<never>(() => {}), env: { JEV_URL: "https://jev.example/x" } });
  const estimates = [$.tool.call({ ...ESTIMATE }), $.tool.call({ ...ESTIMATE })];
  while (calls() < 2) await clock.advance(0);
  await clock.advance(4000);
  await Promise.all(estimates);
  // One 30 s pause, not 30 s doubled by the second timeout: 31 s later a call goes out again.
  await clock.advance(31_000);
  const again = $.tool.call({ ...ESTIMATE });
  while (calls() < 3) await clock.advance(0);
  await clock.advance(4000);
  await again;
  expect(calls()).toBe(3);
});

test("A clock that reads earlier than the last timeout ends the pause (a new session)", async ($, on) => {
  const back = { at: -1 };
  on("clock.now", (_$, e, next) => (back.at < 0 ? next(e) : { value: back.at }));
  let hang = true;
  const { clock, calls } = setup(on, { messages: [], jev: () => (hang ? new Promise<never>(() => {}) : undefined), env: { JEV_URL: "https://jev.example/x" } });
  await clock.advance(100_000);
  const p = $.tool.call({ ...ESTIMATE });
  while (calls() < 1) await clock.advance(0);
  await clock.advance(4000);
  await p;
  // The 30 s pause would still hold; the clock now reads 5 s, before the timeout at 100 s.
  back.at = 5000;
  hang = false;
  await $.tool.call({ ...ESTIMATE });
  expect(calls()).toBe(2);
});

for (const [name, deny, env] of [["a jev-api timeout answered before jevfort's own", "batch: timeout after 4000ms", { JEV_URL: "https://jev.example/x" }], ["a Haiku timeout (14 s, before the 15 s budget)", "batch: fallback: timeout after 14000ms", {}]] as const) {
  test(`${name} pauses Jev like the local timeout`, async ($, on) => {
    const seen: unknown[] = [];
    const { calls } = setup(on, { messages: [user("what does this project do?")], jev: () => ({ __deny: deny }), env });
    claudeBeneath(on, seen);
    await drain($.turn.step(step));
    expect(calls()).toBe(1);
    // Within the pause nothing is sent.
    await drain($.turn.step(step));
    expect(calls()).toBe(1);
    expect(await runJev($, "")).toContain("paused for");
  });
}

test("a fast failure that is no timeout pauses nothing", async ($, on) => {
  const seen: unknown[] = [];
  const { calls } = setup(on, { messages: [user("what does this project do?")], jev: () => ({ __deny: "batch: HTTP 503" }), env: { JEV_URL: "https://jev.example/x" } });
  claudeBeneath(on, seen);
  await drain($.turn.step(step));
  await drain($.turn.step(step));
  expect(calls()).toBe(2);
});

test("a /clear (session.end) drops the done follow-up that was submitted before it", async ($, on) => {
  setup(on, { messages: [], jev: () => undefined });
  on("session.end", () => ({}));
  on("prompt.submit", (_$, e) => ({ text: e.text }));
  await $.session.end({ reason: "clear", sessionId: "s1", resume: { id: "s1" } });
  const r = await $.prompt.submit({ text: FOLLOW_UP, wait: false, origin: { kind: "plugin", name: "jevfort" } });
  expect(JSON.stringify(r)).toContain("conversation was cleared");
});

test("a /clear during the done check drops the follow-up the check queues", { options: { classify: false } }, async ($, on) => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { sent, clock } = setup(on, { messages: [user("rename foo to bar in all files")], jev: (q) => gate.then(() => (q.id === "done" ? { type: "noul", noul: 0.04 } : undefined)) as Promise<never> });
  const submitted = followUps(on);
  on("session.end", () => ({}));
  const turn = $.turn.complete(answered("t1", "Half done."));
  while (!ids(sent).includes("done")) await clock.advance(0);
  await $.session.end({ reason: "clear", sessionId: "s1", resume: { id: "s1" } });
  release();
  await turn;
  await expect.poll(() => submitted.length).toBe(1);
  const r = await ownSubmit($, submitted[0]);
  expect(JSON.stringify(r)).toContain("conversation was cleared");
});

test("without any Jev variable (Haiku answers in jev-api) the budget is 15000 ms", async ($, on) => {
  const seen: unknown[] = [];
  const { sent, clock } = setup(on, { messages: [user("what does this project do?")], jev: () => new Promise<never>(() => {}) });
  claudeBeneath(on, seen);

  const run = drain($.turn.step(step));
  while (sent.length < 2) await clock.advance(0);
  await clock.advance(14_999);
  expect(seen).toHaveLength(0);
  await clock.advance(1);
  await run;
  expect(seen).toHaveLength(1);
  expect(await runJev($, "")).toContain("unavailable: timeout after 15000ms");
});

// What the engine does for a plugin's own `$.prompt.submit`: the hooks see it stamped with the plugin as origin (the kit stamps none).
const FOLLOW_UP = "Jev: the user's request doesn't look finished yet. Continue with what remains. If it is actually complete, say so in one line.";
const ownSubmit = ($: Runner, text = FOLLOW_UP) => $.prompt.submit({ text, wait: false, origin: { kind: "plugin", name: "jevfort" } });
const userSubmit = ($: Runner, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: "composer" } });
// A Jev that finds the request unfinished.
const unfinished = byId({ done: { type: "noul", noul: 0.04 } });

test("The done check sends Claude back once when work is unfinished", { options: { classify: false } }, async ($, on) => {
  const { sent } = setup(on, { messages: [user("rename foo to bar in all files")], jev: unfinished });
  const submitted = followUps(on);

  await $.turn.complete(answered("t1", "I renamed it in one file. Want me to do the rest?"));
  await expect.poll(() => submitted.length).toBe(1);
  expect(submitted[0]).toContain("doesn't look finished yet");
  expect(sent.map((q) => [q.id, q.type])).toEqual([["done", "noul"]]);

  // The follow-up turn is exempt: no second Jev call, no second follow-up.
  await ownSubmit($);
  await $.turn.complete(answered("t2", "Done."));
  expect(sent).toHaveLength(1);
  expect(submitted).toHaveLength(2);

  // The exemption is used up: the next turn is checked again.
  await $.turn.complete(answered("t3", "Done."));
  expect(sent).toHaveLength(2);
});

test("A user pasting the follow-up text neither arms nor consumes the exemption", { options: { classify: false } }, async ($, on) => {
  const { sent } = setup(on, { messages: [user("rename foo to bar in all files")], jev: unfinished });
  followUps(on);
  await userSubmit($, FOLLOW_UP);
  await $.turn.complete(answered("t1", "One file only."));
  expect(sent).toHaveLength(1);
});

test("A user turn between the follow-up and its turn clears the exemption", { options: { classify: false } }, async ($, on) => {
  const { sent } = setup(on, { messages: [user("rename foo to bar in all files")], jev: unfinished });
  followUps(on);
  await ownSubmit($);
  await userSubmit($, "actually, also rename baz");
  await $.turn.complete(answered("t1", "Renamed."));
  expect(sent).toHaveLength(1);
});

test("A prompt typed during the follow-up turn keeps that turn exempt", { options: { classify: false } }, async ($, on) => {
  const { sent } = setup(on, { messages: [user("rename foo to bar in all files")], jev: unfinished });
  const submitted = followUps(on);
  await $.turn.complete(answered("t1", "I renamed it in one file. Want me to do the rest?"));
  await expect.poll(() => submitted.length).toBe(1);
  await ownSubmit($);
  // Typed while t2 runs: prompt.submit fires at Enter with the running turn's id.
  await $.prompt.submit({ text: "also update the docs afterwards", wait: true, turnId: "t2", origin: { kind: "composer" } });
  await $.turn.complete(answered("t2", "Renamed in two more files."));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  // One done question; the submits are the one follow-up, the test's ownSubmit and the typed prompt (no second follow-up).
  expect({ doneCalls: ids(sent).filter((x) => x === "done").length, submits: submitted.length }).toEqual({ doneCalls: 1, submits: 3 });
});

test("A follow-up that failed to submit exempts nothing", { options: { classify: false } }, async ($, on) => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { sent, clock } = setup(on, { messages: [user("rename foo to bar in all files")], jev: (q) => gate.then(() => unfinished(q)) as Promise<never> });
  on("turn.complete", () => ({ text: "" }));
  // As the engine: jevfort's hook sees its own follow-up stamped with its origin (arming the exemption), then a hook beneath refuses it.
  on("prompt.submit", (_$, e) => {
    if ((e as { origin?: unknown }).origin === undefined) throw new Error("rejected");
    return { value: {} };
  });
  const t1 = $.turn.complete(answered("t1", "One file only."));
  while (!ids(sent).includes("done")) await clock.advance(0);
  await ownSubmit($); // the kit stamps no origin, so arm the exemption as the stamped follow-up would
  release();
  await t1;
  for (let i = 0; i < 20; i++) await clock.advance(0);
  // The submit was rejected, so the next turn is checked again, and logs the lost follow-up in its own frame.
  await $.turn.complete(answered("t2", "Still one file."));
  expect(ids(sent)).toEqual(["done", "done"]);
  expect(await runJev($, "")).toContain("done follow-up not sent");
});

test("A meta prompt between the follow-up and its turn keeps the exemption", { options: { classify: false } }, async ($, on) => {
  const { sent } = setup(on, { messages: [user("rename foo to bar in all files")], jev: unfinished });
  followUps(on);
  await ownSubmit($);
  await $.prompt.submit({ text: "<task-notification>done</task-notification>", wait: false, isMeta: true, origin: { kind: "system" } });
  await $.turn.complete(answered("t1", "Done."));
  expect(sent).toHaveLength(0);
});

test("A user message quoting the follow-up text stays the scored request", { options: { classify: false } }, async ($, on) => {
  const { sent } = setup(on, { messages: [user(`${FOLLOW_UP} Also rename baz.`)], jev: byId({ done: { type: "noul", noul: 0.9 } }) });
  followUps(on);
  await $.turn.complete(answered("t1", "Renamed."));
  expect(stateOf(sent, 0).request).toContain("rename baz");
});

test("The done follow-up as the engine stores it (wrapped) is not the request of its own turn", { options: { classify: false } }, async ($, on) => {
  const wrapped = `The jevfort plugin sent a message:\n${FOLLOW_UP}\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.`;
  const { sent } = setup(on, { messages: [user("rename foo to bar in all files"), { role: "assistant", text: "One file.", toolUses: [] }, user(wrapped)], jev: byId({ done: { type: "noul", noul: 0.9 } }) });
  followUps(on);
  await $.turn.complete(answered("t1", "Renamed."));
  expect(stateOf(sent, 0).request).toBe("rename foo to bar in all files");
});

test("A finished background task (origin task-notification) is not classified", async ($, on) => {
  const { sent } = setup(on, { messages: [], jev: () => undefined });
  on("prompt.submit", (_$, e) => ({ text: e.text }));
  await $.prompt.submit({ text: "<task-notification>task done, please look at the output of the build</task-notification>", wait: false, origin: { kind: "task-notification" } });
  expect(sent).toHaveLength(0);
});

for (const [status, asked] of [["completed", 1], ["failed", 1], ["killed", 1], ["idle", 1], ["running", 0], ["pending", 0], ["starting", 0]] as const) {
  // classify off: the kit runs the unawaited follow-up's prompt.submit (unstamped, so classified) before the assertion.
  test(`The done check with a ${status} subagent asks Jev ${asked} time(s)`, { options: { classify: false } }, async ($, on) => {
    const { sent } = setup(on, { messages: [user("rename foo to bar in all files")], jev: unfinished, agents: [{ status }] });
    followUps(on);
    await $.turn.complete(answered("t1", "One file only."));
    expect(sent).toHaveLength(asked);
  });
}

test("The done check skips subagent turns", async ($, on) => {
  const { sent } = setup(on, { messages: [user("rename foo to bar in all files")], jev: unfinished });
  const submitted = followUps(on);

  await $.turn.complete(answered("t1", "I renamed it in one file.", { agentId: "a1" }));
  expect(sent).toHaveLength(0);
  expect(submitted).toHaveLength(0);
});

// Esc, an API error or a refusal is no answer to judge: the done check must not send Claude back.
for (const reason of ["aborted", "error", "refusal"]) {
  test(`The done check skips turns ending with reason ${reason}`, async ($, on) => {
    const { sent } = setup(on, { messages: [user("rename foo to bar in all files")], jev: unfinished });
    const submitted = followUps(on);
    await $.turn.complete({ ...answered("t1", "I renamed it in one file."), reason });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect({ done: ids(sent).filter((x) => x === "done").length, submitted: submitted.length }).toEqual({ done: 0, submitted: 0 });
  });
}

// Jev's own calls skip auto mode's classifier: the mod approves them itself, but a settings deny rule beneath still wins.
for (const [beneath, expected] of [["ask", "allow"], ["deny", "deny"]] as const) {
  test(`A call Jev made itself is approved over "${beneath}" → ${expected}`, { options: { takeOnlyForBypass: false } }, async ($, on) => {
    setup(on, {
      messages: [user("run the tests please")],
      packageJson: { scripts: { test: "node --test" } },
      jev: byId({
        next_action: { type: "choice", choice: "run npm test", probabilities: { "run npm test": 0.97, claude: 0.03 }, confidence: 0.95 },
        difficulty: easy,
      }),
    });
    claudeBeneath(on, []);
    on("tool.check", () => ({ decision: beneath }));

    const { chunks } = await drain($.turn.step(step));
    const id = toolId(chunks);
    expect(id).not.toBe("");

    expect(await decision($, { tool: "Bash", input: { command: "npm test" }, tool_use_id: id })).toBe(expected);

    // Claude's own call to the same tool is left to the engine.
    expect(await decision($, { tool: "Bash", input: { command: "npm test" }, tool_use_id: "toolu_claude" })).toBe(beneath);
  });
}

// Claude Code allows in-project reads itself, so its ask on a Read means the path resolves outside the working directories (a symlink).
test("A Read Jev made itself keeps Claude Code's ask", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  setup(on, {
    messages: [user("what does src/app.ts export?")],
    jev: byId({ next_action: { type: "choice", choice: "read src/app.ts", probabilities: { "read src/app.ts": 0.97, claude: 0.03 }, confidence: 0.95 }, difficulty: easy }),
    files: [`${CWD}/src/app.ts`],
  });
  claudeBeneath(on, []);
  on("tool.check", () => ({ decision: "ask", reason: "/proj/src/app.ts resolves through a symlink to /etc/x, which is outside the allowed working directories." }));
  const id = toolId((await drain($.turn.step(step))).chunks);
  expect(id).not.toBe("");
  expect(await decision($, { tool: "Read", input: { file_path: `${CWD}/src/app.ts` }, tool_use_id: id })).toBe("ask");
});

test("A symlinked file is never offered as a Read candidate", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  setup(on, {
    messages: [user("what is in notes.txt?")],
    jev: byId({ next_action: { type: "choice", choice: "read notes.txt", probabilities: { "read notes.txt": 0.97, claude: 0.03 }, confidence: 0.95 }, difficulty: easy }),
    links: [`${CWD}/notes.txt`],
  });
  claudeBeneath(on, []);
  expect(toolId((await drain($.turn.step(step))).chunks)).toBe("");
});

// An allow that a settings rule already gave stays as it is: rewording it makes the security plugin warn the user.
test("A call Jev made itself keeps a settings allow verdict untouched", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  setup(on, {
    messages: [user("what does src/app.ts export?")],
    jev: byId({ next_action: { type: "choice", choice: "read src/app.ts", probabilities: { "read src/app.ts": 0.97, claude: 0.03 }, confidence: 0.95 }, difficulty: easy }),
    files: [`${CWD}/src/app.ts`],
  });
  claudeBeneath(on, []);
  const base = { decision: "allow", rule: "Read(/proj/**)", reason: "settings rule" };
  on("tool.check", () => base);
  const id = toolId((await drain($.turn.step(step))).chunks);
  expect(await $.tool.check({ tool: "Read", input: { file_path: `${CWD}/src/app.ts` }, tool_use_id: id })).toEqual(base);
});

test("A settings ask rule beats the allow for a call Jev made itself", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  setup(on, {
    messages: [user("what does src/app.ts export?")],
    jev: byId({ next_action: { type: "choice", choice: "read src/app.ts", probabilities: { "read src/app.ts": 0.97, claude: 0.03 }, confidence: 0.95 }, difficulty: easy }),
    files: [`${CWD}/src/app.ts`],
  });
  claudeBeneath(on, []);
  on("tool.check", () => ({ decision: "ask", rule: "Read(/proj/src/**)" }));
  const id = toolId((await drain($.turn.step(step))).chunks);
  expect(await decision($, { tool: "Read", input: { file_path: `${CWD}/src/app.ts` }, tool_use_id: id })).toBe("ask");
});

// A slash command's skill text is not in the transcript: Jev must not take a step or bypass the turn on the bare command.
test("A turn started by a slash command is left to Claude (no take, no bypass)", async ($, on) => {
  const seen: unknown[] = [];
  const command = "<command-message>read-file</command-message>\n<command-name>/read-file</command-name>\n<command-args>src/app.ts</command-args>";
  setup(on, {
    messages: [user("Thanks!"), { role: "assistant", text: "ok", toolUses: [] }, user(command)],
    jev: byId({ next_action: { type: "choice", choice: "read src/app.ts", probabilities: { "read src/app.ts": 0.97, claude: 0.03 }, confidence: 0.95 }, single_action: mech(0.95) }),
    files: [`${CWD}/src/app.ts`],
  });
  claudeBeneath(on, seen);
  const { chunks } = await drain($.turn.step(step));
  expect(toolId(chunks)).toBe("");
  expect(seen).toHaveLength(1);
});

test("A later step of a slash-command turn is not measured against Jev either", async ($, on) => {
  const command = "<command-message>read-file</command-message>\n<command-name>/read-file</command-name>\n<command-args>src/app.ts</command-args>";
  const { calls } = setup(on, {
    messages: [user("Thanks!"), { role: "assistant", text: "ok", toolUses: [] }, user(command)],
    jev: byId({ next_action: { type: "choice", choice: "read src/app.ts", probabilities: { "read src/app.ts": 0.97, claude: 0.03 }, confidence: 0.95 } }),
    files: [`${CWD}/src/app.ts`],
  });
  claudeBeneath(on, []);
  await drain($.turn.step({ ...step, index: 4 }));
  expect(calls()).toBe(0);
  expect(await runJev($, "report")).not.toContain("Agreement with Claude");
});

// Phase 2: every decision is logged, and Claude's own call is compared with Jev's.
test("Inside a longer turn Jev's measured top action is compared with Claude's call and reported as agreement", async ($, on) => {
  setup(on, {
    messages: [user("what does src/app.ts export?")],
    files: [`${CWD}/src/app.ts`],
    jev: byId({
      next_action: { type: "choice", choice: "read src/app.ts", probabilities: { "read src/app.ts": 0.92, claude: 0.08 }, confidence: 0.9 },
    }),
  });
  on("turn.step", async function*(_$, e) {
    yield { kind: "tool", index: 0, id: "toolu_c1", name: "Read" };
    yield { kind: "input", index: 0, json: JSON.stringify({ file_path: `${CWD}/src/app.ts` }) };
    yield { kind: "stop", stopReason: "tool_use", usage: null };
    return { turnId: e.turnId, index: e.index, answer: "", toolUses: [{ name: "Read", input: { file_path: `${CWD}/src/app.ts` } }], stopReason: "tool_use", usage: null };
  });

  // A later step of the turn: Jev is asked in parallel (measureSteps) and never takes the step.
  await drain($.turn.step({ ...step, index: 4 }));
  const report = await runJev($, "report");
  expect(report).toContain("| Agreement with Claude | **1 / 1** (100%) |");
  expect(report).toMatch(/\| \d\d:\d\d \| what does src\/app\.ts export\? \| read src\/app\.ts \| 0\.92 \| Read app\.ts \| ✓ same \|/);
  expect(report).toContain("| **0.85 ← current** | 1 | 100% |");
  expect(report).not.toContain("shadow");
});

test("An answered step measurement leaves no timer pending, the 250 ms grace timer included", async ($, on) => {
  const started: number[] = [];
  let cancelled = 0;
  on("clock.after", (_$, e, next) => {
    started.push(Number(e.ms));
    next.signal.addEventListener("abort", () => cancelled++, { once: true });
    return next(e);
  });
  const { clock, sent } = setup(on, {
    messages: [user("what does src/app.ts export?")],
    files: [`${CWD}/src/app.ts`],
    jev: byId({ next_action: { type: "choice", choice: "read src/app.ts", probabilities: { "read src/app.ts": 0.92, claude: 0.08 }, confidence: 0.9 } }),
  });
  claudeBeneath(on, []);

  await drain($.turn.step({ ...step, index: 1 }));
  await clock.advance(0);
  expect(ids(sent)).toEqual(["next_action"]);
  expect(started).toContain(250);
  expect(cancelled).toBe(started.length);
});

test("Passes are logged too: a \"claude\" pick, an unchanged route", { options: { routing: "model" } }, async ($, on) => {
  setup(on, {
    messages: [user("refactor the auth module to use JWT")],
    files: [],
    jev: byId({ difficulty: { type: "score", score: 2.6, probabilities: { "0": 0, "1": 0.05, "2": 0.3, "3": 0.65 }, confidence: 0.6 } }),
  });
  claudeBeneath(on, []);

  await drain($.turn.step(step));
  const report = await runJev($, "report");
  expect(report).toContain("| Effort routing | 1 turns | avg difficulty 2.60");
  expect(report).not.toContain("| Gate |");
});

test("Jev can pick a skill on the first step of a turn", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  setup(on, {
    messages: [user("write the release notes for this version")],
    jev: byId({
      next_action: { type: "choice", choice: "skill write-release-notes", probabilities: { "skill write-release-notes": 0.93, claude: 0.07 }, confidence: 0.9 },
      difficulty: easy,
    }),
  });
  on("command.list", () => ({
    value: [
      { name: "write-release-notes", description: "Write release notes from the git log", source: "user" },
      { name: "help", description: "Show help", source: "builtin" },
    ],
  }));
  claudeBeneath(on, []);

  const { chunks } = await drain($.turn.step(step));
  expect(chunks).toContainEqual(expect.objectContaining({ kind: "tool", name: "Skill" }));
  expect(chunks).toContainEqual({ kind: "input", index: 0, json: JSON.stringify({ skill: "write-release-notes" }) });
});

test("The jev-api tools are never offered to Jev as tools to load", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  const offered: string[] = [];
  setup(on, {
    messages: [user("ask jev a noul question about the score of this choice")],
    tools: [...JEV_TOOLS, { name: "mcp__weather__ask", description: "Ask a question about the weather", mcp: true }],
    jev: (q) => {
      if (q.id === "next_action") offered.push(...Object.keys(q.criteria as object));
      return undefined;
    },
  });
  on("command.list", () => ({ value: [] }));
  claudeBeneath(on, []);

  await drain($.turn.step(step));
  expect(offered).toContain("load mcp__weather__ask");
  expect(offered.filter((k) => k.includes("jev-api"))).toEqual([]);
});

test("Bash commands and edits are not gated", async ($, on) => {
  const { sent } = setup(on, { messages: [user("fix the typo in README.md")], jev: () => undefined });
  on("tool.check", () => ({ decision: "allow" }));

  expect(await decision($, { tool: "Edit", input: { file_path: "/proj/other.ts", new_string: "x" }, tool_use_id: "toolu_6" })).toBe("allow");
  expect(await decision($, { tool: "Bash", input: { command: "rm -rf ~/" }, tool_use_id: "toolu_7" })).toBe("allow");
  expect(sent).toHaveLength(0);
});

// Writes into this session's scratchpad are allowed in every permission mode; a settings deny still wins.
const SP = "/tmp/claude-1000/-proj/sid-1/scratchpad";
const scratch: { name: string; tool: string; key: string; path: string; beneath: string; expected: string; env?: Record<string, string> }[] = [
  { name: "Write into the scratchpad", tool: "Write", key: "file_path", path: `${SP}/notes.md`, beneath: "ask", expected: "allow" },
  { name: "Edit over a settings deny", tool: "Edit", key: "file_path", path: `${SP}/notes.md`, beneath: "deny", expected: "deny" },
  { name: "NotebookEdit into the scratchpad", tool: "NotebookEdit", key: "notebook_path", path: `${SP}/a.ipynb`, beneath: "ask", expected: "allow" },
  { name: "Write into another session's scratchpad", tool: "Write", key: "file_path", path: "/tmp/claude-1000/-proj/sid-2/scratchpad/x", beneath: "ask", expected: "ask" },
  { name: "Write escaping the scratchpad with ..", tool: "Write", key: "file_path", path: `${SP}/../../../../etc/x`, beneath: "ask", expected: "ask" },
  { name: "Write below a non-tmp root", tool: "Write", key: "file_path", path: "/home/u/claude-1000/-proj/sid-1/scratchpad/x", beneath: "ask", expected: "ask" },
  { name: "Write to the scratchpad directory itself", tool: "Write", key: "file_path", path: SP, beneath: "ask", expected: "ask" },
  { name: "Write below TMPDIR", tool: "Write", key: "file_path", path: "/var/folders/T/claude-501/-proj/sid-1/scratchpad/x", beneath: "ask", expected: "allow", env: { TMPDIR: "/var/folders/T/" } },
];
for (const c of scratch) {
  test(`Scratchpad writes are always allowed: ${c.name} over "${c.beneath}" -> ${c.expected}`, async ($, on) => {
    setup(on, { messages: [user("anything")], jev: () => undefined, env: c.env });
    on("tool.check", () => ({ decision: c.beneath }));

    expect(await decision($, { tool: c.tool, input: { [c.key]: c.path }, tool_use_id: "toolu_sp" })).toBe(c.expected);
  });
}

test("A settings ask rule beats the scratchpad allow", async ($, on) => {
  setup(on, { messages: [user("anything")], jev: () => undefined });
  on("tool.check", () => ({ decision: "ask", rule: "Write(/tmp/**)" }));
  expect(await decision($, { tool: "Write", input: { file_path: `${SP}/x` }, tool_use_id: "toolu_sp4" })).toBe("ask");
});

test("After /clear (session.end and a new session id) the new scratchpad is allowed and the old one is not", async ($, on) => {
  let sid = SID;
  on("session.id", () => ({ value: sid })); // before setup's: the first stub answers
  setup(on, { messages: [user("anything")], jev: () => undefined });
  on("tool.check", () => ({ decision: "ask" }));
  on("session.end", () => ({}));
  expect(await decision($, { tool: "Write", input: { file_path: `${SP}/x` }, tool_use_id: "toolu_sp5" })).toBe("allow");
  await $.session.end({ reason: "clear", sessionId: SID, resume: { id: SID } });
  sid = "sid-2";
  expect(await decision($, { tool: "Write", input: { file_path: "/tmp/claude-1000/-proj/sid-2/scratchpad/x" }, tool_use_id: "toolu_sp6" })).toBe("allow");
  expect(await decision($, { tool: "Write", input: { file_path: `${SP}/x` }, tool_use_id: "toolu_sp7" })).toBe("ask");
});

// Phase 3: a simple request is answered by Jev's action plus a small-model summary.
for (const [single, expectBypass] of [[0.95, true], [0.3, false]] as const) {
  test(`Whole-turn bypass ${expectBypass ? "answers" : "does not answer"} when single_action=${single}`, async ($, on) => {
    const messages: Msg[] = [user("run the tests")];
    const seen: unknown[] = [];
    setup(on, {
      messages,
      packageJson: { scripts: { test: "node --test" } },
      jev: byId({
        next_action: { type: "choice", choice: "run npm test", probabilities: { "run npm test": 0.95, claude: 0.05 }, confidence: 0.9 },
        difficulty: easy,
        single_action: { type: "noul", noul: single },
      }),
    });
    const asked: string[] = [];
    on("model.complete", (_$, e) => {
      asked.push(String(e.prompt));
      return {
        value: {
          isAnswered: true,
          text: "All 3 tests passed.",
          usage: { input_tokens: 120, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      };
    });
    claudeBeneath(on, seen);

    // Step 0: Jev runs the tests itself, but only when the whole turn can be bypassed.
    const first = await drain($.turn.step(step));
    const id = toolId(first.chunks);
    if (!expectBypass) {
      expect(id).toBe("");
      expect(seen).toHaveLength(1);
      return;
    }
    expect(id).not.toBe("");

    // The tool ran; step 1 sees its result.
    messages.push({ role: "assistant", text: "", toolUses: [{ tool_use_id: id, tool: "Bash", input: { command: "npm test" }, text: "# tests 3\n# pass 3\n# fail 0" }] });
    messages.push({ role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: id, text: "# pass 3", isError: false }] });
    const second = await drain($.turn.step({ ...step, index: 1, messageCount: 3 }));

    expect(seen).toHaveLength(0);
    expect(second.chunks).toContainEqual({ kind: "text", index: 0, text: "All 3 tests passed." });
    expect(asked[0]).toContain("# pass 3");
    const report = await runJev($, "report");
    expect(report).toContain("| Turns answered without Claude | **1**");
  });
}

test("Built-in commands are never offered as skills, and a skill that fails is blocklisted", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  const offered: string[][] = [];
  setup(on, {
    messages: [user("summarize the recent changes")],
    jev: (q) => {
      if (q.id !== "next_action") return q.id === "difficulty" ? easy : undefined;
      offered.push(Object.keys(q.criteria as object));
      return { type: "choice", choice: "skill changelog", probabilities: { "skill changelog": 0.95, claude: 0.05 }, confidence: 0.9 };
    },
  });
  on("command.list", () => ({
    value: [
      { name: "diff", description: "View uncommitted changes", source: "user" },
      { name: "changelog", description: "Summarize recent changes", source: "plugin" },
    ],
  }));
  on("tool.call", () => ({ result: undefined, isError: true, text: "changelog is not a skill" }));
  claudeBeneath(on, []);

  const { chunks } = await drain($.turn.step(step));
  expect(offered[0]).not.toContain("skill diff");
  expect(offered[0]).toContain("skill changelog");
  await $.tool.call({ tool: "Skill", skill: "changelog", tool_use_id: toolId(chunks) });

  await drain($.turn.step({ ...step, turnId: "t2" }));
  expect(offered[1] ?? []).not.toContain("skill changelog");
});

test("The done check stays quiet while background work is running", async ($, on) => {
  const { sent } = setup(on, {
    messages: [user("find every localStorage use with a subagent")],
    jev: byId({ done: { type: "noul", noul: 0.02 } }),
    agents: [{ status: "running" }],
  });
  const submitted = followUps(on);

  await $.turn.complete(answered("t1", "The subagent is running; I will report back."));
  expect(sent).toHaveLength(0);
  expect(submitted).toHaveLength(0);
  expect(await runJev($, "")).toContain("skipped: waiting on 1 background task(s)");
});

test("By default Jev takes no steps inside a longer turn", async ($, on) => {
  const seen: unknown[] = [];
  const { sent } = setup(on, {
    messages: [user("add a priority field, then run the tests")],
    packageJson: { scripts: { test: "node --test" } },
    jev: byId({
      next_action: { type: "choice", choice: "run npm test", probabilities: { "run npm test": 0.97, claude: 0.03 }, confidence: 0.95 },
      difficulty: easy,
      single_action: { type: "noul", noul: 0.95 },
    }),
  });
  claudeBeneath(on, seen);
  // A later step of the turn: Jev is only asked in parallel, to measure.
  const { chunks } = await drain($.turn.step({ ...step, index: 4 }));
  expect(toolId(chunks)).toBe("");
  expect(seen).toHaveLength(1);
  expect(ids(sent)).toEqual(["next_action"]);
});

test("Effort lowered at step 0 holds for the later steps of the turn", async ($, on) => {
  const seen: { effort?: string }[] = [];
  setup(on, { messages: [user("what does this project do?")], jev: byId({ difficulty: easy, effort: easy }) });
  claudeBeneath(on, seen);
  await drain($.turn.step(step));
  await drain($.turn.step({ ...step, index: 1 }));
  expect(seen.map((s) => s.effort)).toEqual(["low", "low"]);
});

test("Effort routing sees the reply a short follow-up answers", async ($, on) => {
  const { sent } = setup(on, {
    messages: [user("add a sync layer"), { role: "assistant", text: "Here is the plan: 1. … Want me to build it?", toolUses: [] }, user("yes")],
    jev: byId({ difficulty: easy }),
  });
  claudeBeneath(on, []);
  await drain($.turn.step(step));
  const state = stateOf(sent, 0);
  expect(state.request).toBe("yes");
  expect(state.previous_reply).toBe("Here is the plan: 1. … Want me to build it?");
});

test("A big job asked at medium effort runs at xhigh, on an older Opus id too", async ($, on) => {
  const seen: { effort?: string }[] = [];
  const hard = { type: "score", score: 2.9, probabilities: {}, confidence: 0.95 };
  setup(on, { messages: [user("migrate the whole app to TypeScript")], jev: byId({ difficulty: hard, effort: hard }) });
  claudeBeneath(on, seen);
  await drain($.turn.step({ ...step, effort: "medium" }));
  await drain($.turn.step({ ...step, turnId: "t2", model: "claude-opus-5", effort: "medium" }));
  expect(seen.map((s) => s.effort)).toEqual(["xhigh", "xhigh"]);
});

test("There is no mode: a stored legacy mode is ignored and /jev off is no command", async ($, on) => {
  const seen: unknown[] = [];
  const { sent } = setup(on, { messages: [user("what does this project do?")], jev: byId({ difficulty: easy }), store: { mode: "off" } });
  claudeBeneath(on, seen);
  const status = await runJev($, "off");
  expect(status).toContain("Jev pilot: routing");
  expect(status).not.toContain("Jev pilot mode");
  // Only the first line: the recent-decisions list is module state shared across tests and may mention a model.
  expect(status.split("\n")[0]).not.toContain("mode");
  await drain($.turn.step(step));
  // One decision: its two questions went to jev-api.
  expect(ids(sent)).toEqual(["effort", "mechanical"]);
  expect(seen).toHaveLength(1);
});

// The estimate_effort tool: registered at session.start, answered by the unmatched tool.call hook on every call.
test("session.start registers estimate_effort", async ($, on) => {
  setup(on, { messages: [], jev: () => undefined });
  const registered: Record<string, unknown>[] = [];
  on("command.register", async () => ({ value: undefined }));
  on("tool.register", async (_$, e) => {
    registered.push(e);
    return { value: { tool: "mcp__jevfort__estimate_effort" } };
  });
  on("session.start", async () => ({}));
  await $.session.start({ cwd: CWD, surface: "terminal", isInteractive: true });
  expect(registered).toHaveLength(1);
  expect(registered[0]).toMatchObject({
    name: "estimate_effort",
    inputSchema: { properties: { model: { enum: ["haiku", "sonnet", "opus", "fable"] } }, required: ["model", "defaultEffort", "minEffort", "maxEffort", "prompt"] },
  });
});

test("Inverted effort bounds are logged as an error at session start", { options: { minEffort: "high", maxEffort: "low" } }, async ($, on) => {
  setup(on, { messages: [], jev: () => undefined });
  on("command.register", async () => ({ value: undefined }));
  on("tool.register", async () => ({ value: { tool: "mcp__jevfort__estimate_effort" } }));
  on("session.start", async () => ({}));
  await $.session.start({ cwd: CWD, surface: "terminal", isInteractive: true });
  expect(await runJev($, "report")).toContain("1 errors");
});

test("Effort routing does not ask Jev the difficulty question", async ($, on) => {
  const { sent } = setup(on, { messages: [user("what does this project do?")], jev: byId({ effort: scored(1.6) }) });
  claudeBeneath(on, []);
  await drain($.turn.step(step));
  expect(ids(sent)).toEqual(["effort", "mechanical"]);
});

const ESTIMATE = { tool: "mcp__jevfort__estimate_effort", model: "opus", defaultEffort: "high", minEffort: "low", maxEffort: "xhigh", prompt: "add a retry to the HTTP client" };
const estimateCall = async ($: Runner, input: Record<string, unknown> = {}) => (await $.tool.call({ ...ESTIMATE, ...input })) as { result?: string; isError?: boolean; deny?: string };

test("estimate_effort returns Jev's estimate", async ($, on) => {
  const { sent } = setup(on, { messages: [], jev: byId({ effort: scored(1.6), mechanical: mech(0.1) }) });
  expect(await estimateCall($)).toEqual({ result: JSON.stringify({ effort: "medium", source: "jev" }) });
  expect(sent.map((q) => [q.id, q.type])).toEqual([["effort", "score"], ["mechanical", "noul"]]);
  expect(stateOf(sent, 0).request).toBe(ESTIMATE.prompt);
});

// Rewording a settings allow makes cc-plugin-sec-default warn the user.
test("estimate_effort keeps a settings allow verdict untouched", async ($, on) => {
  setup(on, { messages: [], jev: () => undefined });
  const base = { decision: "allow", rule: "mcp__jevfort__estimate_effort", reason: "settings rule" };
  on("tool.check", () => base);
  expect(await $.tool.check({ tool: ESTIMATE.tool, input: {}, tool_use_id: "toolu_1" })).toEqual(base);
});

test("A settings ask rule beats the estimate_effort allow", async ($, on) => {
  setup(on, { messages: [], jev: () => undefined });
  on("tool.check", () => ({ decision: "ask", rule: "mcp__jevfort__estimate_effort" }));
  expect(await decision($, { tool: ESTIMATE.tool, input: {}, tool_use_id: "toolu_1" })).toBe("ask");
});

test("estimate_effort falls back to defaultEffort when Jev is unreachable", async ($, on) => {
  setup(on, { messages: [], jev: () => 401 });
  expect(await estimateCall($)).toEqual({ result: JSON.stringify({ effort: "high", source: "fallback" }) });
  expect(await runJev($, "")).toContain("estimate (pass): opus: high (fallback, batch: HTTP 401)");
});

test("A null script in the project's package.json does not stop the turn's routing", async ($, on) => {
  const seen: unknown[] = [];
  setup(on, { messages: [user("run the tests please")], packageJson: { scripts: { test: null } }, jev: byId({ effort: easy }) });
  claudeBeneath(on, seen);

  await drain($.turn.step(step));
  expect(seen[0]).toMatchObject({ effort: "low" });
});

test("A failing store does not fail estimate_effort or a turn step", async ($, on) => {
  on("store.set", () => ({ deny: "store over 4 MiB of JSON text" }));
  const seen: unknown[] = [];
  setup(on, { messages: [user("what does this project do?")], jev: byId({ effort: scored(1.6), mechanical: mech(0.1) }) });
  claudeBeneath(on, seen);
  expect(await estimateCall($)).toEqual({ result: JSON.stringify({ effort: "medium", source: "jev" }) });
  await drain($.turn.step(step));
  expect(seen).toHaveLength(1);
});

test("An error text of megabytes is cut before the log and /jev hold it", async ($, on) => {
  setup(on, { messages: [user("what does this project do?")], jev: () => ({ __deny: "x".repeat(500_000) }) });
  claudeBeneath(on, []);
  await drain($.turn.step(step));
  const status = await runJev($, "");
  expect(status).toContain("unavailable: xxx");
  expect(status).toContain("more chars]");
  expect(status.length).toBeLessThan(5000);
});

test("/jev export writes a new file and never an existing one (a symlink would be followed)", async ($, on) => {
  setup(on, { messages: [], jev: () => undefined });
  const written: string[] = [];
  on("fs.write", (_$, e) => (written.push(String(e.path)), { value: undefined }));
  expect(await runJev($, "export")).toMatch(/wrote \d+ entries to \/proj\/\.jev\/decisions-\d+\.jsonl/);
  expect(written).toHaveLength(1);
  expect(written[0]).toMatch(/^\/proj\/\.jev\/decisions-\d+\.jsonl$/);
});

test("/jev export writes nothing when the target exists", async ($, on) => {
  on("fs.exists", () => ({ value: true }));
  setup(on, { messages: [], jev: () => undefined });
  const written: string[] = [];
  on("fs.write", (_$, e) => (written.push(String(e.path)), { value: undefined }));
  expect(await runJev($, "export")).toContain("exists, nothing written");
  expect(written).toHaveLength(0);
});

test("With takeOnlyForBypass a confident skill pick is not taken by Jev (the skill would never run)", async ($, on) => {
  const seen: unknown[] = [];
  setup(on, {
    messages: [user("write the release notes for this version")],
    jev: byId({
      next_action: { type: "choice", choice: "skill write-release-notes", probabilities: { "skill write-release-notes": 0.93, claude: 0.07 }, confidence: 0.9 },
      single_action: mech(0.9),
    }),
  });
  on("command.list", () => ({ value: [{ name: "write-release-notes", description: "Write release notes from the git log", source: "user" }] }));
  claudeBeneath(on, seen);
  await drain($.turn.step(step));
  expect(seen).toHaveLength(1);
});

test("A refused clock read fails neither estimate_effort nor a turn step", async ($, on) => {
  on("clock.now", () => ({ deny: "clock refused" }));
  const seen: unknown[] = [];
  setup(on, { messages: [user("what does this project do?")], jev: byId({ effort: scored(1.6), mechanical: mech(0.1) }) });
  claudeBeneath(on, seen);
  expect(await estimateCall($)).toEqual({ result: JSON.stringify({ effort: "medium", source: "jev" }) });
  await drain($.turn.step(step));
  expect(seen).toHaveLength(1);
});

test("/jev status still answers when the counters cannot be read", async ($, on) => {
  on("store.get", () => ({ deny: "EACCES" }));
  setup(on, { messages: [], jev: () => undefined });
  expect(await runJev($, "")).toContain("Decisions (all sessions): unreadable=1");
});

test("A turn's mentioned paths are statted at most 16 per step and each once per turn", async ($, on) => {
  const missing = Array.from({ length: 100 }, (_, i) => `src/gone${i}.ts`);
  const { statted } = setup(on, { messages: [user(`fix the build, tsc says: ${missing.join(" ")}`)], jev: () => undefined });
  claudeBeneath(on, []);
  await drain($.turn.step(step));
  const first = statted.length;
  expect(first).toBeLessThanOrEqual(16);
  await drain($.turn.step({ ...step, index: 1 }));
  expect(statted.length - first).toBeLessThanOrEqual(16);
  expect(new Set(statted).size).toBe(statted.length);
});

test("After a mid-turn compaction the path scan starts over and offers a newly named file", async ($, on) => {
  const bash = (id: string, out: string): Msg[] => [
    { role: "assistant", text: "", toolUses: [{ tool_use_id: id, tool: "Bash", input: { command: "true" }, text: out }] },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: id, text: out, isError: false }] },
  ];
  const messages: Msg[] = [user("fix the build"), ...bash("c1", "nothing"), ...bash("c2", "nothing"), ...bash("c3", "nothing")];
  const { sent } = setup(on, { messages, files: [`${CWD}/src/new.ts`], jev: () => undefined });
  claudeBeneath(on, []);
  await drain($.turn.step({ ...step, index: 3 }));
  // Auto-compaction between two steps of the same turn: the transcript now starts with the summary row.
  messages.splice(0, messages.length, user("This session is being continued from a previous conversation that ran out of context. Summary: fix the build."), ...bash("c4", "error TS2304 in src/new.ts"));
  await drain($.turn.step({ ...step, index: 4 }));
  const last = sent.filter((q) => q.id === "next_action").at(-1);
  expect(Object.keys(last?.criteria ?? {})).toContain("read src/new.ts");
});

test("The path scan starts over when the transcript has fewer steps under the same request row", async ($, on) => {
  const said = (text: string): Msg => ({ role: "assistant", text, toolUses: [] });
  const messages: Msg[] = [user("tidy up the helpers"), said("one"), said("two"), said("three")];
  const { sent } = setup(on, { messages, files: [`${CWD}/src/new.ts`], jev: () => undefined });
  claudeBeneath(on, []);
  await drain($.turn.step({ ...step, index: 1 }));
  // Same request row, but the step rows were replaced by fewer ones naming a new file.
  messages.splice(1, messages.length, said("look at src/new.ts"));
  await drain($.turn.step({ ...step, index: 2 }));
  const last = sent.filter((q) => q.id === "next_action").at(-1);
  expect(Object.keys(last?.criteria ?? {})).toContain("read src/new.ts");
});

test("A mid-turn cd moves a later step's Read candidate to the new cwd", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  let cwd = CWD;
  const messages: Msg[] = [user("check the sub project")];
  const k = "read src/b.ts";
  setup(on, { messages, cwd: () => cwd, files: [`${CWD}/sub/src/b.ts`, `${CWD}/src/b.ts`], jev: byId({ next_action: { type: "choice", choice: k, probabilities: { [k]: 0.95, claude: 0.05 }, confidence: 0.9 } }) });
  claudeBeneath(on, []);
  await drain($.turn.step(step));
  // Claude's step 0 ran `cd sub` (carried over), its output names src/b.ts.
  cwd = `${CWD}/sub`;
  messages.push(
    { role: "assistant", text: "", toolUses: [{ tool_use_id: "u1", tool: "Bash", input: { command: "cd sub && ls src" }, text: "src/b.ts" }] },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "u1", text: "src/b.ts", isError: false }] },
  );
  const { chunks } = await drain($.turn.step({ ...step, index: 1, messageCount: 3 }));
  expect(chunks).toContainEqual({ kind: "input", index: 0, json: JSON.stringify({ file_path: `${CWD}/sub/src/b.ts` }) });
});

test("A call's result that arrives a step later is still scanned for file paths", async ($, on) => {
  const call: { tool_use_id: string; tool: string; input: Record<string, unknown>; text?: string } = { tool_use_id: "c1", tool: "Bash", input: { command: "tsc" } };
  const messages: Msg[] = [user("fix the build"), { role: "assistant", text: "", toolUses: [call] }];
  const { sent } = setup(on, { messages, files: [`${CWD}/src/x.ts`], jev: () => undefined });
  claudeBeneath(on, []);
  await drain($.turn.step({ ...step, index: 1 }));
  // The result lands on the call already seen without text; no new row names the file.
  call.text = "error TS2304 in src/x.ts";
  await drain($.turn.step({ ...step, index: 2 }));
  const last = sent.filter((q) => q.id === "next_action").at(-1);
  expect(Object.keys(last?.criteria ?? {})).toContain("read src/x.ts");
});

test("One file under several spellings is one Read candidate", async ($, on) => {
  const out = "./src/app.ts:3:export const useAuth = 1\n/proj/src/app.ts:4: x";
  const messages: Msg[] = [
    user("where is useAuth used? start with src/app.ts"),
    { role: "assistant", text: "", toolUses: [{ tool_use_id: "c1", tool: "Bash", input: { command: "grep -rn useAuth ." }, text: out }] },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "c1", text: out, isError: false }] },
  ];
  const { sent } = setup(on, { messages, files: [`${CWD}/src/app.ts`], jev: () => undefined });
  claudeBeneath(on, []);
  await drain($.turn.step({ ...step, index: 1, messageCount: 3 }));
  const last = sent.filter((q) => q.id === "next_action").at(-1);
  expect(Object.keys(last?.criteria ?? {}).filter((k) => k.startsWith("read "))).toEqual(["read src/app.ts"]);
});

test("A file the turn already read is not offered again under another spelling", async ($, on) => {
  const messages: Msg[] = [
    user("check src/./app.ts"),
    { role: "assistant", text: "", toolUses: [{ tool_use_id: "r1", tool: "Read", input: { file_path: "src/app.ts" }, text: "1\texport const a = 1" }] },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "r1", text: "1\texport const a = 1", isError: false }] },
    // A later call, so the Read is not the step's last call and only the already-read filter can drop it.
    { role: "assistant", text: "", toolUses: [{ tool_use_id: "b1", tool: "Bash", input: { command: "git status" }, text: "clean" }] },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "b1", text: "clean", isError: false }] },
  ];
  const { sent } = setup(on, { messages, files: [`${CWD}/src/./app.ts`, `${CWD}/src/app.ts`], jev: () => undefined });
  claudeBeneath(on, []);
  await drain($.turn.step({ ...step, index: 2, messageCount: 5 }));
  const last = sent.filter((q) => q.id === "next_action").at(-1);
  expect(Object.keys(last?.criteria ?? {}).filter((k) => k.startsWith("read "))).toEqual([]);
});

test("A finished step does not wait for a slow step measurement", async ($, on) => {
  const seen: unknown[] = [];
  const { sent, clock } = setup(on, { messages: [user("what does src/app.ts export?")], files: ["/proj/src/app.ts"], jev: () => new Promise<never>(() => {}) });
  claudeBeneath(on, seen);
  const run = drain($.turn.step({ ...step, index: 4 }));
  while (sent.length < 1) await clock.advance(0);
  // The measurement has 4000 ms; the step is let go after 250 ms.
  await clock.advance(250);
  await run;
  expect(seen).toHaveLength(1);
});

test("estimate_effort rejects invalid input without asking Jev", async ($, on) => {
  const { sent } = setup(on, { messages: [], jev: byId({ effort: scored(1.6) }) });
  expect(await estimateCall($, { model: "gpt" })).toEqual({ deny: "estimate_effort: model must be one of haiku, sonnet, opus, fable" });
  expect(await estimateCall($, { minEffort: "high", maxEffort: "low" })).toEqual({ deny: "estimate_effort: minEffort must not be above maxEffort" });
  expect(sent).toHaveLength(0);
});

test("estimate_effort estimates on every call, also for haiku", async ($, on) => {
  const { sent } = setup(on, { messages: [], jev: inOrder({ effort: scored(1.6) }, { effort: scored(3), mechanical: mech(0.97) }) });
  expect(await estimateCall($, { model: "haiku" })).toEqual({ result: JSON.stringify({ effort: "medium", source: "jev" }) });
  expect(await estimateCall($, { model: "haiku" })).toEqual({ result: JSON.stringify({ effort: "low", source: "mechanical" }) });
  expect(ids(sent)).toEqual(["effort", "mechanical", "effort", "mechanical"]);
});

// Turn-start effort estimate: Jev's effort score within minEffort..maxEffort.
test("A mechanical turn runs at minEffort even on a hard score", async ($, on) => {
  const seen: { effort?: string }[] = [];
  setup(on, { messages: [user("rename foo to bar in src/a.ts")], jev: byId({ difficulty: easy, effort: scored(2.9), mechanical: mech(0.97) }) });
  claudeBeneath(on, seen);
  await drain($.turn.step(step));
  expect(seen.map((s) => s.effort)).toEqual(["low"]);
});

// Effort score logging: the effort score and its confidence are logged, to recalibrate the cut points from real turns.
test("route and estimate log entries carry effortScore and effortConfidence", async ($, on) => {
  // Registered before setup so it answers `store.set` ahead of the in-memory store; each write then holds one new entry.
  const log: { kind: string; data?: Record<string, unknown> }[] = [];
  on("store.set", (_$, e) => (e.key === "log" && log.push(...(e.value as typeof log)), { value: undefined }));
  setup(on, { messages: [user("what does src/app.ts export?")], jev: byId({ difficulty: easy, effort: scored(1.6, 0.3), mechanical: mech(0.1) }) });
  claudeBeneath(on, []);
  await drain($.turn.step(step));
  await estimateCall($, { model: "opus" });
  await runJev($, "report"); // writes the pending decisions
  for (const kind of ["route", "estimate"]) {
    const entry = log.find((l) => l.kind === kind);
    expect(entry?.data).toMatchObject({ effortScore: 1.6, effortConfidence: 0.3 });
  }
});

test("maxEffort caps a confident hard estimate", { options: { maxEffort: "medium" } }, async ($, on) => {
  const seen: { effort?: string }[] = [];
  setup(on, { messages: [user("migrate the whole app to TypeScript")], jev: byId({ difficulty: easy, effort: scored(2.9) }) });
  claudeBeneath(on, seen);
  await drain($.turn.step(step));
  expect(seen.map((s) => s.effort)).toEqual(["medium"]);
});

test("minEffort raises a confident easy estimate", { options: { minEffort: "medium" } }, async ($, on) => {
  const seen: { effort?: string }[] = [];
  setup(on, { messages: [user("what does this project do?")], jev: byId({ difficulty: easy, effort: scored(0.2) }) });
  claudeBeneath(on, seen);
  await drain($.turn.step(step));
  expect(seen.map((s) => s.effort)).toEqual(["medium"]);
});

test("An inverted minEffort/maxEffort config falls back to low..xhigh", { options: { minEffort: "max", maxEffort: "low" } }, async ($, on) => {
  const seen: { effort?: string }[] = [];
  setup(on, { messages: [user("migrate the whole app to TypeScript")], jev: byId({ difficulty: easy, effort: scored(2.9) }) });
  claudeBeneath(on, seen);
  await drain($.turn.step(step));
  expect(seen.map((s) => s.effort)).toEqual(["xhigh"]);
});

// Cadence (USER DECISION U1): Opus/Sonnet every turn; Haiku/Fable only on the loop's first turn, then held.
const turnStep = (turnId: string, model: string, effort: string) => ({ turnId, index: 0, model, effort, messageCount: 1 });

for (const model of ["claude-opus-5-5", "claude-sonnet-5-5"]) {
  test(`On ${model} every turn is estimated`, async ($, on) => {
    const seen: { effort?: string }[] = [];
    const { sent } = setup(on, { messages: [user("what does this project do?")], jev: inOrder({ difficulty: easy, effort: scored(0.2) }, { difficulty: easy, effort: scored(2.9) }) });
    claudeBeneath(on, seen);
    await drain($.turn.step(turnStep("t1", model, "high")));
    await drain($.turn.step(turnStep("t2", model, "high")));
    expect(ids(sent)).toEqual(["effort", "mechanical", "effort", "mechanical"]);
    expect(seen.map((s) => s.effort)).toEqual(["low", "xhigh"]);
  });
}

for (const model of ["claude-haiku-5-5", "claude-fable-5"]) {
  const estimated = "medium";
  test(`On ${model} only the first turn is estimated and later turns hold it`, async ($, on) => {
    const seen: { effort?: string }[] = [];
    const { sent } = setup(on, { messages: [user("what does this project do?")], jev: inOrder({ difficulty: easy, effort: scored(1.6) }, { difficulty: easy, effort: scored(2.9) }) });
    claudeBeneath(on, seen);
    await drain($.turn.step(turnStep("t1", model, "high")));
    await drain($.turn.step(turnStep("t2", model, "high")));
    // A held turn in effort routing has nothing to ask Jev at step 0.
    expect(ids(sent)).toEqual(["effort", "mechanical"]);
    expect(seen.map((s) => s.effort)).toEqual([estimated, estimated]);
  });
}

test("A held Haiku effort still applies when Jev fails on a later turn", async ($, on) => {
  const seen: { effort?: string }[] = [];
  setup(on, { messages: [user("what does this project do?")], jev: inOrder({ difficulty: easy, effort: scored(1.6) }, 401) });
  claudeBeneath(on, seen);
  await drain($.turn.step(turnStep("t1", "claude-haiku-5-5", "high")));
  await drain($.turn.step(turnStep("t2", "claude-haiku-5-5", "high")));
  expect(seen.map((s) => s.effort)).toEqual(["medium", "medium"]);
});

test("A changed session effort ends the Haiku hold", async ($, on) => {
  const seen: { effort?: string }[] = [];
  const { sent } = setup(on, { messages: [user("what does this project do?")], jev: inOrder({ difficulty: easy, effort: scored(2.5) }, { difficulty: easy, effort: scored(0.2) }) });
  claudeBeneath(on, seen);
  await drain($.turn.step(turnStep("t1", "claude-haiku-5-5", "high")));
  await drain($.turn.step(turnStep("t2", "claude-haiku-5-5", "medium")));
  expect(ids(sent)).toEqual(["effort", "mechanical"]);
  expect(seen.map((s) => s.effort)).toEqual(["xhigh", "medium"]);
});

test("A failed first Haiku turn is not re-asked and later turns keep the session effort", async ($, on) => {
  const seen: { effort?: string }[] = [];
  const { sent } = setup(on, { messages: [user("what does this project do?")], jev: inOrder(401, { difficulty: easy, effort: scored(0.2) }) });
  claudeBeneath(on, seen);
  await drain($.turn.step(turnStep("t1", "claude-haiku-5-5", "high")));
  await drain($.turn.step(turnStep("t2", "claude-haiku-5-5", "high")));
  expect(ids(sent)).toEqual(["effort", "mechanical"]);
  expect(seen.map((s) => s.effort)).toEqual(["high", "high"]);
});

test("A switch from Opus to Haiku starts a new first turn with its own estimate", async ($, on) => {
  const seen: { effort?: string }[] = [];
  const { sent } = setup(on, { messages: [user("what does this project do?")], jev: inOrder({ difficulty: easy, effort: scored(0.2) }, { difficulty: easy, effort: scored(1.6) }) });
  claudeBeneath(on, seen);
  await drain($.turn.step(turnStep("t1", "claude-opus-5-5", "high")));
  await drain($.turn.step(turnStep("t2", "claude-haiku-5-5", "high")));
  await drain($.turn.step(turnStep("t3", "claude-haiku-5-5", "high")));
  expect(ids(sent)).toEqual(["effort", "mechanical", "effort", "mechanical"]);
  expect(seen.map((s) => s.effort)).toEqual(["low", "medium", "medium"]);
});

test("A /clear (session.end) starts a new Haiku first turn with its own estimate", async ($, on) => {
  const seen: { effort?: string }[] = [];
  const { sent } = setup(on, { messages: [user("what does this project do?")], jev: inOrder({ difficulty: easy, effort: scored(1.6) }, { difficulty: easy, effort: scored(2.9) }) });
  on("session.end", () => ({}));
  claudeBeneath(on, seen);
  await drain($.turn.step(turnStep("t1", "claude-haiku-5-5", "high")));
  await $.session.end({ reason: "clear", sessionId: "s1", resume: { id: "s1" } });
  await drain($.turn.step(turnStep("t2", "claude-haiku-5-5", "high")));
  expect(ids(sent)).toEqual(["effort", "mechanical", "effort", "mechanical"]);
  expect(seen.map((s) => s.effort)).toEqual(["medium", "xhigh"]);
});

// Self-disable: without jev-api's batch tool in the listing (here jev-api 0.1's three tools), every hook but /jev passes through untouched.
test("Without a jev-api tool jevfort is inactive: every hook passes through and /jev says why", async ($, on) => {
  const seen: unknown[] = [];
  const { sent } = setup(on, {
    messages: [user("what does src/app.ts export?")],
    files: [`${CWD}/src/app.ts`],
    tools: SINGLE_TOOLS,
    jev: unfinished,
  });
  claudeBeneath(on, seen);
  const submitted = followUps(on);
  const registered: unknown[] = [];
  on("command.register", async () => ({ value: undefined }));
  on("tool.register", async (_$, e) => {
    registered.push(e);
    return { value: { tool: "mcp__jevfort__estimate_effort" } };
  });
  on("session.start", async () => ({}));
  on("tool.check", () => ({ decision: "ask" }));
  on("tool.call", () => ({ result: "beneath" }));
  on("agent.offer", () => ({ isOffered: true }));
  on("session.compact", () => ({ skip: "test" }));

  // session.start registers no estimate_effort and logs why.
  await $.session.start({ cwd: CWD, surface: "terminal", isInteractive: true });
  expect(registered).toHaveLength(0);

  // The step goes to Claude unchanged, the scratchpad write keeps Claude Code's verdict, the turn's end is not checked
  // and a prompt is not classified. An estimate_effort call is still answered (its defaultEffort: Jev is unreachable) and approved.
  await drain($.turn.step(step));
  expect(seen).toEqual([step]);
  expect(await decision($, { tool: "Write", input: { file_path: `${SP}/notes.md` }, tool_use_id: "toolu_sp" })).toBe("ask");
  await $.turn.complete(answered("t1", "I renamed it in one file. Want me to do the rest?"));
  await userSubmit($, "rewrite the storage layer to use IndexedDB");
  expect(await estimateCall($)).toEqual({ result: JSON.stringify({ effort: "high", source: "fallback" }) });
  expect(await decision($, { tool: "mcp__jevfort__estimate_effort", tool_use_id: "toolu_est" })).toBe("allow");
  expect(submitted).toEqual(["rewrite the storage layer to use IndexedDB"]);
  // Offered agent types are not collected, an Agent call is not routed and a compaction gets no ranking.
  await $.agent.offer({ agent: "general-purpose", description: "General tasks", source: "built-in" });
  await $.agent.offer({ agent: "Explore", description: "Read-only codebase search", source: "built-in" });
  expect(await $.tool.call({ tool: "Agent", description: "find usages", prompt: "Find every caller of addTodo", tool_use_id: "a1" })).toEqual({ result: "beneath" });
  await $.session.compact({ trigger: "manual", messages: [user("fix the failing date test"), { role: "assistant", text: "", toolUses: ["a", "b", "c"].map((x, i) => ({ tool_use_id: `t${i}`, tool: "Bash", input: { command: `step ${x}` }, text: x })) }] });
  expect(sent).toHaveLength(0);

  const status = await runJev($, "");
  expect(status.startsWith(`${INACTIVE}\nJev pilot: routing effort`)).toBe(true);
  expect(status).toContain("error (pass): inactive: jev-api tools missing (mcp__jev-api__batch)");
});

test("A tool listing that fails counts as all jev-api tools missing", async ($, on) => {
  const seen: unknown[] = [];
  const { sent } = setup(on, { messages: [user("what does this project do?")], tools: null, jev: () => undefined });
  claudeBeneath(on, seen);

  await drain($.turn.step(step));
  expect(seen).toEqual([step]);
  expect(sent).toHaveLength(0);
  expect((await runJev($, "")).split("\n")[0]).toBe(INACTIVE);
});

test("jev-api registering batch inside session.start's next(e) makes jevfort active, also after a lookup in between", async ($, on) => {
  const tools: typeof JEV_TOOLS = [];
  const { sent } = setup(on, { messages: [user("what does this project do?")], tools, jev: byId({ effort: easy }) });
  claudeBeneath(on, []);
  const registered: unknown[] = [];
  on("command.register", async () => ({ value: undefined }));
  on("tool.register", async (_$, e) => {
    registered.push(e.name);
    return { value: { tool: "mcp__jevfort__estimate_effort" } };
  });
  on("tool.call", (_$, e, next) => (e.tool === "Read" ? { deny: "not here" } : next(e)));
  // Beneath jevfort, as in the engine's dependency order: another plugin's session.start makes a tool call, which
  // jevfort's tool.call hook sees while batch is not listed yet; then jev-api registers batch.
  on("session.start", async ($2) => {
    await $2.tool.call({ tool: "Read", file_path: `${CWD}/README.md` }).catch(() => undefined);
    tools.push(...JEV_TOOLS);
    return {};
  });

  await $.session.start({ cwd: CWD, surface: "terminal", isInteractive: true });
  expect(registered).toEqual(["estimate_effort"]);
  await drain($.turn.step(step));
  expect(ids(sent)).toEqual(["effort", "mechanical"]);
  // The listing raised beneath next(e) (before jev-api registered) applied nothing: no inactive error was logged.
  expect(await runJev($, "report")).toContain("· 0 errors |");
});

test("The jev-api lookup is repeated after each turn", { options: { doneCheck: false } }, async ($, on) => {
  const seen: { effort?: string }[] = [];
  const tools: typeof JEV_TOOLS = [];
  const { sent } = setup(on, { messages: [user("what does this project do?")], tools, jev: byId({ effort: easy }) });
  claudeBeneath(on, seen);
  followUps(on);
  const registered = sessionStubs(on);

  await $.session.start(START);
  await drain($.turn.step(step));
  // jev-api appears inside a turn: the turn's listing stands until the turn ends.
  tools.push(...JEV_TOOLS);
  await drain($.turn.step({ ...step, index: 1 }));
  expect(sent).toHaveLength(0);
  expect(registered).toHaveLength(0);

  // From the next turn on jevfort is active and estimate_effort is registered, once.
  await $.turn.complete(answered("t1", "It is a todo app."));
  await drain($.turn.step({ ...step, turnId: "t2" }));
  expect(ids(sent)).toEqual(["effort", "mechanical"]);
  expect(registered).toEqual(["estimate_effort"]);

  // jev-api goes away: from the next turn jevfort is inactive again and logs it once more.
  tools.length = 0;
  await $.turn.complete(answered("t2", "It is a todo app."));
  await drain($.turn.step({ ...step, turnId: "t3" }));
  expect(sent).toHaveLength(2);
  expect(registered).toEqual(["estimate_effort"]);
  expect(seen.map((s) => s.effort)).toEqual(["high", "high", "low", "high"]);
  expect((await runJev($, "")).split("\n")[0]).toBe(INACTIVE);
  // Two inactive errors: one at session start, one at the change.
  expect(await runJev($, "report")).toContain("· 2 errors |");
});

test("estimate_effort is not registered again when jev-api goes away and comes back", { options: { doneCheck: false } }, async ($, on) => {
  const tools: typeof JEV_TOOLS = [...JEV_TOOLS];
  setup(on, { messages: [user("what does this project do?")], tools, jev: byId({ effort: easy }) });
  claudeBeneath(on, []);
  followUps(on);
  const registered = sessionStubs(on);
  await $.session.start(START);
  expect(registered).toEqual(["estimate_effort"]);
  tools.length = 0;
  await $.turn.complete(answered("t1", "It is a todo app."));
  await drain($.turn.step({ ...step, turnId: "t2" }));
  // There is no unregister: back to ready keeps the one registration.
  tools.push(...JEV_TOOLS);
  await $.turn.complete(answered("t2", "It is a todo app."));
  await drain($.turn.step({ ...step, turnId: "t3" }));
  expect(registered).toEqual(["estimate_effort"]);
});

test("/jev between turns does not carry its listing into the next turn", { options: { doneCheck: false } }, async ($, on) => {
  const tools: typeof JEV_TOOLS = [];
  const { sent } = setup(on, { messages: [user("what does this project do?")], tools, jev: byId({ effort: easy }) });
  claudeBeneath(on, []);
  followUps(on);
  const registered = sessionStubs(on);

  await $.session.start(START);
  await drain($.turn.step(step));
  await $.turn.complete(answered("t1", "It is a todo app."));
  // The user runs /jev, reads "it looks again at the next turn" and enables jev-api.
  expect((await runJev($, "")).split("\n")[0]).toBe(INACTIVE);
  tools.push(...JEV_TOOLS);
  await drain($.turn.step({ ...step, turnId: "t2" }));
  expect(ids(sent)).toEqual(["effort", "mechanical"]);
  expect(registered).toEqual(["estimate_effort"]);
});

test("A failed estimate_effort registration is retried by the next turn's listing, then not repeated", { options: { doneCheck: false } }, async ($, on) => {
  setup(on, { messages: [user("what does this project do?")], jev: byId({ effort: easy }) });
  claudeBeneath(on, []);
  followUps(on);
  const attempts: unknown[] = [];
  on("command.register", async () => ({ value: undefined }));
  on("tool.register", async (_$, e) => {
    attempts.push(e.name);
    if (attempts.length === 1) throw new Error("transient");
    return { value: { tool: "mcp__jevfort__estimate_effort" } };
  });
  on("session.start", async () => ({}));

  await $.session.start(START);
  expect(attempts).toHaveLength(1);
  await $.turn.complete(answered("t1", "It is a todo app."));
  await drain($.turn.step({ ...step, turnId: "t2" }));
  expect(attempts).toHaveLength(2);
  await $.turn.complete(answered("t2", "It is a todo app."));
  await drain($.turn.step({ ...step, turnId: "t3" }));
  expect(attempts).toHaveLength(2);
});

test("A subagent's turn.complete does not drop the jev-api listing", { options: { doneCheck: false } }, async ($, on) => {
  const tools: typeof JEV_TOOLS = [];
  const { sent } = setup(on, { messages: [user("what does this project do?")], tools, jev: byId({ effort: easy }) });
  claudeBeneath(on, []);
  followUps(on);
  sessionStubs(on);

  await $.session.start(START);
  tools.push(...JEV_TOOLS);
  await $.turn.complete(answered("s1", "Found it.", { agentId: "a1" }));
  await drain($.turn.step({ ...step, turnId: "t2" }));
  expect(sent).toHaveLength(0);
  await $.turn.complete(answered("t2", "It is a todo app."));
  await drain($.turn.step({ ...step, turnId: "t3" }));
  expect(ids(sent)).toEqual(["effort", "mechanical"]);
});

test("The band shows the session effort bold and Jev's choice blue", async ($, on) => {
  const { clock } = setup(on, { messages: [user("what does this project do?")], jev: byId({ effort: easy }) });
  claudeBeneath(on, []);
  sessionStubs(on);
  on("session.end", async () => ({}));
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);
  // Before the first turn every level is dim and only the button is live.
  for (const level of ["low", "medium", "high", "xhigh"]) expect(await levelProps(ui, level)).toEqual({ dimColor: true });
  // `max` lies above the default maxEffort (xhigh): not drawn.
  expect(await levelProps(ui, "max")).toBeUndefined();
  expect(await autoLabel(ui)).toBe("Jev auto: on");

  await drain($.turn.step(step));
  await clock.settle();
  expect(await levelProps(ui, "high")).toEqual({ bold: true });
  expect(await levelProps(ui, "low")).toEqual({ color: "blue" });
  for (const level of ["medium", "xhigh"]) expect(await levelProps(ui, level)).toEqual({ dimColor: true });

  // /clear (session.end) drops the previous chat's efforts from the band.
  await $.session.end({ reason: "clear", sessionId: SID, resume: { id: SID } });
  await clock.settle();
  for (const level of ["low", "medium", "high", "xhigh"]) expect(await levelProps(ui, level)).toEqual({ dimColor: true });
  await ui.unmount();
});

test("The band shows only the configured range plus a session effort outside it", { options: { minEffort: "medium", maxEffort: "high" } }, async ($, on) => {
  const { clock } = setup(on, { messages: [user("what does this project do?")], jev: byId({ effort: easy }) });
  claudeBeneath(on, []);
  sessionStubs(on);
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);
  for (const level of ["low", "xhigh", "max"]) expect(await levelProps(ui, level)).toBeUndefined();
  for (const level of ["medium", "high"]) expect(await levelProps(ui, level)).toEqual({ dimColor: true });

  await drain($.turn.step(turnStep("t1", "claude-opus-5-5", "max")));
  await clock.settle();
  expect(await levelProps(ui, "max")).toEqual({ bold: true });
  expect(await levelProps(ui, "xhigh")).toBeUndefined();
  await ui.unmount();
});

test("The Auto button turns the effort choice off until pressed again", async ($, on) => {
  const seen: { effort?: string }[] = [];
  const { sent, clock } = setup(on, { messages: [user("what does this project do?")], jev: byId({ effort: easy }) });
  claudeBeneath(on, seen);
  sessionStubs(on);
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);

  await ui.press({ key: "auto" });
  await clock.settle();
  expect(await autoLabel(ui)).toBe("Jev auto: off");
  await drain($.turn.step(turnStep("t1", "claude-opus-5-5", "high")));
  await clock.settle();
  // No estimate: the turn runs at the session effort, shown bold with no blue choice.
  expect(sent).toHaveLength(0);
  expect(seen.map((s) => s.effort)).toEqual(["high"]);
  expect(await levelProps(ui, "high")).toEqual({ bold: true });
  expect(await levelProps(ui, "low")).toEqual({ dimColor: true });
  expect(await runJev($, "")).toContain("Jev pilot: routing effort (effort auto off), take steps");

  await ui.press({ key: "auto" });
  await clock.settle();
  expect(await autoLabel(ui)).toBe("Jev auto: on");
  await drain($.turn.step(turnStep("t2", "claude-opus-5-5", "high")));
  expect(ids(sent)).toEqual(["effort", "mechanical"]);
  expect(seen.map((s) => s.effort)).toEqual(["high", "low"]);
  expect(await runJev($, "")).not.toContain("(effort auto off)");

  // A new session turns Auto back on.
  await ui.press({ key: "auto" });
  await clock.settle();
  expect(await autoLabel(ui)).toBe("Jev auto: off");
  await $.session.start(START);
  await clock.settle();
  expect(await autoLabel(ui)).toBe("Jev auto: on");
  await ui.unmount();
});

test("The band passes before the session baseline and while jevfort is inactive", async ($, on) => {
  const { clock } = setup(on, { messages: [], tools: SINGLE_TOOLS, jev: () => undefined });
  sessionStubs(on);
  on("ui.render", () => BENEATH);
  const ui = await $.ui.mount(BAND);
  expect(await ui.find({ type: "Text", text: "beneath" })).toBeDefined();
  expect(await autoLabel(ui)).toBeUndefined();
  await $.session.start(START);
  await clock.settle();
  expect(await ui.find({ type: "Text", text: "beneath" })).toBeDefined();
  expect(await autoLabel(ui)).toBeUndefined();
  await ui.unmount();
});

test("The band passes while a survey holds it", async ($, on) => {
  setup(on, { messages: [], jev: () => undefined });
  sessionStubs(on);
  on("ui.render", () => BENEATH);
  await $.session.start(START);
  const survey = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true } });
  expect(await survey.find({ type: "Text", text: "beneath" })).toBeDefined();
  expect(await autoLabel(survey)).toBeUndefined();
  await survey.unmount();
  const ui = await $.ui.mount(BAND);
  expect(await autoLabel(ui)).toBe("Jev auto: on");
  await ui.unmount();
});

test("With routing off the band passes", { options: { routing: "off" } }, async ($, on) => {
  setup(on, { messages: [], jev: () => undefined });
  sessionStubs(on);
  on("ui.render", () => BENEATH);
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);
  expect(await ui.find({ type: "Text", text: "beneath" })).toBeDefined();
  expect(await autoLabel(ui)).toBeUndefined();
  await ui.unmount();
});

// JJ tests (round 7a).
test("the done check's jev-api call gets the interactive 4 s timeout", { options: { classify: false } }, async ($, on) => {
  const { sent } = setup(on, { messages: [user("rename foo to bar in all files")], jev: unfinished, env: { TYPESAFE_API_KEY: "k" } });
  followUps(on);
  await $.turn.complete(answered("t1", "I renamed it in one file."));
  expect(sent.map((q) => q.timeout)).toEqual([4]);
});

test("the prompt classifier's jev-api call gets the interactive 4 s timeout", async ($, on) => {
  const { sent } = setup(on, { messages: [user("x")], jev: () => undefined, env: { TYPESAFE_API_KEY: "k" } });
  on("command.list", () => ({ value: [] }));
  on("prompt.submit", (_$, e) => ({ text: e.text }));
  await $.prompt.submit({ text: "fix the failing date test", wait: false, origin: { kind: "composer" } });
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.every((q) => q.timeout === 4)).toBe(true);
});

test("a blank Jev variable counts as unset, as in jev-api: Haiku budget and timeout 14", async ($, on) => {
  const seen: unknown[] = [];
  const { sent } = setup(on, { messages: [user("what does this project do?")], jev: () => undefined, env: { TYPESAFE_API_KEY: "  ", JEV_URL: " " } });
  claudeBeneath(on, seen);
  await drain($.turn.step(step));
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.every((q) => q.timeout === 14)).toBe(true);
});

test("a settings env change between turns counts from the next turn, also after the done check read the env", async ($, on) => {
  const env: Record<string, string> = {};
  const { sent } = setup(on, { messages: [user("what does this project do?"), { role: "assistant", text: "It does X.", toolUses: [] }], jev: () => undefined, env });
  on("command.list", () => ({ value: [] }));
  on("session.usage", () => ({ value: { context: { percent: 10 } } }));
  on("turn.complete", () => ({}));
  on("prompt.submit", () => ({ value: {} }));
  await $.turn.complete(answered("t1", "It does X."));
  expect(sent.at(-1)?.timeout).toBe(14);
  env.JEV_URL = "https://jev.example/x";
  await $.prompt.submit({ text: "fix the failing date test", wait: false, origin: { kind: "composer" } });
  expect(sent.at(-1)?.timeout).toBe(4);
});

// Context-fill compaction: from taskCompactPercent the first judged task end compacts, from forceCompactPercent any turn end does.
const finished = byId({ done: { type: "noul", noul: 0.9 }, end: { type: "noul", noul: 0.9 } });
const intermediate = byId({ done: { type: "noul", noul: 0.9 }, end: { type: "noul", noul: 0.1 } });

/** Stubs `/compact` and the context fill (`state.percent`, writable); returns the `/compact` run count. `pending`: `/compact` stays queued (never runs). */
function compactStubs(on: On, percent: number, pending = false) {
  const state = { compacts: 0, percent };
  on("session.usage", () => ({ value: { context: { tokens: 1, window: 100, percent: state.percent } } }));
  on("command.run", (_$, e, next) => {
    if (e.command !== "compact") return next(e);
    state.compacts++;
    return pending ? new Promise<never>(() => {}) : { value: undefined };
  });
  return state;
}

for (const [percent, jev, runs, label] of [[85, finished, 1, "a task end"], [85, intermediate, 0, "an intermediate result"], [70, finished, 0, "a task end below 80%"], [96, intermediate, 1, "an intermediate result at 95%"]] as const) {
  test(`Context at ${percent}% after ${label}: /compact runs ${runs}x`, { options: { classify: false } }, async ($, on) => {
    setup(on, { messages: [user("rename foo to bar")], jev });
    followUps(on);
    const state = compactStubs(on, percent);
    await $.turn.complete(answered("t1", "Done."));
    expect(state.compacts).toBe(runs);
  });
}

// F03: the done check and the task end share one request and one transcript read.
for (const [percent, ids] of [[85, ["done", "end"]], [30, ["done"]]] as const) {
  test(`Turn end at ${percent}% fill: one batch call (${ids.join("+")}), one transcript read`, { options: { classify: false } }, async ($, on) => {
    const { sent, calls, reads } = setup(on, { messages: [user("rename foo to bar")], jev: finished });
    followUps(on);
    compactStubs(on, percent);
    await $.turn.complete(answered("t1", "Done."));
    expect(sent.map((q) => q.id)).toEqual(ids);
    expect(calls()).toBe(1);
    expect(reads()).toBe(1);
  });
}

test("A failed done+end call at 85% fill sends no second request and queues no compaction", { options: { classify: false } }, async ($, on) => {
  const { calls } = setup(on, { messages: [user("rename foo to bar")], jev: () => ({ __deny: "batch: HTTP 503" }) });
  followUps(on);
  const state = compactStubs(on, 85);
  await $.turn.complete(answered("t1", "Done."));
  expect(calls()).toBe(1);
  expect(state.compacts).toBe(0);
});

test("Turn end at 96% fill asks only the done question and still compacts", { options: { classify: false } }, async ($, on) => {
  const { sent } = setup(on, { messages: [user("rename foo to bar")], jev: intermediate });
  followUps(on);
  const state = compactStubs(on, 96);
  await $.turn.complete(answered("t1", "Done."));
  expect(sent.map((q) => q.id)).toEqual(["done"]);
  expect(state.compacts).toBe(1);
});

// F07: facts that do not change within a turn are read from the engine once per turn.
test("A turn reads the project, env and lists once, the cwd once per step and the transcript once per hook", async ($, on) => {
  const ops: Record<string, number> = {};
  for (const ev of ["env.get", "fs.exists", "fs.read", "session.cwd", "session.messages", "command.list", "tool.list", "store.get"]) {
    on(ev, (_$, e, next) => {
      const key = ev === "store.get" ? `store.get ${String(e.key)}` : ev;
      ops[key] = (ops[key] ?? 0) + 1;
      return next(e);
    });
  }
  setup(on, { messages: [user("what does src/app.ts export?")], files: [`${CWD}/src/app.ts`], packageJson: { scripts: { test: "vitest" } }, jev: () => undefined, env: { TYPESAFE_API_KEY: "k" } });
  on("command.list", () => ({ value: [{ name: "export-check", description: "Check what a module exports", source: "user" }] }));
  on("prompt.submit", () => ({ value: {} }));
  claudeBeneath(on, []);
  await $.prompt.submit({ text: "what does src/app.ts export?", wait: false, origin: { kind: "composer" } });
  const perHook: Record<string, number>[] = [];
  let before = { ...ops };
  for (const index of [0, 1, 2]) {
    await drain($.turn.step({ ...step, index }));
    perHook.push(Object.fromEntries(Object.entries(ops).map(([k, v]) => [k, v - (before[k] ?? 0)])));
    before = { ...ops };
  }
  // Step 0 reads the transcript once (no second read for the previous reply).
  expect(perHook[0]["session.messages"]).toBe(1);
  // Later steps probe no project file and read the cwd once (a mid-turn `cd` can move it).
  for (const k of [1, 2]) for (const ev of ["fs.exists", "fs.read"]) expect(perHook[k][ev] ?? 0).toBe(0);
  for (const k of [1, 2]) expect(perHook[k]["session.cwd"]).toBe(1);
  // Once per turn: the three env values, the command list, the skill blocklist, the tool listing; the cwd once per step.
  expect(ops["env.get"]).toBe(3);
  expect(ops["command.list"]).toBe(1);
  expect(ops["store.get skillBlocklist"]).toBe(1);
  expect(ops["tool.list"]).toBe(1);
  expect(ops["session.cwd"]).toBe(3);
});

test("A done follow-up at 85% fill queues no compaction", { options: { classify: false } }, async ($, on) => {
  const { calls } = setup(on, { messages: [user("rename foo to bar")], jev: byId({ done: { type: "noul", noul: 0 }, end: { type: "noul", noul: 0.9 } }) });
  const submitted = followUps(on);
  const state = compactStubs(on, 85);
  await $.turn.complete(answered("t1", "Half done."));
  expect(submitted).toHaveLength(1);
  expect(state.compacts).toBe(0);
  expect(calls()).toBe(1);
});

test("Context compaction is queued once while it waits to run", { options: { classify: false } }, async ($, on) => {
  setup(on, { messages: [user("rename foo to bar")], jev: finished });
  followUps(on);
  const state = compactStubs(on, 85, true);
  await $.turn.complete(answered("t1", "Done."));
  await $.turn.complete(answered("t2", "Done."));
  expect(state.compacts).toBe(1);
});

// The live engine (2.1.325) bypasses jevfort's session.compact hook: the ran /compact itself must re-arm the next one.
test("A /compact that ran without the session.compact hook lets a later high fill compact again", { options: { classify: false } }, async ($, on) => {
  const { clock } = setup(on, { messages: [user("rename foo to bar")], jev: intermediate });
  followUps(on);
  const state = compactStubs(on, 96);
  await $.turn.complete(answered("t1", "Done."));
  await clock.advance(0);
  state.percent = 10;
  await $.turn.complete(answered("t2", "Done."));
  state.percent = 97;
  await $.turn.complete(answered("t3", "Done."));
  expect(state.compacts).toBe(2);
});

test("A refused /compact lets a later high fill compact again and is logged", { options: { classify: false } }, async ($, on) => {
  const { clock } = setup(on, { messages: [user("rename foo to bar")], jev: intermediate });
  followUps(on);
  let compacts = 0;
  on("session.usage", () => ({ value: { context: { tokens: 1, window: 100, percent: 96 } } }));
  on("command.run", (_$, e, next) => {
    if (e.command !== "compact") return next(e);
    compacts++;
    throw new Error("compaction disabled");
  });
  await $.turn.complete(answered("t1", "Done."));
  await clock.advance(0);
  await $.turn.complete(answered("t2", "Done."));
  expect(compacts).toBe(2);
  expect(await runJev($, "")).toContain("context compaction refused");
});

// F06: decisions are buffered and the log and the counters are written once per turn, not once per decision.
test("A 6-step turn writes the log and the counters once, and /jev export still holds every decision", async ($, on) => {
  const sets: string[] = [];
  on("store.set", (_$, e, next) => (sets.push(String(e.key)), next(e)));
  setup(on, { messages: [user("what does src/app.ts export?")], files: [`${CWD}/src/app.ts`], jev: finished });
  followUps(on);
  claudeBeneath(on, []);
  let written = "";
  on("fs.write", (_$, e) => ((written = String(e.text)), { value: undefined }));
  await $.prompt.submit({ text: "what does src/app.ts export?", wait: false, origin: { kind: "composer" } });
  for (const index of [0, 1, 2, 3, 4, 5]) await drain($.turn.step({ ...step, index }));
  expect(sets).toEqual([]);
  await $.turn.complete(answered("t1", "Done."));
  expect(sets.filter((k) => k === "log")).toHaveLength(1);
  expect(sets.filter((k) => k === "stats")).toHaveLength(1);
  expect(await runJev($, "export")).toMatch(/wrote \d+ entries/);
  const kinds = written.trim().split("\n").map((l) => (JSON.parse(l) as { kind: string }).kind);
  expect(kinds).toContain("classify");
  expect(kinds).toContain("route");
  expect(kinds.filter((k) => k === "compare")).toHaveLength(6);
  expect(kinds).toContain("done");
  expect(await runJev($, "")).toMatch(/compare(:pass)?=6/);
});

test("session.end writes the decisions recorded outside a turn", { options: { minEffort: "high", maxEffort: "low" } }, async ($, on) => {
  const logs: { kind: string; text: string }[][] = [];
  on("store.set", (_$, e, next) => (e.key === "log" && logs.push(e.value as { kind: string; text: string }[]), next(e)));
  setup(on, { messages: [], jev: () => undefined });
  on("command.register", async () => ({ value: undefined }));
  on("tool.register", async () => ({ value: { tool: "mcp__jevfort__estimate_effort" } }));
  on("session.start", async () => ({}));
  on("session.end", async () => ({}));
  await $.session.start({ cwd: CWD, surface: "terminal", isInteractive: true });
  expect(logs).toEqual([]);
  await $.session.end({ reason: "clear", sessionId: SID, resume: { id: SID } });
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContainEqual(expect.objectContaining({ kind: "error", text: expect.stringContaining("invalid effort bounds") }));
});

/** A `store.get("log")` stub above `mock.store` that reads first and then waits for `release()`: the read goes stale while a write is in flight. */
function gatedLog(on: On, logs: unknown[][]) {
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  on("store.get", async (_$, e, next) => {
    const r = await next(e);
    if (e.key === "log") await gate;
    return r;
  });
  on("store.set", (_$, e, next) => (e.key === "log" && logs.push(e.value as unknown[]), next(e)));
  return { release, settle: () => new Promise((r) => setTimeout(r, 20)) };
}

/** Lets `session.start`/`session.end` and their registrations pass. */
const lifecycle = (on: On) => {
  on("command.register", async () => ({ value: undefined }));
  on("tool.register", async () => ({ value: { tool: "mcp__jevfort__estimate_effort" } }));
  on("session.start", async () => ({}));
  on("session.end", async () => ({}));
};

test("/jev clear waits for an in-flight flush instead of having it write the log back", { options: { minEffort: "high", maxEffort: "low" } }, async ($, on) => {
  const logs: unknown[][] = [];
  const g = gatedLog(on, logs);
  setup(on, { messages: [], jev: () => undefined });
  lifecycle(on);
  await $.session.start({ cwd: CWD, surface: "terminal", isInteractive: true });
  const end = $.session.end({ reason: "clear", sessionId: SID, resume: { id: SID } });
  await g.settle();
  const cleared = runJev($, "clear");
  await g.settle();
  g.release();
  await end;
  expect(await cleared).toBe("Jev pilot: log cleared.");
  expect(logs.at(-1)).toEqual([]);
});

test("/jev clear and /clear (session.end) empty the /jev Recent list", { options: { minEffort: "high", maxEffort: "low" } }, async ($, on) => {
  setup(on, { messages: [], jev: () => undefined });
  lifecycle(on);
  await $.session.start({ cwd: CWD, surface: "terminal", isInteractive: true });
  expect(await runJev($, "")).toContain("invalid effort bounds");
  await runJev($, "clear");
  expect(await runJev($, "")).toContain("No decisions this session yet.");
  await $.session.start({ cwd: CWD, surface: "terminal", isInteractive: true });
  expect(await runJev($, "")).toContain("invalid effort bounds");
  await $.session.end({ reason: "clear", sessionId: SID, resume: { id: SID } });
  expect(await runJev($, "")).toContain("No decisions this session yet.");
});

test("A flush started while another is in flight keeps both flushes' entries", { options: { minEffort: "high", maxEffort: "low" } }, async ($, on) => {
  const logs: unknown[][] = [];
  const g = gatedLog(on, logs);
  setup(on, { messages: [], jev: () => undefined });
  lifecycle(on);
  await $.session.start({ cwd: CWD, surface: "terminal", isInteractive: true });
  const end = $.session.end({ reason: "clear", sessionId: SID, resume: { id: SID } });
  await g.settle();
  await $.session.start({ cwd: CWD, surface: "terminal", isInteractive: true });
  const status = runJev($, "");
  await g.settle();
  g.release();
  await end;
  await status;
  expect(logs.at(-1)).toHaveLength(2);
});

test("/jev export with nothing pending waits for another hook's flush still in flight", { options: { minEffort: "high", maxEffort: "low" } }, async ($, on) => {
  const g = gatedLog(on, []);
  setup(on, { messages: [], jev: () => undefined });
  lifecycle(on);
  on("fs.write", () => ({ value: undefined }));
  await $.session.start({ cwd: CWD, surface: "terminal", isInteractive: true });
  const end = $.session.end({ reason: "clear", sessionId: SID, resume: { id: SID } });
  await g.settle();
  const exported = runJev($, "export");
  await g.settle();
  g.release();
  await end;
  expect(await exported).toMatch(/wrote 1 entries/);
});

test("An inactive turn.complete writes the decisions pending from the turn", async ($, on) => {
  const sets: string[] = [];
  on("store.set", (_$, e, next) => (sets.push(String(e.key)), next(e)));
  setup(on, { messages: [user("rename foo to bar")], tools: SINGLE_TOOLS, jev: () => undefined });
  followUps(on);
  expect(await estimateCall($)).toEqual({ result: JSON.stringify({ effort: "high", source: "fallback" }) });
  expect(sets).toEqual([]);
  await $.turn.complete(answered("t1", "Done."));
  expect(sets.filter((k) => k === "log")).toHaveLength(1);
});
