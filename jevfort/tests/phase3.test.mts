// Phase 3 (prompt classifier, subagent types, compaction) of the built plugin/hooks/*.mjs: upstream jev-pilot
// tests/phase3.test.ts. The pure tests come first; the kit tests follow.
import { createKit } from "claude-engine-vitest";
import type { On } from "claude-engine-vitest";
import { expect, test as pureTest } from "vitest";
import { compactInstructions, compactItems } from "../plugin/hooks/compact.mjs";
import { JEV_BATCH } from "../plugin/hooks/jev.mjs";
import { hints, promptQuestions } from "../plugin/hooks/prompt.mjs";

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
};

const { test, mock } = createKit({ module: new URL("../plugin/hooks/register.mjs", import.meta.url), plugin: "jevfort", options: DEFAULTS });

const CWD = "/proj";

/** The jev-api tool jevfort needs, as `$.tool.list()` lists it. */
const JEV_TOOLS = [{ name: JEV_BATCH, description: "Ask Jev several questions", mcp: true }];
/** The classifier's question ids by their instructions text (batch questions carry no id). */
const PROMPT_IDS = new Map(Object.entries(promptQuestions({ none: "x" })).map(([id, q]) => [q.instructions, id]));

type Msg = { role: "user" | "assistant"; text: string; toolUses: Record<string, unknown>[] };
/** One question of a batch call as the fake saw it; `state` is the call's JSON text. */
type Asked = { type: string; instructions: string; state: string; criteria?: unknown };

/** Lists the batch tool, answers each batch question with `jev`'s answer and stubs the session reads the hooks make; returns the questions. */
function base(on: On, jev: (q: Asked) => Record<string, unknown>, messages: Msg[] = []) {
  const sent: Asked[] = [];
  mock.store(on, {});
  mock.clock(on);
  on("session.cwd", () => ({ value: CWD }));
  on("session.messages", () => ({ value: messages }));
  on("ui.status", () => ({ value: undefined }));
  on("tool.list", () => ({ value: JEV_TOOLS }));
  on("tool.call", (_$, e, next) => {
    if (e.tool !== JEV_BATCH) return next(e);
    const asked = (e.questions as { type: string; instructions: string; criteria?: unknown }[]).map((b): Asked => ({ ...b, state: String(e.state) }));
    sent.push(...asked);
    // A mod's `$.tool.call` resolves to the stub's `value`: the tool result `{ result }`, the answers in question order.
    return { value: { result: JSON.stringify(asked.map((q) => jev(q))) } };
  });
  return sent;
}

pureTest("hints: a mid-confidence skill and a large task get hints; a confident skill is left to step 0", () => {
  expect(hints("task", 0.9, { name: "aws-diagrams", p: 0.7 }, 0.85)).toHaveLength(2);
  expect(hints("question", 0.9, { name: "aws-diagrams", p: 0.95 }, 0.85)).toHaveLength(0);
  // Under takeOnlyForBypass the threshold is infinite, so only the name guard keeps `none` hint-free.
  expect(hints("question", 0, { name: "none", p: 0.7 }, Number.POSITIVE_INFINITY)).toEqual([]);
  expect(hints("question", 0, { name: "deploy-docs", p: 0.7 }, Number.POSITIVE_INFINITY)).toHaveLength(1);
});

test("The prompt classifier adds a hint only Claude reads", async ($, on) => {
  const answers: Record<string, Record<string, unknown>> = {
    kind: { type: "choice", choice: "task", probabilities: { task: 0.9, question: 0.1 }, confidence: 0.8 },
    needs_plan: { type: "noul", noul: 0.93 },
    skill: { type: "choice", choice: "none", probabilities: { none: 0.9 }, confidence: 0.9 },
  };
  const sent = base(on, (q) => answers[PROMPT_IDS.get(q.instructions) ?? ""]);
  // A skill named like an Object.prototype member is offered too.
  on("command.list", () => ({ value: [{ name: "aws-diagrams", description: "Draw AWS diagrams", source: "plugin" }, { name: "constructor", description: "Build things", source: "user" }] }));
  let seen: readonly string[] | undefined;
  on("prompt.submit", (_$, e) => {
    seen = e.context as readonly string[] | undefined;
    return { text: e.text };
  });
  await $.prompt.submit({ text: "rewrite the storage layer to draw aws diagrams and build the constructor", wait: false, origin: { kind: "composer" } });
  expect(seen?.join("\n") ?? "").toContain("plan");
  // The batch's question types in order; the skill options are the related skills (best first) plus `none`.
  expect(sent.map((q) => q.type)).toEqual(["choice", "noul", "choice"]);
  expect(Object.keys(sent[2].criteria as object)).toEqual(["none", "aws-diagrams", "constructor"]);
});

