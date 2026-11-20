// Phase 3 (subagent types, compaction) through src/hooks/register.ts: upstream jev-pilot
// tests/phase3.test.ts, as kit tests on the source.
import { createKit } from "claude-engine-vitest";
import type { On } from "claude-engine-vitest";
import { expect } from "vitest";
// jev-api's request tool, the name jevfort asks Jev through (defined in src/hooks/jev.ts).
import { JEV_REQUEST } from "../src/hooks/jev.ts";
import { JEV_TOOLS } from "./support/kit.ts";

// The manifest defaults (jevfort/package.json claudePlugin.userConfig): the kit does not fill userConfig defaults.
const DEFAULTS = {
  routing: true,
  takeSteps: true,
  takeThreshold: 0.85,
  subagents: true,
  bypass: true,
  agentTypes: true,
  compaction: true,
  takeOnlyForBypass: true,
};

const { test, mock } = createKit({ module: new URL("../src/hooks/register.ts", import.meta.url), plugin: "jevfort", options: DEFAULTS });

const CWD = "/proj";

type Msg = { role: "user" | "assistant"; text: string; toolUses: Record<string, unknown>[] };
/** One question of a request call as the fake saw it; `state` is the call's JSON text. */
type Asked = { type: string; instructions: string; state: string; criteria?: unknown };

/** Lists the request tool, answers each request question with `jev`'s answer and stubs the session reads the hooks make; returns the questions. */
function base(on: On, jev: (q: Asked) => Record<string, unknown>, messages: Msg[] = []) {
  const sent: Asked[] = [];
  mock.store(on, {});
  mock.clock(on);
  on("session.cwd", () => ({ value: CWD }));
  on("session.messages", () => ({ value: messages }));
  on("ui.status", () => ({ value: undefined }));
  on("tool.list", () => ({ value: JEV_TOOLS }));
  on("tool.call", (_$, e, next) => {
    if (e.tool !== JEV_REQUEST) return next(e);
    const asked = (e.questions as { type: string; instructions: string; criteria?: unknown }[]).map((b): Asked => ({ ...b, state: String(e.state) }));
    sent.push(...asked);
    // A mod's `$.tool.call` resolves to the stub's `value`: the tool result `{ result }`, the answers in question order.
    return { value: { result: JSON.stringify(asked.map((q) => jev(q))) } };
  });
  return sent;
}

/** A listed skill whose name is the classifier's no-skill option. */
test("A general-purpose subagent is switched only when Jev is confident; an explicit type is kept", async ($, on) => {
  let p = 0.92;
  const sent = base(on, () => ({ type: "choice", choice: "Explore", probabilities: { Explore: p, "general-purpose": 1 - p }, confidence: 0.85 }));
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
  // "claude" means no specific type, so it is switched too.
  await $.tool.call({ tool: "Agent", description: "find usages", prompt: "Find every caller of addTodo", subagent_type: "claude", tool_use_id: "a3" });
  // Below SWITCH_AT (0.85) the general-purpose call is kept.
  p = 0.6;
  await $.tool.call({ tool: "Agent", description: "find usages", prompt: "Find every caller of addTodo", tool_use_id: "a4" });
  expect(spawned).toEqual(["Explore", "Plan", "Explore", undefined]);
  // The offered agent types are the options of one choice call per Agent call.
  // The call with a specific type (a2) is never switched, so it asks nothing.
  expect(sent.map((q) => q.type)).toEqual(["choice", "choice", "choice"]);
  expect(sent[0].criteria).toEqual({ "general-purpose": "General tasks", Explore: "Read-only codebase search" });
});

test("An Agent call with a specific type makes no Jev request", async ($, on) => {
  const sent = base(on, () => ({ type: "choice", choice: "Explore", probabilities: { Explore: 0.99 }, confidence: 0.9 }));
  on("agent.offer", () => ({ isOffered: true }));
  const spawned: unknown[] = [];
  on("tool.call", (_$, e) => {
    spawned.push(e.subagent_type);
    return { result: undefined };
  });
  await $.agent.offer({ agent: "general-purpose", description: "General tasks", source: "built-in" });
  await $.agent.offer({ agent: "Explore", description: "Read-only codebase search", source: "built-in" });
  await $.tool.call({ tool: "Agent", description: "plan", prompt: "Plan it", subagent_type: "Plan", tool_use_id: "a1" });
  expect(spawned).toEqual(["Plan"]);
  expect(sent).toEqual([]);
});

