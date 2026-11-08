// Hook-wiring tests for the built plugin/hooks/register.mjs: a port of upstream jev-pilot's tests/pilot.test.ts onto
// claude-engine-vitest (types dropped, `expect` from vitest, `test`/`mock` from createKit). Upstream's "shadow mode
// logs a take but lets Claude act" is gone with the mode; its shadow compare test runs on the measure path instead.
import { createKit } from "claude-engine-vitest";
import type { On } from "claude-engine-vitest";
import { expect } from "vitest";

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
const DEFAULT_URL = "https://api.typesafe.ai/v1/systemone";
const SID = "sid-1";

type Jev = (questions: Record<string, unknown>) => Record<string, unknown> | number;
type Msg = { role: "user" | "assistant"; text: string; toolUses: Record<string, unknown>[]; toolResults?: Record<string, unknown>[] };
type Chunk = { kind: string; [k: string]: unknown };
/** The test's `$` (the kit does not export its type): `$.<ns>.<event>` fires an event. */
type Runner = Parameters<Parameters<typeof test>[2]>[0];

// Answers every call the mod makes on `$`, with Jev's answers from `jev` (a number is an HTTP error status).
function setup(on: On, opts: { messages: Msg[]; jev: Jev; files?: string[]; packageJson?: object; env?: Record<string, string>; agents?: { status: string }[]; store?: Record<string, unknown> }) {
  const sent: Record<string, unknown>[] = [];
  const urls: string[] = [];
  mock.env(on, { TYPESAFE_API_KEY: "test-key", ...opts.env });
  mock.store(on, opts.store ?? {});
  mock.clock(on);
  on("session.messages", () => ({ value: [...opts.messages] }));
  on("session.cwd", () => ({ value: CWD }));
  on("session.id", () => ({ value: SID }));
  on("fs.exists", (_$, e) => ({ value: Boolean(opts.packageJson) && e.path === `${CWD}/package.json` }));
  on("fs.stat", (_$, e) => ((opts.files ?? []).includes(String(e.path)) ? { value: { kind: "file", size: 100, mtimeMs: 0, isLink: false } } : { deny: "ENOENT" }));
  on("fs.read", (_$, e) => (opts.packageJson && e.path === `${CWD}/package.json` ? { value: JSON.stringify(opts.packageJson) } : { deny: "ENOENT" }));
  on("ui.status", () => ({ value: undefined }));
  on("agent.list", () => ({ value: opts.agents ?? [] }));
  on("http.fetch", (_$, e) => {
    urls.push(String(e.url));
    const body = JSON.parse(String((e.init as { body?: string } | undefined)?.body ?? "{}")) as { questions: Record<string, unknown> };
    sent.push(body);
    const answers = opts.jev(body.questions);
    if (typeof answers === "number") return { value: { status: answers, ok: false, headers: {}, text: "{}" } };
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ model: "jev-1", answers }) } };
  });
  return { sent, urls };
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