test("A confident skill keeps its hint where step 0 cannot take it (takeOnlyForBypass is on by default)", async ($, on) => {
  const answers: Record<string, Record<string, unknown>> = {
    kind: { type: "choice", choice: "task", probabilities: { task: 0.9, question: 0.1 }, confidence: 0.8 },
    needs_plan: { type: "noul", noul: 0.1 },
    skill: { type: "choice", choice: "aws-diagrams", probabilities: { "aws-diagrams": 0.95, none: 0.05 }, confidence: 0.9 },
  };
  base(on, (q) => answers[PROMPT_IDS.get(q.instructions) ?? ""]);
  on("command.list", () => ({ value: [{ name: "aws-diagrams", description: "Draw AWS diagrams", source: "plugin" }] }));
  let seen: readonly string[] | undefined;
  on("prompt.submit", (_$, e) => {
    seen = e.context as readonly string[] | undefined;
    return { text: e.text };
  });
  await $.prompt.submit({ text: "draw the aws diagram of the storage layer", wait: false, origin: { kind: "composer" } });
  expect(seen?.join("\n") ?? "").toContain("the skill \"aws-diagrams\"");
});

test("The classifier offers only the related skills (at most 8, deduped), none first; no related skill, no skill question", async ($, on) => {
  // Only the questions sent matter here, not the answers.
  const sent = base(on, () => ({}));
  const filler = Array.from({ length: 300 }, (_, i) => ({ name: `helper-${i}`, description: `Helper number ${i}`, source: "user" }));
  const migrate = Array.from({ length: 12 }, (_, i) => ({ name: `migrate-${i}`, description: `Variant ${i}`, source: "plugin" }));
  const best = { name: "db-migrate", description: "Migrate the database schema", source: "user" };
  on("command.list", () => ({ value: [...filler, { ...best, name: "tools:db-migrate", source: "plugin" }, ...migrate, best] }));
  on("prompt.submit", (_$, e) => ({ text: e.text }));
  await $.prompt.submit({ text: "migrate the database schema to v2", wait: false, origin: { kind: "composer" } });
  const options = Object.keys(sent[2].criteria as object);
  expect(options).toHaveLength(9);
  expect(options.slice(0, 2)).toEqual(["none", "db-migrate"]);
  expect(options).not.toContain("tools:db-migrate");
  sent.length = 0;
  await $.prompt.submit({ text: "rewrite the storage layer", wait: false, origin: { kind: "composer" } });
  expect(sent.map((q) => q.type)).toEqual(["choice", "noul"]);
});

/** A listed skill whose name is the classifier's no-skill option. */
const SKILL_NONE = { name: "none", description: "Deploy the docs site to staging", source: "user" };

test("A listed skill named none never replaces the no-skill option", async ($, on) => {
  const sent = base(on, () => ({}));
  on("command.list", () => ({ value: [SKILL_NONE, { name: "deploy-docs", description: "Deploy the docs site", source: "plugin" }] }));
  on("prompt.submit", (_$, e) => ({ text: e.text }));
  await $.prompt.submit({ text: "deploy the docs site", wait: false, origin: { kind: "composer" } });
  expect(sent[2].criteria).toEqual({ none: "No listed skill is meant for this request", "deploy-docs": "Deploy the docs site" });
});

test("With only a skill named none related, no skill question", async ($, on) => {
  const sent = base(on, () => ({}));
  on("command.list", () => ({ value: [SKILL_NONE] }));
  on("prompt.submit", (_$, e) => ({ text: e.text }));
  await $.prompt.submit({ text: "deploy the docs site", wait: false, origin: { kind: "composer" } });
  expect(sent.map((q) => q.type)).toEqual(["choice", "noul"]);
});

test("A general-purpose subagent is switched only when Jev is confident; an explicit type is kept", async ($, on) => {
  const sent = base(on, () => ({ type: "choice", choice: "Explore", probabilities: { Explore: 0.92, "general-purpose": 0.08 }, confidence: 0.85 }));
  on("agent.offer", () => ({ isOffered: true }));
  const spawned: unknown[] = [];
  on("tool.call", (_$, e) => {
    spawned.push(e.subagent_type);
    return { result: undefined };
  });
  await $.agent.offer({ agent: "general-purpose", description: "General tasks", source: "built-in" });
  await $.agent.offer({ agent: "Explore", description: "Read-only codebase search", source: "built-in" });

  await $.tool.call({ tool: "Agent", description: "find usages", prompt: "Find every caller of addTodo", tool_use_id: "a1" });
  await $.tool.call({ tool: "Agent", description: "plan", prompt: "Find every caller of addTodo", subagent_type: "Plan", tool_use_id: "a2" });
  expect(spawned).toEqual(["Explore", "Plan"]);
  // The offered agent types are the options of one choice call per Agent call.
  expect(sent.map((q) => q.type)).toEqual(["choice", "choice"]);
  expect(sent[0].criteria).toEqual({ "general-purpose": "General tasks", Explore: "Read-only codebase search" });
});