test("agentTypes: false never asks Jev about an Agent call and keeps its type", { options: { agentTypes: false } }, async ($, on) => {
  const sent = base(on, () => ({ type: "choice", choice: "Explore", probabilities: { Explore: 0.95, "general-purpose": 0.05 }, confidence: 0.9 }));
  on("agent.offer", () => ({ isOffered: true }));
  const spawned: unknown[] = [];
  on("tool.call", (_$, e) => {
    spawned.push(e.subagent_type);
    return { result: undefined };
  });
  await $.agent.offer({ agent: "general-purpose", description: "General tasks", source: "built-in" });
  await $.agent.offer({ agent: "Explore", description: "Read-only codebase search", source: "built-in" });
  await $.tool.call({ tool: "Agent", description: "find usages", prompt: "Find every caller of addTodo", tool_use_id: "a1" });
  expect(sent).toHaveLength(0);
  expect(spawned).toEqual([undefined]);
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

test("Compaction instructions keep relevant results and mark stale ones", async ($, on) => {
  const messages: Msg[] = [
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
  // The ranking scores of the three results, by their labels: the first and last are kept, the middle one is stale.
  const scores: Record<string, number> = { "Read /proj/todo.js": 2.5, "Bash ls": 0.2, "Bash npm test": 2.9 };
  base(on, (q) => {
    const label = Object.keys(scores).find((l) => q.instructions.includes(`Call: ${l}.`));
    return { type: "score", score: label === undefined ? 0.3 : scores[label], probabilities: {}, confidence: 0.8 };
  }, messages);
  let instructions = "";
  on("session.compact", (_$, e) => {
    instructions = typeof e.instructions === "string" ? e.instructions : "";
    return { skip: "test" };
  });
  await $.session.compact({ trigger: "manual", messages });
  expect(instructions).toContain("Keep exact details (paths, errors, decisions, values) from: Read /proj/todo.js; Bash npm test.");
  expect(instructions).toContain("dropped: Bash ls.");
});

test("the ranking covers the newest 30 results, cut at 500 characters, and their command labels at 80", async ($, on) => {
  const uses = Array.from({ length: 35 }, (_, i) => ({ tool_use_id: `t${i + 1}`, tool: "Bash", input: { command: "x".repeat(200) }, text: "r".repeat(2000) }));
  const messages: Msg[] = [
    { role: "user", text: "fix the failing date test", toolUses: [] },
    { role: "assistant", text: "", toolUses: uses },
  ];
  const sent = base(on, () => ({ type: "score", score: 0.3, probabilities: {}, confidence: 0.8 }), messages);
  on("session.compact", () => ({ skip: "test" }));
  await $.session.compact({ trigger: "manual", messages });
  expect(sent).toHaveLength(30);
  for (const q of sent) {
    expect(q.instructions).toContain(`Bash ${"x".repeat(80)}… [120 more chars]`);
    expect(q.instructions).toContain(`${"r".repeat(500)}… [1500 more chars]`);
  }
});

test("the ranking scores the last 30 of 35 results, in order", async ($, on) => {
  const uses = Array.from({ length: 35 }, (_, i) => ({ tool_use_id: `t${i + 1}`, tool: "Bash", input: { command: `cmd${i + 1}` }, text: "r" }));
  const messages: Msg[] = [{ role: "assistant", text: "", toolUses: uses }];
  const sent = base(on, () => ({ type: "score", score: 0.3, probabilities: {}, confidence: 0.8 }), messages);
  on("session.compact", () => ({ skip: "test" }));
  await $.session.compact({ trigger: "manual", messages });
  expect(sent[0].instructions).toContain("Call: Bash cmd6.");
  expect(sent[29].instructions).toContain("Call: Bash cmd35.");
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

test("compaction: false sends no ranking call and no ranking instructions", { options: { compaction: false } }, async ($, on) => {
  const messages: Msg[] = [
    { role: "user", text: "fix the failing date test", toolUses: [] },
    // Three results: the fewest withJevRanking ranks.
    { role: "assistant", text: "", toolUses: ["a", "b", "c"].map((x, i) => ({ tool_use_id: `t${i}`, tool: "Bash", input: { command: `step ${x}` }, text: x })) },
  ];
  const sent = base(on, () => ({ type: "score", score: 2.8, probabilities: {}, confidence: 0.8 }));
  let instructions: unknown;
  on("session.compact", (_$, e) => {
    instructions = e.instructions;
    return { skip: "test" };
  });
  await $.session.compact({ trigger: "manual", messages });
  expect(sent).toHaveLength(0);
  expect(instructions).toBeUndefined();
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
    if (e.tool !== JEV_REQUEST) return next(e);
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
  while (apiTimeout === undefined) await clock.advance(0); // until the request call is under way
  await clock.advance(4600);
  await done;
  expect(apiTimeout).toBe(9);
  expect(instructions).toContain("Keep exact details (paths, errors, decisions, values) from: Bash step a.");
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
      if (e.tool !== JEV_REQUEST) return next(e);
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