// A Jev score answer; a mechanical (noul) answer; the question ids of the i-th Jev request; Jev answers in request order (the last repeats, a number is an HTTP error status).
const scored = (score: number, confidence = 0.9) => ({ type: "score", score, probabilities: {}, confidence });
const mech = (p: number) => ({ type: "noul", noul: p });
const questionKeys = (sent: Record<string, unknown>[], i: number) => Object.keys((sent[i] as { questions: object }).questions);
const inOrder = (...answers: (Record<string, unknown> | number)[]): Jev => {
  let n = 0;
  return () => answers[Math.min(n++, answers.length - 1)];
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

test("Jev takes a confident Read step without asking Claude", { options: { takeOnlyForBypass: false } }, async ($, on) => {
  const seen: unknown[] = [];
  setup(on, {
    messages: [user("what does src/app.ts export?")],
    files: [`${CWD}/src/app.ts`],
    jev: () => ({
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

test("An unsure Jev hands the step to Claude, with effort lowered for an easy turn", async ($, on) => {
  const seen: unknown[] = [];
  setup(on, {
    messages: [user("what does src/app.ts export?")],
    files: [`${CWD}/src/app.ts`],
    jev: () => ({
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

test("model routing moves a trivial turn to Haiku", { options: { routing: "model" } }, async ($, on) => {
  const seen: unknown[] = [];
  setup(on, { messages: [user("hi, what time zone is UTC+2?")], jev: () => ({ difficulty: easy, effort: easy }) });
  claudeBeneath(on, seen);

  await drain($.turn.step(step));
  expect(seen[0]).toMatchObject({ effort: "low", model: "claude-haiku-5-5" });
});

test("When Jev is unreachable the step goes to Claude unchanged", async ($, on) => {
  const seen: unknown[] = [];
  setup(on, { messages: [user("what does src/app.ts export?")], files: [`${CWD}/src/app.ts`], jev: () => 401 });
  claudeBeneath(on, seen);

  const { chunks } = await drain($.turn.step(step));
  expect(seen[0]).toMatchObject({ effort: "high", model: "claude-opus-5-5" });
  expect(chunks).toContainEqual({ kind: "text", index: 0, text: "from claude" });
});

// What the engine does for a plugin's own `$.prompt.submit`: the hooks see it stamped with the plugin as origin (the kit stamps none).
const FOLLOW_UP = "Jev: the user's request doesn't look finished yet. Continue with what remains. If it is actually complete, say so in one line.";
const ownSubmit = ($: Runner, text = FOLLOW_UP) => $.prompt.submit({ text, wait: false, origin: { kind: "plugin", name: "jevfort" } });
const userSubmit = ($: Runner, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: "composer" } });

test("The done check sends Claude back once when work is unfinished", { options: { classify: false } }, async ($, on) => {
  const { sent } = setup(on, { messages: [user("rename foo to bar in all files")], jev: () => ({ done: { type: "noul", noul: 0.04 } }) });
  const submitted = followUps(on);

  await $.turn.complete(answered("t1", "I renamed it in one file. Want me to do the rest?"));
  await expect.poll(() => submitted.length).toBe(1);
  expect(submitted[0]).toContain("doesn't look finished yet");
  expect(sent).toHaveLength(1);
  expect(Object.keys((sent[0] as { questions: object }).questions)).toEqual(["done"]);

  // The follow-up turn is exempt: no second Jev request, no second follow-up.
  await ownSubmit($);
  await $.turn.complete(answered("t2", "Done."));
  expect(sent).toHaveLength(1);
  expect(submitted).toHaveLength(2);

  // The exemption is used up: the next turn is checked again.
  await $.turn.complete(answered("t3", "Done."));
  expect(sent).toHaveLength(2);
});

test("A user pasting the follow-up text neither arms nor consumes the exemption", { options: { classify: false } }, async ($, on) => {
  const { sent } = setup(on, { messages: [user("rename foo to bar in all files")], jev: () => ({ done: { type: "noul", noul: 0.04 } }) });
  followUps(on);
  await userSubmit($, FOLLOW_UP);
  await $.turn.complete(answered("t1", "One file only."));
  expect(sent).toHaveLength(1);
});

test("A user turn between the follow-up and its turn clears the exemption", { options: { classify: false } }, async ($, on) => {
  const { sent } = setup(on, { messages: [user("rename foo to bar in all files")], jev: () => ({ done: { type: "noul", noul: 0.04 } }) });
  followUps(on);
  await ownSubmit($);
  await userSubmit($, "actually, also rename baz");
  await $.turn.complete(answered("t1", "Renamed."));
  expect(sent).toHaveLength(1);
});

test("A follow-up that failed to submit exempts nothing", { options: { classify: false } }, async ($, on) => {
  const { sent } = setup(on, { messages: [user("rename foo to bar in all files")], jev: () => ({ done: { type: "noul", noul: 0.04 } }) });
  on("turn.complete", () => ({ text: "" }));
  on("prompt.submit", () => {
    throw new Error("rejected");
  });
  await $.turn.complete(answered("t1", "One file only."));
  await expect.poll(() => sent.length).toBe(1);
  // The submit was rejected, so the next turn is checked again, and logs the lost follow-up in its own frame.
  await $.turn.complete(answered("t2", "Still one file."));
  expect(sent).toHaveLength(2);
  expect(await runJev($, "")).toContain("done follow-up not sent");
});

test("A meta prompt between the follow-up and its turn keeps the exemption", { options: { classify: false } }, async ($, on) => {
  const { sent } = setup(on, { messages: [user("rename foo to bar in all files")], jev: () => ({ done: { type: "noul", noul: 0.04 } }) });
  followUps(on);
  await ownSubmit($);
  await $.prompt.submit({ text: "<task-notification>done</task-notification>", wait: false, isMeta: true, origin: { kind: "system" } });
  await $.turn.complete(answered("t1", "Done."));
  expect(sent).toHaveLength(0);
});

test("A user message quoting the follow-up text stays the scored request", { options: { classify: false } }, async ($, on) => {
  const { sent } = setup(on, { messages: [user(`${FOLLOW_UP} Also rename baz.`)], jev: () => ({ done: { type: "noul", noul: 0.9 } }) });
  followUps(on);
  await $.turn.complete(answered("t1", "Renamed."));
  expect((sent[0] as { state: { request: string } }).state.request).toContain("rename baz");
});

for (const [status, asked] of [["completed", 1], ["failed", 1], ["killed", 1], ["idle", 1], ["running", 0], ["pending", 0], ["starting", 0]] as const) {
  test(`The done check with a ${status} subagent asks Jev ${asked} time(s)`, async ($, on) => {
    const { sent } = setup(on, { messages: [user("rename foo to bar in all files")], jev: () => ({ done: { type: "noul", noul: 0.04 } }), agents: [{ status }] });
    followUps(on);
    await $.turn.complete(answered("t1", "One file only."));
    expect(sent).toHaveLength(asked);
  });
}

test("The done check skips subagent turns", async ($, on) => {
  const { sent } = setup(on, { messages: [user("rename foo to bar in all files")], jev: () => ({ done: { type: "noul", noul: 0.04 } }) });
  const submitted = followUps(on);

  await $.turn.complete(answered("t1", "I renamed it in one file.", { agentId: "a1" }));
  expect(sent).toHaveLength(0);
  expect(submitted).toHaveLength(0);
});

// Jev's own calls skip auto mode's classifier: the mod approves them itself, but a settings deny rule beneath still wins.
for (const [beneath, expected] of [["ask", "allow"], ["deny", "deny"]] as const) {
  test(`A call Jev made itself is approved over "${beneath}" → ${expected}`, { options: { takeOnlyForBypass: false } }, async ($, on) => {
    setup(on, {
      messages: [user("what does src/app.ts export?")],
      jev: () => ({
        next_action: { type: "choice", choice: "read src/app.ts", probabilities: { "read src/app.ts": 0.97, claude: 0.03 }, confidence: 0.95 },
        difficulty: easy,
      }),
      files: [`${CWD}/src/app.ts`],
    });
    claudeBeneath(on, []);
    on("tool.check", () => ({ decision: beneath }));

    const { chunks } = await drain($.turn.step(step));
    const id = toolId(chunks);
    expect(id).not.toBe("");

    expect(await decision($, { tool: "Read", input: { file_path: `${CWD}/src/app.ts` }, tool_use_id: id })).toBe(expected);

    // Claude's own call to the same tool is left to the engine.
    expect(await decision($, { tool: "Read", input: { file_path: `${CWD}/src/app.ts` }, tool_use_id: "toolu_claude" })).toBe(beneath);
  });
}

// Phase 2: every decision is logged, and Claude's own call is compared with Jev's.
test("Inside a longer turn Jev's measured top action is compared with Claude's call and reported as agreement", async ($, on) => {
  setup(on, {
    messages: [user("what does src/app.ts export?")],
    files: [`${CWD}/src/app.ts`],
    jev: () => ({
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

test("Passes are logged too: a \"claude\" pick, an unchanged route", { options: { routing: "model" } }, async ($, on) => {
  setup(on, {
    messages: [user("refactor the auth module to use JWT")],
    files: [],
    jev: () => ({ difficulty: { type: "score", score: 2.6, probabilities: { "0": 0, "1": 0.05, "2": 0.3, "3": 0.65 }, confidence: 0.6 } }),
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
    jev: () => ({
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
  on("tool.list", () => ({ value: [] }));
  claudeBeneath(on, []);

  const { chunks } = await drain($.turn.step(step));
  expect(chunks).toContainEqual(expect.objectContaining({ kind: "tool", name: "Skill" }));
  expect(chunks).toContainEqual({ kind: "input", index: 0, json: JSON.stringify({ skill: "write-release-notes" }) });
});

test("Bash commands and edits are not gated", async ($, on) => {
  const { sent } = setup(on, {
    messages: [user("fix the typo in README.md")],
    jev: () => ({ in_scope: { type: "noul", noul: 0.03 } }),
  });
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
    setup(on, { messages: [user("anything")], jev: () => ({}), env: c.env });
    on("tool.check", () => ({ decision: c.beneath }));

    expect(await decision($, { tool: c.tool, input: { [c.key]: c.path }, tool_use_id: "toolu_sp" })).toBe(c.expected);
  });
}

test("A settings ask rule beats the scratchpad allow", async ($, on) => {
  setup(on, { messages: [user("anything")], jev: () => ({}) });
  on("tool.check", () => ({ decision: "ask", rule: "Write(/tmp/**)" }));
  expect(await decision($, { tool: "Write", input: { file_path: `${SP}/x` }, tool_use_id: "toolu_sp4" })).toBe("ask");
});

// Phase 3: a simple request is answered by Jev's action plus a small-model summary.
for (const [single, expectBypass] of [[0.95, true], [0.3, false]] as const) {
  test(`Whole-turn bypass ${expectBypass ? "answers" : "does not answer"} when single_action=${single}`, async ($, on) => {
    const messages: Msg[] = [user("run the tests")];
    const seen: unknown[] = [];
    setup(on, {
      messages,
      packageJson: { scripts: { test: "node --test" } },
      jev: () => ({
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
      const options = Object.keys((q.next_action as { criteria?: object } | undefined)?.criteria ?? {});
      offered.push(options);
      return {
        next_action: { type: "choice", choice: "skill changelog", probabilities: { "skill changelog": 0.95, claude: 0.05 }, confidence: 0.9 },
        difficulty: easy,
      };
    },
  });
  on("command.list", () => ({
    value: [
      { name: "diff", description: "View uncommitted changes", source: "user" },
      { name: "changelog", description: "Summarize recent changes", source: "plugin" },
    ],
  }));
  on("tool.list", () => ({ value: [] }));
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
    jev: () => ({ done: { type: "noul", noul: 0.02 } }),
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
    jev: () => ({
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
  expect(Object.keys((sent[0] as { questions: object }).questions)).toEqual(["next_action"]);
});

test("Effort lowered at step 0 holds for the later steps of the turn", async ($, on) => {
  const seen: { effort?: string }[] = [];
  setup(on, { messages: [user("what does this project do?")], jev: () => ({ difficulty: easy, effort: easy }) });
  claudeBeneath(on, seen);
  await drain($.turn.step(step));
  await drain($.turn.step({ ...step, index: 1 }));
  expect(seen.map((s) => s.effort)).toEqual(["low", "low"]);
});

test("Effort routing sees the reply a short follow-up answers", async ($, on) => {
  const { sent } = setup(on, {
    messages: [user("add a sync layer"), { role: "assistant", text: "Here is the plan: 1. … Want me to build it?", toolUses: [] }, user("yes")],
    jev: () => ({ difficulty: easy }),
  });
  claudeBeneath(on, []);
  await drain($.turn.step(step));
  const state = (sent[0] as { state: { request: string; previous_reply?: string } }).state;
  expect(state.request).toBe("yes");
  expect(state.previous_reply).toBe("Here is the plan: 1. … Want me to build it?");
});

test("A big job asked at medium effort runs at xhigh, on an older Opus id too", async ($, on) => {
  const seen: { effort?: string }[] = [];
  const hard = { type: "score", score: 2.9, probabilities: {}, confidence: 0.95 };
  setup(on, { messages: [user("migrate the whole app to TypeScript")], jev: () => ({ difficulty: hard, effort: hard }) });
  claudeBeneath(on, seen);
  await drain($.turn.step({ ...step, effort: "medium" }));
  await drain($.turn.step({ ...step, turnId: "t2", model: "claude-opus-5", effort: "medium" }));
  expect(seen.map((s) => s.effort)).toEqual(["xhigh", "xhigh"]);
});

// JEV_URL: the endpoint is read per request; unset or blank means the TypeSafe API, http(s) is accepted for any host.
test("JEV_URL set to an https URL is where the request goes", async ($, on) => {
  const { urls } = setup(on, { messages: [user("what does this project do?")], jev: () => ({ difficulty: easy }), env: { JEV_URL: "https://jev.example.test/v1/x" } });
  claudeBeneath(on, []);
  await drain($.turn.step(step));
  expect(urls).toEqual(["https://jev.example.test/v1/x"]);
});

test("JEV_URL unset means the TypeSafe API", async ($, on) => {
  const { urls } = setup(on, { messages: [user("what does this project do?")], jev: () => ({ difficulty: easy }) });
  claudeBeneath(on, []);
  await drain($.turn.step(step));
  expect(urls).toEqual([DEFAULT_URL]);
});

test("JEV_URL over plain http to a non-loopback host is accepted", async ($, on) => {
  const { urls } = setup(on, { messages: [user("what does this project do?")], jev: () => ({ difficulty: easy }), env: { JEV_URL: "http://jev.example.test/v1/x" } });
  claudeBeneath(on, []);
  await drain($.turn.step(step));
  expect(urls).toEqual(["http://jev.example.test/v1/x"]);
});

test("JEV_URL with another scheme sends nothing, logs a Jev error and leaves the step to Claude", async ($, on) => {
  const seen: unknown[] = [];
  const { urls } = setup(on, { messages: [user("what does this project do?")], jev: () => ({ difficulty: easy }), env: { JEV_URL: "ftp://jev.example.test/x" } });
  claudeBeneath(on, seen);
  await drain($.turn.step(step));
  expect(urls).toEqual([]);
  expect(seen).toHaveLength(1);
  const status = await runJev($, "");
  expect(status).toContain("JEV_URL must be an http(s) URL");
  expect(status).toContain("error (pass)");
});

test("A blank JEV_URL counts as unset", async ($, on) => {
  const { urls } = setup(on, { messages: [user("what does this project do?")], jev: () => ({ difficulty: easy }), env: { JEV_URL: "   " } });
  claudeBeneath(on, []);
  await drain($.turn.step(step));
  expect(urls).toEqual([DEFAULT_URL]);
});

test("There is no mode: a stored legacy mode is ignored and /jev off is no command", async ($, on) => {
  const seen: unknown[] = [];
  const { urls } = setup(on, { messages: [user("what does this project do?")], jev: () => ({ difficulty: easy }), store: { mode: "off" } });
  claudeBeneath(on, seen);
  const status = await runJev($, "off");
  expect(status).toContain("Jev pilot: routing");
  expect(status).not.toContain("Jev pilot mode");
  // Only the first line: the recent-decisions list is module state shared across tests and may mention a model.
  expect(status.split("\n")[0]).not.toContain("mode");
  await drain($.turn.step(step));
  expect(urls).toHaveLength(1);
  expect(seen).toHaveLength(1);
});

// The estimate_effort tool: registered at session.start, answered by the unmatched tool.call hook on every call.
test("session.start registers estimate_effort", async ($, on) => {
  setup(on, { messages: [], jev: () => ({}) });
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
  setup(on, { messages: [], jev: () => ({}) });
  on("command.register", async () => ({ value: undefined }));
  on("tool.register", async () => ({ value: { tool: "mcp__jevfort__estimate_effort" } }));
  on("session.start", async () => ({}));
  await $.session.start({ cwd: CWD, surface: "terminal", isInteractive: true });
  expect(await runJev($, "report")).toContain("1 errors");
});

test("Effort routing does not ask Jev the difficulty question", async ($, on) => {
  const { sent } = setup(on, { messages: [user("what does this project do?")], jev: () => ({ effort: scored(1.6) }) });
  claudeBeneath(on, []);
  await drain($.turn.step(step));
  expect(questionKeys(sent, 0)).not.toContain("difficulty");
});

const ESTIMATE = { tool: "mcp__jevfort__estimate_effort", model: "opus", defaultEffort: "high", minEffort: "low", maxEffort: "xhigh", prompt: "add a retry to the HTTP client" };
const estimateCall = async ($: Runner, input: Record<string, unknown> = {}) => (await $.tool.call({ ...ESTIMATE, ...input })) as { result?: string; isError?: boolean };

test("estimate_effort returns Jev's estimate with the model bias", async ($, on) => {
  const { sent } = setup(on, { messages: [], jev: () => ({ effort: scored(1.6), mechanical: mech(0.1) }) });
  expect(await estimateCall($)).toEqual({ result: JSON.stringify({ effort: "medium", source: "jev" }) });
  expect(questionKeys(sent, 0)).toEqual(["effort", "mechanical"]);
  expect((sent[0] as { state: { request: string } }).state.request).toBe(ESTIMATE.prompt);
});

test("estimate_effort falls back to defaultEffort when Jev is unreachable", async ($, on) => {
  setup(on, { messages: [], jev: () => 401 });
  expect(await estimateCall($)).toEqual({ result: JSON.stringify({ effort: "high", source: "fallback" }) });
  expect(await runJev($, "")).toContain("estimate (pass): opus: high (fallback, HTTP 401)");
});

test("estimate_effort rejects invalid input without asking Jev", async ($, on) => {
  const { sent } = setup(on, { messages: [], jev: () => ({ effort: scored(1.6) }) });
  expect(await estimateCall($, { model: "gpt" })).toEqual({ isError: true, result: "estimate_effort: model must be one of haiku, sonnet, opus, fable" });
  expect(await estimateCall($, { minEffort: "high", maxEffort: "low" })).toEqual({ isError: true, result: "estimate_effort: minEffort must not be above maxEffort" });
  expect(sent).toHaveLength(0);
});

test("estimate_effort estimates on every call, also for haiku", async ($, on) => {
  const { sent } = setup(on, { messages: [], jev: inOrder({ effort: scored(0.2) }, { effort: scored(3), mechanical: mech(0.9) }) });
  expect(await estimateCall($, { model: "haiku" })).toEqual({ result: JSON.stringify({ effort: "medium", source: "jev" }) });
  expect(await estimateCall($, { model: "haiku" })).toEqual({ result: JSON.stringify({ effort: "low", source: "mechanical" }) });
  expect(questionKeys(sent, 0)).toEqual(["effort", "mechanical"]);
  expect(questionKeys(sent, 1)).toEqual(["effort", "mechanical"]);
});

// Turn-start effort estimate: Jev's effort score plus the session model's bias, within minEffort..maxEffort.
test("A mechanical turn runs at minEffort even on a hard score", async ($, on) => {
  const seen: { effort?: string }[] = [];
  setup(on, { messages: [user("rename foo to bar in src/a.ts")], jev: () => ({ difficulty: easy, effort: scored(2.9), mechanical: mech(0.9) }) });
  claudeBeneath(on, seen);
  await drain($.turn.step(step));
  expect(seen.map((s) => s.effort)).toEqual(["low"]);
});

test("maxEffort caps a confident hard estimate", { options: { maxEffort: "medium" } }, async ($, on) => {
  const seen: { effort?: string }[] = [];
  setup(on, { messages: [user("migrate the whole app to TypeScript")], jev: () => ({ difficulty: easy, effort: scored(2.9) }) });
  claudeBeneath(on, seen);
  await drain($.turn.step(step));
  expect(seen.map((s) => s.effort)).toEqual(["medium"]);
});

test("minEffort raises a confident easy estimate", { options: { minEffort: "medium" } }, async ($, on) => {
  const seen: { effort?: string }[] = [];
  setup(on, { messages: [user("what does this project do?")], jev: () => ({ difficulty: easy, effort: scored(0.2) }) });
  claudeBeneath(on, seen);
  await drain($.turn.step(step));
  expect(seen.map((s) => s.effort)).toEqual(["medium"]);
});

test("An inverted minEffort/maxEffort config falls back to low..xhigh", { options: { minEffort: "max", maxEffort: "low" } }, async ($, on) => {
  const seen: { effort?: string }[] = [];
  setup(on, { messages: [user("migrate the whole app to TypeScript")], jev: () => ({ difficulty: easy, effort: scored(2.9) }) });
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
    expect(questionKeys(sent, 0)).toEqual(expect.arrayContaining(["effort", "mechanical"]));
    expect(questionKeys(sent, 1)).toEqual(expect.arrayContaining(["effort", "mechanical"]));
    expect(seen.map((s) => s.effort)).toEqual(["low", "xhigh"]);
  });
}

for (const [model, estimated] of [["claude-haiku-5-5", "medium"], ["claude-fable-5", "low"]] as const) {
  test(`On ${model} only the first turn is estimated and later turns hold it`, async ($, on) => {
    const seen: { effort?: string }[] = [];
    const { sent } = setup(on, { messages: [user("what does this project do?")], jev: inOrder({ difficulty: easy, effort: scored(0.2) }, { difficulty: easy, effort: scored(2.9) }) });
    claudeBeneath(on, seen);
    await drain($.turn.step(turnStep("t1", model, "high")));
    await drain($.turn.step(turnStep("t2", model, "high")));
    expect(questionKeys(sent, 0)).toEqual(expect.arrayContaining(["effort", "mechanical"]));
    // A held turn in effort routing has nothing to ask Jev at step 0.
    expect(sent).toHaveLength(1);
    expect(seen.map((s) => s.effort)).toEqual([estimated, estimated]);
  });
}

test("A held Haiku effort still applies when Jev fails on a later turn", async ($, on) => {
  const seen: { effort?: string }[] = [];
  setup(on, { messages: [user("what does this project do?")], jev: inOrder({ difficulty: easy, effort: scored(0.2) }, 401) });
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
  expect(sent).toHaveLength(1);
  expect(seen.map((s) => s.effort)).toEqual(["xhigh", "medium"]);
});

test("A failed first Haiku turn is not re-asked and later turns keep the session effort", async ($, on) => {
  const seen: { effort?: string }[] = [];
  const { sent } = setup(on, { messages: [user("what does this project do?")], jev: inOrder(401, { difficulty: easy, effort: scored(0.2) }) });
  claudeBeneath(on, seen);
  await drain($.turn.step(turnStep("t1", "claude-haiku-5-5", "high")));
  await drain($.turn.step(turnStep("t2", "claude-haiku-5-5", "high")));
  expect(questionKeys(sent, 0)).toEqual(expect.arrayContaining(["effort", "mechanical"]));
  expect(sent).toHaveLength(1);
  expect(seen.map((s) => s.effort)).toEqual(["high", "high"]);
});

test("A switch from Opus to Haiku starts a new first turn with its own estimate", async ($, on) => {
  const seen: { effort?: string }[] = [];
  const { sent } = setup(on, { messages: [user("what does this project do?")], jev: inOrder({ difficulty: easy, effort: scored(0.2) }, { difficulty: easy, effort: scored(0.2) }) });
  claudeBeneath(on, seen);
  await drain($.turn.step(turnStep("t1", "claude-opus-5-5", "high")));
  await drain($.turn.step(turnStep("t2", "claude-haiku-5-5", "high")));
  await drain($.turn.step(turnStep("t3", "claude-haiku-5-5", "high")));
  expect(questionKeys(sent, 1)).toEqual(expect.arrayContaining(["effort", "mechanical"]));
  expect(sent).toHaveLength(2);
  expect(seen.map((s) => s.effort)).toEqual(["low", "medium", "medium"]);
});