test("An agent type a hook beneath withholds is not one of Jev's options", async ($, on) => {
  const sent = base(on, () => ({ type: "choice", choice: "Explore", probabilities: { Explore: 0.92, "general-purpose": 0.08 }, confidence: 0.85 }));
  on("agent.offer", (_$, e) => ({ isOffered: e.agent !== "lab:runner" }));
  on("tool.call", () => ({ result: undefined }));
  await $.agent.offer({ agent: "general-purpose", description: "General tasks", source: "built-in" });
  await $.agent.offer({ agent: "Explore", description: "Read-only codebase search", source: "built-in" });
  await $.agent.offer({ agent: "lab:runner", description: "Runner only", source: "plugin" });
  await $.tool.call({ tool: "Agent", description: "find usages", prompt: "Find every caller of addTodo", tool_use_id: "a1" });
  expect(Object.keys(sent[0].criteria as object)).toEqual(["general-purpose", "Explore"]);
});

test("An agent type no longer offered in a later turn is not a switch target", async ($, on) => {
  const sent = base(on, () => ({ type: "choice", choice: "lab:runner", probabilities: { "lab:runner": 0.95, "general-purpose": 0.05 }, confidence: 0.9 }));
  on("agent.offer", () => ({ isOffered: true }));
  const spawned: unknown[] = [];
  on("tool.call", (_$, e) => {
    spawned.push(e.subagent_type);
    return { result: undefined };
  });
  on("turn.complete", () => ({}));
  await $.agent.offer({ agent: "general-purpose", description: "General tasks", source: "built-in" });
  await $.agent.offer({ agent: "Explore", description: "Read-only codebase search", source: "built-in" });
  await $.agent.offer({ agent: "lab:runner", description: "Runs a spec", source: "plugin" });
  await $.turn.complete({ turnId: "t1", reason: "aborted" });
  // The next turn's listing, after the lab plugin was unloaded.
  await $.agent.offer({ agent: "general-purpose", description: "General tasks", source: "built-in" });
  await $.agent.offer({ agent: "Explore", description: "Read-only codebase search", source: "built-in" });
  await $.tool.call({ tool: "Agent", description: "run", prompt: "Run the spec", subagent_type: "general-purpose", tool_use_id: "a1" });
  expect(spawned).toEqual(["general-purpose"]);
  expect(Object.keys(sent[0].criteria as object)).toEqual(["general-purpose", "Explore"]);
});

pureTest("Compaction instructions keep relevant results and mark stale ones", () => {
  const messages = [
    { role: "user", text: "fix the failing date test", toolUses: [] },
    {
      role: "assistant",
      text: "",
      toolUses: [
        { tool_use_id: "t1", tool: "Read", input: { file_path: "/proj/todo.js" }, text: "export function isOverdue…" },
        { tool_use_id: "t2", tool: "Bash", input: { command: "ls" }, text: "a b c" },
        { tool_use_id: "t3", tool: "Bash", input: { command: "npm test" }, text: "not ok 5 - isOverdue" },
      ],
    },
  ];
  const items = compactItems(messages);
  expect(items.map((i) => i.label)).toEqual(["Read /proj/todo.js", "Bash ls", "Bash npm test"]);
  const text = compactInstructions(items, [2.5, 0.2, 2.9]) ?? "";
  expect(text).toContain("Keep exact details (paths, errors, decisions, values) from: Read /proj/todo.js; Bash npm test.");
  expect(text).toContain("dropped: Bash ls.");
});

test("session.compact passes the ranking to the summarizer", async ($, on) => {
  const messages: Msg[] = [
    { role: "user", text: "fix the failing date test", toolUses: [] },
    {
      role: "assistant",
      text: "",
      toolUses: ["a", "b", "c"].map((x, i) => ({ tool_use_id: `t${i}`, tool: "Bash", input: { command: `step ${x}` }, text: x })),
    },
  ];
  // One score call per tool result: only the first (`step a`) is relevant.
  const sent = base(on, (q) => ({ type: "score", score: q.instructions.includes("Call: Bash step a.") ? 2.8 : 0.3, probabilities: {}, confidence: 0.8 }));
  let instructions = "";
  on("session.compact", (_$, e) => {
    instructions = typeof e.instructions === "string" ? e.instructions : "";
    return { skip: "test" };
  });
  await $.session.compact({ trigger: "manual", messages });
  expect(instructions).toContain("Keep exact details (paths, errors, decisions, values) from: Bash step a.");
  expect(sent.map((q) => q.type)).toEqual(["score", "score", "score"]);
});

