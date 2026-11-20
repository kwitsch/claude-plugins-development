// The built register.mjs through the shared kit (tests/support/kit.ts): stubs answer the engine calls; prompt.submit and
// tool.call end in recording stubs, so the tests read the context the mod added.
import { expect } from "vitest";
import { BIN, CWD, makeKit, prompt, SETUP, toolCall } from "./support/kit.ts";

const { test, setup } = makeKit();

test("the first prompt gets the briefing and the recall, a later one only recall and new priority entries", async ($, on) => {
  const { prompts, calls, runs } = setup(on);
  await $.session.start({ source: "startup" });
  await prompt($, "where is foo_bar defined in the code");
  const first = (prompts[0].context ?? []).join("\n");
  expect(first).toMatch(/Project indexed and ready/);
  expect(first).toMatch(/Graph: 1 symbols/);
  expect(first).toMatch(/top file/);
  expect(first).toMatch(/always use X/);
  expect(first).toMatch(/recent one/);
  expect(first).toMatch(/Auto-memory is ON/);
  // The briefing reuses the readiness probe's status text: gm_status is called once.
  expect(calls.filter((c) => c.tool.endsWith("__gm_status"))).toHaveLength(1);
  expect(first).toMatch(/about foo_bar/);
  expect(first).toMatch(/\[graphmind code\] Relevant symbols:/);
  // The calls go to graphmind's server with the session cwd; the CLI only does what the tools cannot.
  expect(calls.every((c) => c.project === CWD)).toBe(true);
  expect(calls.find((c) => c.tool.endsWith("__gm_search"))).toMatchObject({ query: "foo_bar defined code", code_only: true, limit: 5 });
  expect(runs).toContainEqual([BIN, "memory", "search", "foo_bar defined code", "--limit", "5", "--max-chars", "300", "--no-recall"]);
  expect(runs.filter((r) => r[2] === "list")).toHaveLength(1);

  await prompt($, "something else entirely about parseConfig here");
  const second = (prompts[1].context ?? []).join("\n");
  expect(second).not.toMatch(/Project indexed and ready/);
  // aaaaaaaa was shown in the briefing: not offered again.
  expect(second).not.toMatch(/always use X/);
});

test("a compaction of the main conversation brings the briefing and priority entries back", async ($, on) => {
  const { prompts } = setup(on);
  await $.session.start({ source: "startup" });
  await prompt($, "where is foo_bar defined in the code");
  await $.session.compact({ trigger: "auto" });
  await prompt($, "something else entirely about parseConfig here");
  const after = (prompts[1].context ?? []).join("\n");
  expect(after).toMatch(/Project indexed and ready/);
  expect(after).toMatch(/always use X/);
});

test("/clear (session.end) briefs the next conversation again", async ($, on) => {
  const { prompts } = setup(on);
  await $.session.start({ source: "startup" });
  await prompt($, "where is foo_bar defined in the code");
  await $.session.end({ reason: "clear" });
  await prompt($, "something else entirely about parseConfig here");
  const after = (prompts[1].context ?? []).join("\n");
  expect(after).toMatch(/Project indexed and ready/);
  expect(after).toMatch(/always use X/);
});

test("a precompute or a subagent's compaction does not brief again", async ($, on) => {
  const { prompts } = setup(on);
  await $.session.start({ source: "startup" });
  await prompt($, "where is foo_bar defined in the code");
  await $.session.compact({ trigger: "precompute" });
  await $.session.compact({ trigger: "auto", agentId: "a1" });
  await prompt($, "something else entirely about parseConfig here");
  const after = (prompts[1].context ?? []).join("\n");
  expect(after).not.toMatch(/Project indexed and ready/);
  expect(after).not.toMatch(/always use X/);
});

test("a skipped compaction does not brief again", async ($, on) => {
  const { prompts } = setup(on, { compactSkip: true });
  await $.session.start({ source: "startup" });
  await prompt($, "where is foo_bar defined in the code");
  await $.session.compact({ trigger: "auto" });
  await prompt($, "something else entirely about parseConfig here");
  const after = (prompts[1].context ?? []).join("\n");
  expect(after).not.toMatch(/Project indexed and ready/);
  expect(after).not.toMatch(/always use X/);
});

/** Whether the inline plugin `above` settles the next prompt before the module does (the engine then abandons the dispatch). */
let abandonNext = false;

