// Phase 3 (prompt classifier, subagent types, compaction) of the built plugin/hooks/*.mjs: upstream jev-pilot
// tests/phase3.test.ts. The pure tests come first; the kit tests follow.
import { createKit } from "claude-engine-vitest";
import type { On } from "claude-engine-vitest";
import { expect, test as pureTest } from "vitest";
import { compactInstructions, compactItems } from "../plugin/hooks/compact.mjs";
import { hints } from "../plugin/hooks/prompt.mjs";

// The manifest defaults (jevfort/package.json claudePlugin.userConfig): the kit does not fill userConfig defaults.
const DEFAULTS = {
  mode: "active",
  routing: "effort",
  takeSteps: true,
  gate: true,
  doneCheck: true,
  takeThreshold: 0.85,
  subagents: true,
  dangerDeny: 0.8,
  scopeDeny: 0.2,
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

type Msg = { role: "user" | "assistant"; text: string; toolUses: Record<string, unknown>[] };

/** Answers every Jev call with `jev`'s answers and stubs the session reads the hooks make. */
function base(on: On, jev: (q: Record<string, unknown>) => Record<string, unknown>, messages: Msg[] = []) {
  mock.env(on, { TYPESAFE_API_KEY: "test-key" });
  mock.store(on, {});
  mock.clock(on);
  on("session.cwd", () => ({ value: CWD }));
  on("session.messages", () => ({ value: messages }));
  on("ui.status", () => ({ value: undefined }));
  on("http.fetch", (_$, e) => {
    const body = JSON.parse(String((e.init as { body?: string } | undefined)?.body ?? "{}")) as { questions: Record<string, unknown> };
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers: jev(body.questions) }) } };
  });
}

pureTest("hints: a mid-confidence skill and a large task get hints; a confident skill is left to step 0", () => {
  expect(hints("task", 0.9, { name: "aws-diagrams", p: 0.7 }, 0.85)).toHaveLength(2);
  expect(hints("question", 0.9, { name: "aws-diagrams", p: 0.95 }, 0.85)).toHaveLength(0);
  expect(hints("task", 0.2, { name: "none", p: 0.9 }, 0.85)).toHaveLength(0);
});

test("The prompt classifier adds a hint only Claude reads", async ($, on) => {
  base(on, () => ({
    kind: { type: "choice", choice: "task", probabilities: { task: 0.9, question: 0.1 }, confidence: 0.8 },
    needs_plan: { type: "noul", noul: 0.93 },
    skill: { type: "choice", choice: "none", probabilities: { none: 0.9 }, confidence: 0.9 },
  }));
  on("command.list", () => ({ value: [{ name: "aws-diagrams", description: "Draw AWS diagrams", source: "plugin" }] }));
  let seen: readonly string[] | undefined;
  on("prompt.submit", (_$, e) => {
    seen = e.context as readonly string[] | undefined;
    return { text: e.text };
  });
  await $.prompt.submit({ text: "rewrite the storage layer to use IndexedDB and sync across tabs", wait: false, origin: { kind: "composer" } });
  expect(seen?.join("\n") ?? "").toContain("plan");
});

test("A general-purpose subagent is switched only when Jev is confident; an explicit type is kept", async ($, on) => {
  base(on, () => ({ agent_type: { type: "choice", choice: "Explore", probabilities: { Explore: 0.92, "general-purpose": 0.08 }, confidence: 0.85 } }));
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
  base(on, (q) => Object.fromEntries(Object.keys(q).map((k, i) => [k, { type: "score", score: i === 0 ? 2.8 : 0.3, probabilities: {}, confidence: 0.8 }])));
  let instructions = "";
  on("session.compact", (_$, e) => {
    instructions = typeof e.instructions === "string" ? e.instructions : "";
    return { skip: "test" };
  });
  await $.session.compact({ trigger: "manual", messages });
  expect(instructions).toContain("Keep exact details (paths, errors, decisions, values) from: Bash step a.");
});

test("A short follow-up is classified with the previous reply as context", async ($, on) => {
  const sentStates: Record<string, unknown>[] = [];
  mock.env(on, { TYPESAFE_API_KEY: "test-key" });
  mock.store(on, {});
  mock.clock(on);
  on("session.cwd", () => ({ value: CWD }));
  on("session.messages", () => ({ value: [{ role: "assistant", text: "The done check could skip while background tasks run. Want me to fix that?", toolUses: [] }] }));
  on("ui.status", () => ({ value: undefined }));
  on("command.list", () => ({ value: [] }));
  on("http.fetch", (_$, e) => {
    sentStates.push((JSON.parse(String((e.init as { body?: string } | undefined)?.body ?? "{}")) as { state: Record<string, unknown> }).state);
    return {
      value: {
        status: 200,
        ok: true,
        headers: {},
        text: JSON.stringify({ answers: { kind: { type: "choice", choice: "task", probabilities: { task: 1 }, confidence: 1 }, needs_plan: { type: "noul", noul: 0.1 } } }),
      },
    };
  });
  on("prompt.submit", (_$, e) => ({ text: e.text }));
  await $.prompt.submit({ text: "fix it", wait: false, origin: { kind: "composer" } });
  expect(String(sentStates[0]?.previous_reply)).toContain("Want me to fix that?");
});