test("session.compact waits longer for Jev than an interactive call, and tells jev-api so", async ($, on) => {
  const messages: Msg[] = [
    { role: "user", text: "fix the failing date test", toolUses: [] },
    {
      role: "assistant",
      text: "",
      toolUses: ["a", "b", "c"].map((x, i) => ({ tool_use_id: `t${i}`, tool: "Bash", input: { command: `step ${x}` }, text: x })),
    },
  ];
  mock.store(on, {});
  mock.env(on, { TYPESAFE_API_KEY: "k" }); // Jev configured: System One answers, not Haiku
  const clock = mock.clock(on);
  on("session.cwd", () => ({ value: CWD }));
  on("session.messages", () => ({ value: messages }));
  on("ui.status", () => ({ value: undefined }));
  on("tool.list", () => ({ value: JEV_TOOLS }));
  let apiTimeout: unknown;
  on("tool.call", async (_$, e, next) => {
    if (e.tool !== JEV_BATCH) return next(e);
    apiTimeout = e.timeout;
    await _$.clock.sleep(4500); // longer than the interactive 4 s budget
    const asked = e.questions as { instructions: string }[];
    return { value: { result: JSON.stringify(asked.map((q) => ({ type: "score", score: q.instructions.includes("Call: Bash step a.") ? 2.8 : 0.3, probabilities: {}, confidence: 0.8 }))) } };
  });
  let instructions = "";
  on("session.compact", (_$, e) => {
    instructions = typeof e.instructions === "string" ? e.instructions : "";
    return { skip: "test" };
  });
  const done = $.session.compact({ trigger: "manual", messages });
  while (apiTimeout === undefined) await clock.advance(0); // until the batch call is under way
  await clock.advance(4600);
  await done;
  expect(apiTimeout).toBe(9);
  expect(instructions).toContain("Keep exact details (paths, errors, decisions, values) from: Bash step a.");
});

test("A short follow-up is classified with the previous reply as context", async ($, on) => {
  const answers: Record<string, Record<string, unknown>> = {
    kind: { type: "choice", choice: "task", probabilities: { task: 1 }, confidence: 1 },
    needs_plan: { type: "noul", noul: 0.1 },
  };
  const sent = base(on, (q) => answers[PROMPT_IDS.get(q.instructions) ?? ""], [{ role: "assistant", text: "The done check could skip while background tasks run. Want me to fix that?", toolUses: [] }]);
  on("command.list", () => ({ value: [] }));
  on("prompt.submit", (_$, e) => ({ text: e.text }));
  await $.prompt.submit({ text: "fix it", wait: false, origin: { kind: "composer" } });
  // Both questions (kind, needs_plan) carry the batch call's state as JSON text.
  const sentStates = sent.map((q) => JSON.parse(q.state) as Record<string, unknown>);
  expect(sentStates).toHaveLength(2);
  expect(String(sentStates[0]?.previous_reply)).toContain("Want me to fix that?");
  expect(sentStates[0]?.request).toBe("fix it");
});

// JJ: the compaction ranking's budget and jev-api timeout, with Jev configured and while Haiku answers.
for (const [label, env, ms, s] of [["Jev", { TYPESAFE_API_KEY: "k" }, 9000, 9], ["Haiku", {}, 15_000, 14]] as const) {
  test(`JJ session.compact gives a ${label} ranking ${ms} ms and jev-api ${s} s`, async ($, on) => {
    const messages: Msg[] = [
      { role: "user", text: "fix the failing date test", toolUses: [] },
      { role: "assistant", text: "", toolUses: ["a", "b", "c"].map((x, i) => ({ tool_use_id: `t${i}`, tool: "Bash", input: { command: `step ${x}` }, text: x })) },
    ];
    mock.store(on, {});
    mock.env(on, env);
    const clock = mock.clock(on);
    on("session.cwd", () => ({ value: CWD }));
    on("session.messages", () => ({ value: messages }));
    on("ui.status", () => ({ value: undefined }));
    on("tool.list", () => ({ value: JEV_TOOLS }));
    let apiTimeout: unknown;
    on("tool.call", (_$, e, next) => {
      if (e.tool !== JEV_BATCH) return next(e);
      apiTimeout = e.timeout;
      return new Promise<never>(() => {});
    });
    let compacted = false;
    on("session.compact", () => {
      compacted = true;
      return { skip: "test" };
    });
    const done = $.session.compact({ trigger: "manual", messages });
    while (apiTimeout === undefined) await clock.advance(0);
    await clock.advance(ms - 1);
    expect(compacted).toBe(false);
    await clock.advance(1);
    await done;
    expect(compacted).toBe(true);
    expect(apiTimeout).toBe(s);
  });
}