test("an abandoned first prompt does not cost the conversation its briefing", {
  plugins: [{
    name: "above",
    tier: "prepend",
    register(on) {
      on("prompt.submit", (_$, e, next) => {
        if (!abandonNext) return next(e);
        abandonNext = false;
        return Promise.race([next(e), Promise.resolve({})]);
      });
    },
  }],
}, async ($, on) => {
  const { prompts, clock } = setup(on);
  await $.session.start({ source: "startup" });
  abandonNext = true;
  await prompt($, "where is foo_bar defined in the code");
  await clock.settle();
  // The lingering module finished and passed the prompt on, but delivered nothing for the abandoned dispatch.
  expect((prompts[0]?.context ?? []).join("\n")).toBe("");
  await prompt($, "where is foo_bar defined in the code");
  const second = (prompts.at(-1)?.context ?? []).join("\n");
  expect(second).toMatch(/Project indexed and ready/);
  expect(second).toMatch(/always use X/);
  expect(second).toMatch(/about foo_bar/);
});

test("a full briefing does not starve the first prompt's recall", async ($, on) => {
  // A real project's priority block is about 6000 chars: the briefing and the recall each get their own budget.
  const priority = `>> 20\n${Array.from({ length: 20 }, (_, i) => `★ ${String(i).padStart(8, "a")} [decision] ${"x".repeat(280)}`).join("\n")}\n`;
  const map = Array.from({ length: 20 }, (_, i) => `  src/file${i}.ts ${"y".repeat(150)}`).join("\n");
  const { prompts } = setup(on, { priority, map });
  await $.session.start({ source: "startup" });
  await prompt($, "where is foo_bar defined in the code");
  const first = (prompts[0].context ?? []).join("\n");
  expect(first).toMatch(/Priority context/);
  expect(first).toMatch(/about foo_bar/);
  expect(first).toMatch(/\[graphmind code\] Relevant symbols:/);
});

test("a priority entry cut from the briefing is offered on the next prompt", async ($, on) => {
  const priority = `>> 20\n${Array.from({ length: 20 }, (_, i) => `★ ${String(i).padStart(8, "a")} [decision] entry${i} ${"x".repeat(280)}`).join("\n")}\n`;
  const map = Array.from({ length: 20 }, (_, i) => `  src/file${i}.ts ${"y".repeat(150)}`).join("\n");
  const { prompts } = setup(on, { priority, map });
  await $.session.start({ source: "startup" });
  await prompt($, "where is foo_bar defined in the code");
  expect((prompts[0].context ?? []).join("\n")).not.toMatch(/entry19 /);
  await prompt($, "something else entirely about parseConfig here");
  expect((prompts[1].context ?? []).join("\n")).toMatch(/entry19 /);
});

test("a memory search hit that is a priority entry is not shown again", async ($, on) => {
  // Real CLI shape (graphmind 0.3.7): the search lists the priority entry without its star.
  const { prompts } = setup(on, { search: ">> 2 result(s):\n\n  aaaaaaaa [decision] always use X (tags: x)\n  bbbbbbbb [pattern] about foo_bar\n" });
  await $.session.start({ source: "startup" });
  await prompt($, "please explain the always rule");
  const first = (prompts[0].context ?? []).join("\n");
  expect(first.match(/always use X/g)).toHaveLength(1);
  expect(first).toMatch(/about foo_bar/);
  await prompt($, "another prompt about always rule usage");
  const second = (prompts[1].context ?? []).join("\n");
  expect(second).not.toMatch(/always use X/);
  expect(second).toMatch(/about foo_bar/);
});

test("the same terms are not searched again within three minutes", async ($, on) => {
  const { runs, calls, clock } = setup(on);
  await $.session.start({ source: "startup" });
  await prompt($, "where is foo_bar defined in the code");
  await prompt($, "where is foo_bar defined in the code");
  expect(runs.filter((r) => r[2] === "search")).toHaveLength(1);
  expect(calls.filter((c) => c.tool.endsWith("__gm_search"))).toHaveLength(1);
  await clock.advance(180_000);
  await prompt($, "where is foo_bar defined in the code");
  expect(runs.filter((r) => r[2] === "search")).toHaveLength(2);
});

test("an empty priority store adds no priority block", async ($, on) => {
  // Real CLI output (graphmind 0.3.7) for a store without priority entries: a notice without an entry id.
  const { prompts } = setup(on, { priority: "No priority memories found.\n" });
  await $.session.start({ source: "startup" });
  await prompt($, "where is foo_bar defined in the code");
  await prompt($, "something else entirely about parseConfig here");
  const all = prompts.map((p) => (p.context ?? []).join("\n")).join("\n");
  expect(all).not.toMatch(/No priority memories found|Priority context|new priority context/);
});

