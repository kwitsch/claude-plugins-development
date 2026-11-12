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

// The jev-api tool jevfort needs as `$.tool.list()` lists it.
const JEV_TOOLS = [{ name: JEV_BATCH, description: "Ask Jev several questions", mcp: true }];
// The classifier's question ids by their instructions text (batch questions carry no id).
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
  expect(hints("task", 0.2, { name: "none", p: 0.9 }, 0.85)).toHaveLength(0);
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
  await $.prompt.submit({ text: "rewrite the storage layer to use IndexedDB and sync across tabs", wait: false, origin: { kind: "composer" } });
  expect(seen?.join("\n") ?? "").toContain("plan");
  // The batch's question types in order; the skill options are the listed skills plus `none`.
  expect(sent.map((q) => q.type)).toEqual(["choice", "noul", "choice"]);
  expect(Object.keys(sent[2].criteria as object)).toEqual(["none", "aws-diagrams", "constructor"]);
});

test("The classifier offers at most 255 skill options, none first, each name once", async ($, on) => {
  // Only the questions sent matter here, not the answers.
  const sent = base(on, () => ({}));
  const skills = Array.from({ length: 300 }, (_, i) => ({ name: `skill-${i}`, description: `Skill ${i}`, source: "user" }));
  on("command.list", () => ({ value: [skills[0], ...skills] }));
  on("prompt.submit", (_$, e) => ({ text: e.text }));
  await $.prompt.submit({ text: "rewrite the storage layer", wait: false, origin: { kind: "composer" } });
  const options = Object.keys(sent[2].criteria as object);
  expect(options).toHaveLength(255);
  expect(options.slice(0, 3)).toEqual(["none", "skill-0", "skill-1"]);
  expect(options.at(-1)).toBe("skill-253");
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