test("a recent memory that is a priority entry is left out of the briefing", async ($, on) => {
  // Real MCP shape (graphmind 0.3.7): gm_memory_list lists a priority entry without its star; the summary may hold 8 hex.
  const recent = ">> 3\n  [decision] always use X (id: aaaaaaaa-1111-2222-3333-444444444444)\n  [pattern] see aaaaaaaa notes (id: cccccccc-1111-2222-3333-444444444444)\n  [bug] recent one (id: dddddddd-1111-2222-3333-444444444444)";
  const { prompts, calls } = setup(on, { recent });
  await $.session.start({ source: "startup" });
  await prompt($, "please explain the recent decisions");
  const first = (prompts[0].context ?? []).join("\n");
  expect(first.match(/always use X/g)).toHaveLength(1);
  expect(first).toMatch(/see aaaaaaaa notes/);
  expect(first).toMatch(/recent one/);
  expect(calls.find((c) => c.tool.endsWith("__gm_memory_list"))).toMatchObject({ limit: 10 });
});

test("every tenth prompt carries the save reminder", async ($, on) => {
  const { prompts } = setup(on);
  await $.session.start({ source: "startup" });
  for (let i = 1; i <= 10; i++) await prompt($, `prompt number ${i} with enough characters`);
  expect((prompts[9].context ?? []).join("\n")).toMatch(/graphmind checkpoint — prompt 10/);
  expect((prompts[8].context ?? []).join("\n")).not.toMatch(/checkpoint/);
});

test("a setup user's server (mcp__graphmind__*) works the same", async ($, on) => {
  const { prompts } = setup(on, { tools: SETUP });
  await $.session.start({ source: "startup" });
  await prompt($, "where is foo_bar defined in the code");
  expect((prompts[0].context ?? []).join("\n")).toMatch(/Project indexed and ready/);
});

test("nothing is added when the project is not registered", async ($, on) => {
  const a = setup(on, { unregistered: true });
  await $.session.start({ source: "startup" });
  await prompt($, "where is foo_bar defined in the code");
  expect(a.prompts[0].context).toBeUndefined();
  expect(a.runs).toHaveLength(0);
});

test("a status without any text part does not make the project look registered", async ($, on) => {
  const a = setup(on, { emptyStatus: true });
  await $.session.start({ source: "startup" });
  await prompt($, "where is foo_bar defined in the code");
  expect(a.prompts[0].context).toBeUndefined();
  expect(a.runs).toHaveLength(0);
});

test("a short, plugin, meta or command prompt passes untouched in a registered project", async ($, on) => {
  const { prompts } = setup(on);
  await $.session.start({ source: "startup" });
  await prompt($, "where is foo_bar defined in the code", { origin: { kind: "plugin", name: "jevfort" } });
  await prompt($, "short");
  await prompt($, "where is foo_bar defined in the code", { isMeta: true });
  await prompt($, "where is foo_bar defined in the code", { command: "x" });
  expect(prompts.map((p) => p.context)).toEqual([undefined, undefined, undefined, undefined]);
});

test("without the server's tools in the list nothing is added", async ($, on) => {
  const { prompts } = setup(on, { tools: [] });
  await $.session.start({ source: "startup" });
  await prompt($, "where is foo_bar defined in the code");
  expect(prompts[0].context).toBeUndefined();
});

test("when graphmind setup's own hooks are in settings.json the module adds nothing", async ($, on) => {
  const { prompts } = setup(on, { settings: "{\"hooks\":{\"x\":\"/h/graphmind-session.sh\"}}" });
  await $.session.start({ source: "startup" });
  await prompt($, "where is foo_bar defined in the code");
  expect(prompts[0].context).toBeUndefined();
  expect((await toolCall($, { tool: "Grep" })).context).toBeUndefined();
});

test("with CLAUDE_CONFIG_DIR set, setup's hooks in $CLAUDE_CONFIG_DIR/settings.json turn the module off", async ($, on) => {
  const { prompts } = setup(on, { configDir: "/cfg", settingsPath: "/cfg/settings.json", settings: "{\"hooks\":{\"x\":\"/h/graphmind-session.sh\"}}" });
  await $.session.start({ source: "startup" });
  await prompt($, "where is foo_bar defined in the code");
  expect(prompts[0].context).toBeUndefined();
});

test("with CLAUDE_CONFIG_DIR set, setup's hooks only in ~/.claude/settings.json do not turn the module off", async ($, on) => {
  const { prompts } = setup(on, { configDir: "/cfg", settings: "{\"hooks\":{\"x\":\"/h/graphmind-session.sh\"}}" });
  await $.session.start({ source: "startup" });
  await prompt($, "where is foo_bar defined in the code");
  expect(prompts[0].context?.length).toBeGreaterThan(0);
});

test("a code search gets the nudge once; other tools and graphmind itself get none", async ($, on) => {
  setup(on);
  await $.session.start({ source: "startup" });
  expect((await toolCall($, { tool: "Read" })).context).toBeUndefined();
  expect((await toolCall($, { tool: "Bash", command: "graphmind search foo" })).context).toBeUndefined();
  const first = await toolCall($, { tool: "Bash", command: "rg foo src" });
  expect(String((first.context ?? [])[0])).toMatch(/graphmind-indexed/);
  expect((await toolCall($, { tool: "Grep" })).context).toBeUndefined();
});

test("parallel code searches get one nudge between them", async ($, on) => {
  setup(on);
  await $.session.start({ source: "startup" });
  const results = await Promise.all([toolCall($, { tool: "Grep" }), toolCall($, { tool: "Grep" }), toolCall($, { tool: "Glob" })]);
  expect(results.filter((r) => r.context?.length)).toHaveLength(1);
});

test("an abandoned first search does not cost the conversation its nudge", {
  plugins: [{
    name: "above",
    tier: "prepend",
    register(on) {
      on("tool.call", (_$, e, next) => {
        if (!abandonNext || e.tool !== "Grep") return next(e);
        abandonNext = false;
        return Promise.race([next(e), Promise.resolve({ result: "above" })]);
      });
    },
  }],
}, async ($, on) => {
  const { clock } = setup(on);
  await $.session.start({ source: "startup" });
  abandonNext = true;
  expect((await toolCall($, { tool: "Grep" })).context).toBeUndefined();
  await clock.settle();
  expect(String(((await toolCall($, { tool: "Grep" })).context ?? [])[0])).toMatch(/graphmind-indexed/);
});

test("no nudge while the project is not registered", async ($, on) => {
  setup(on, { unregistered: true });
  await $.session.start({ source: "startup" });
  expect((await toolCall($, { tool: "Grep" })).context).toBeUndefined();
});

test("session start toasts when no graphmind binary exists", async ($, on) => {
  const { toasts, clock } = setup(on, { files: [] });
  await $.session.start({ source: "startup" });
  await clock.settle();
  expect(toasts).toHaveLength(1);
  expect(toasts[0]).toMatch(/graphmind binary was not found/);
  expect(toasts[0]).toContain("(PATH, ~/.graphmind/bin, ~/.local/bin, /usr/local/bin)");
});

test("a directory named graphmind is not the binary", async ($, on) => {
  const { toasts, clock } = setup(on, { files: [], dirs: [BIN] });
  await $.session.start({ source: "startup" });
  await clock.settle();
  expect(toasts[0]).toMatch(/graphmind binary was not found/);
});

test("session start stays quiet with the binary in place", async ($, on) => {
  const { toasts, clock } = setup(on);
  await $.session.start({ source: "startup" });
  await clock.settle();
  expect(toasts).toHaveLength(0);
});

/** Where the binary is in each row, and which path the module must run. */
const binRows = [
  { name: "a PATH entry", path: "/opt/gm/bin", home: "/home/v", files: ["/opt/gm/bin/graphmind"], bin: "/opt/gm/bin/graphmind" },
  { name: "~/.graphmind/bin", path: "/usr/bin", home: "/home/v", files: ["/home/v/.graphmind/bin/graphmind"], bin: "/home/v/.graphmind/bin/graphmind" },
  { name: "~/.local/bin", path: "/usr/bin", home: "/home/v", files: ["/home/v/.local/bin/graphmind"], bin: "/home/v/.local/bin/graphmind" },
  { name: "/usr/local/bin", path: "/usr/bin", home: "/home/v", files: ["/usr/local/bin/graphmind"], bin: "/usr/local/bin/graphmind" },
  { name: "PATH wins over ~/.local/bin", path: "/opt/gm/bin", home: "/home/v", files: ["/home/v/.local/bin/graphmind", "/opt/gm/bin/graphmind"], bin: "/opt/gm/bin/graphmind" },
];

for (const c of binRows) {
  test(`the graphmind binary is looked for in PATH entries, then ~/.graphmind/bin, ~/.local/bin, /usr/local/bin (${c.name})`, async ($, on) => {
    const { runs } = setup(on, { path: c.path, home: c.home, files: c.files });
    await $.session.start({ source: "startup" });
    await prompt($, "where is foo_bar defined in the code");
    expect(runs[0]?.[0]).toBe(c.bin);
  });
}
