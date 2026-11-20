// The rules of the hooks helper (bundled into plugin/hooks/lib.mjs), tested through what they cause in the built
// plugin/hooks/register.mjs: search terms, recall gating, the code pre-fetch, the nudge rule, the output budget, tool names.
import { expect } from "vitest";
import { makeKit, OWN, prompt, SETUP, toolCall } from "./support/kit.ts";

const { test, setup } = makeKit();

/** A prompt that is recallable and yields search terms. */
const ASK = "where is foo_bar defined in the code";
/** The briefing's closing line. */
const AUTO_MEMORY = "Auto-memory is ON: save decisions/patterns/conventions via gm_memory_add. Use --priority for always-injected facts. Recall via gm_memory_search.";
/** The mark of a block cut by the output budget. */
const CUT = "[graphmind: cut to fit the hook output limit]";
/** Tools of a server whose name does not hold graphmind. */
const OTHER = ["status", "map", "memory_list", "search"].map((t) => ({ name: `mcp__other__gm_${t}`, description: "", mcp: true }));

/** A priority line and a memory-search hit carrying the same id; the hit is dropped when the priority line's leading id matches it. */
const entryRows = [
  { name: "a starred priority line", line: "★ aaaaaaaa [decision] prio note", hit: "  aaaaaaaa [pattern] hit note", kept: false },
  { name: "an indented priority line", line: "  bbbbbbbb [pattern] prio note", hit: "  bbbbbbbb [pattern] hit note", kept: false },
  { name: "8 hex in the text, not leading", line: "Found 20261114 entries, see deadbeef", hit: "  deadbeef [pattern] hit note", kept: true },
];
for (const c of entryRows) {
  test(`entry ids: only a line's leading id counts (${c.name})`, async ($, on) => {
    const { prompts } = setup(on, { priority: `>> p\n${c.line}\n`, search: `>> 1 result(s):\n\n${c.hit}\n` });
    await $.session.start({ source: "startup" });
    await prompt($, ASK);
    expect((prompts[0].context ?? []).join("\n").includes("hit note")).toBe(c.kept);
  });
}

const termRows = [
  { name: "identifiers first, stopwords dropped", text: "where is parseConfig and foo_bar defined", terms: "parseconfig foo_bar defined" },
  { name: "a dotted identifier with a camelCase first part (grep -oE leftmost-longest)", text: "how does userService.findById work", terms: "userservice.findbyid userservice findbyid work" },
  // Was also a wall-clock check (< 100 ms); tests take no wall-clock thresholds: the kit's 5000 ms test timeout is the backstop.
  { name: "a long unbroken token is dropped", text: `where is ${"a".repeat(80000)} parseConfig`, terms: "parseconfig" },
];
for (const c of termRows) {
  test(`search terms: ${c.name}`, async ($, on) => {
    const { runs } = setup(on);
    await $.session.start({ source: "startup" });
    await prompt($, c.text);
    expect(runs.find((r) => r[2] === "search")?.[3]).toBe(c.terms);
  });
}

const recallRows = [
  { name: "a short prompt", text: "short", recalled: false },
  { name: "9 characters", text: "foo_bar x", recalled: false },
  { name: "exactly 10 characters", text: "foo_bar xy", recalled: true },
  { name: "a task notification", text: "<task-notification> something long enough", recalled: false },
  { name: "a typed prompt", text: "where is foo_bar defined", recalled: true },
];
for (const c of recallRows) {
  test(`recall: ${c.name}`, async ($, on) => {
    const { prompts, runs } = setup(on);
    await $.session.start({ source: "startup" });
    await prompt($, c.text);
    expect(runs.some((r) => r[1] === "memory" && r[2] === "search")).toBe(c.recalled);
    expect(prompts[0].context === undefined).toBe(!c.recalled);
  });
}

const codeRows = [
  { text: "how does the cache work", code: true },
  { text: "thanks, that is fine with me", code: false },
  { text: "please add a guard to the parser", code: true },
  // The old case "fix\nin" is shorter than 10 characters (no recall at all); same rule: `fix ... in` must be on one line.
  { text: "fix the parser\nin the morning", code: false },
  // /m: grep in the setup script matches line by line, so a later line counts too.
  { text: "thanks\nplease add a guard to the parser", code: true },
  { text: "ok fix it, then fix the bug in x", code: true },
  // Was a wall-clock check (linear on a long line); the kit's 5000 ms test timeout is the backstop. `parser` gives a search term.
  { text: `${"add ".repeat(80000)}parser`, code: false },
];
for (const c of codeRows) {
  test(`code pre-fetch: ${JSON.stringify(c.text.slice(0, 40))}`, async ($, on) => {
    const { calls, runs } = setup(on);
    await $.session.start({ source: "startup" });
    await prompt($, c.text);
    // the prompt was searched, so only the code rule decides about gm_search
    expect(runs.some((r) => r[2] === "search")).toBe(true);
    expect(calls.some((x) => x.tool.endsWith("__gm_search"))).toBe(c.code);
  });
}

const nudgeRows: { name: string; call: Record<string, unknown>; nudge: boolean }[] = [
  { name: "Grep", call: { tool: "Grep" }, nudge: true },
  { name: "rg after cd &&", call: { tool: "Bash", command: "cd src && rg foo" }, nudge: true },
  { name: "rg on a later line", call: { tool: "Bash", command: "cd src\nrg foo" }, nudge: true },
  { name: "graphmind itself", call: { tool: "Bash", command: "graphmind search foo" }, nudge: false },
  { name: "graphmind on any line", call: { tool: "Bash", command: "cd src\ngraphmind search foo\nrg bar" }, nudge: false },
  { name: "grep after a pipe", call: { tool: "Bash", command: "cat x | grep foo" }, nudge: false },
  { name: "an exhaustive search", call: { tool: "Bash", command: "grep -rn foo src", description: "find all usages of foo" }, nudge: false },
  { name: "a count", call: { tool: "Bash", command: "grep -rc foo src" }, nudge: false },
  { name: "an Explore agent", call: { tool: "Agent", subagent_type: "Explore" }, nudge: true },
  { name: "an agent that does not search", call: { tool: "Agent", prompt: "write the docs" }, nudge: false },
  { name: "Read", call: { tool: "Read" }, nudge: false },
];
for (const c of nudgeRows) {
  test(`nudge: ${c.name}`, async ($, on) => {
    setup(on);
    await $.session.start({ source: "startup" });
    const r = await toolCall($, c.call);
    expect((r.context ?? []).some((x) => /graphmind-indexed/.test(x))).toBe(c.nudge);
  });
}

/** 20 priority entries of about 300 characters (ids aaaaaaa0 to aaaaaa19): with BIG_MAP they overflow the 9000-character briefing. */
const BIG_LINES = Array.from({ length: 20 }, (_, i) => `★ ${String(i).padStart(8, "a")} [decision] entry${i} ${"x".repeat(280)}`);
const BIG_PRIORITY = `>> 20\n${BIG_LINES.join("\n")}\n`;
const BIG_MAP = Array.from({ length: 20 }, (_, i) => `  src/file${i}.ts ${"y".repeat(150)}`).join("\n");

// The hook always fits to MAX_CHARS = 9000: the old custom-budget edge (463 characters, a cut that removes only a newline) has no hook-level equivalent and is not ported.
test("output budget: a briefing over 9000 characters is cut, marked and stays within the budget", async ($, on) => {
  const { prompts } = setup(on, { priority: BIG_PRIORITY, map: BIG_MAP });
  await $.session.start({ source: "startup" });
  await prompt($, ASK);
  const first = prompts[0].context?.[0] ?? "";
  expect(first).toContain(CUT);
  expect(first.length).toBeLessThanOrEqual(9000);
});

test("output budget: the priority entries not shown whole in the briefing, and only those, are offered on the next prompt", async ($, on) => {
  const { prompts } = setup(on, { priority: BIG_PRIORITY, map: BIG_MAP });
  await $.session.start({ source: "startup" });
  await prompt($, ASK);
  const first = prompts[0].context?.[0] ?? "";
  const shown = BIG_LINES.filter((l) => first.includes(`${l}\n`));
  expect(shown.length).toBeGreaterThan(0);
  expect(shown.length).toBeLessThan(BIG_LINES.length);
  await prompt($, "something else entirely about parseConfig here");
  const second = (prompts[1].context ?? []).join("\n");
  expect(second).toContain("[graphmind ★ new priority context]");
  expect(BIG_LINES.filter((l) => second.includes(l))).toEqual(BIG_LINES.filter((l) => !shown.includes(l)));
});

// The old 8999-character edge (custom budget) is not reachable through the hook; two map texts one character apart put
// the 9000-character cut on both halves of an emoji's surrogate pair instead.
for (const map of [">> map\n  top file", ">> map\n  top files"]) {
  test(`output budget: the cut never splits an astral character (map of ${map.length} characters)`, async ($, on) => {
    const priority = `>> 20\n${Array.from({ length: 20 }, (_, i) => `★ ${String(i).padStart(8, "c")} [pattern] note ${"🚀".repeat(230)}`).join("\n")}\n`;
    const { prompts } = setup(on, { priority, map });
    await $.session.start({ source: "startup" });
    await prompt($, ASK);
    const first = prompts[0].context?.[0] ?? "";
    expect(first).toContain(CUT);
    expect(/\p{Cs}/u.test(first)).toBe(false);
  });
}

test("output budget: the closing line goes in as plain text, without a title line", async ($, on) => {
  const { prompts } = setup(on);
  await $.session.start({ source: "startup" });
  await prompt($, ASK);
  expect((prompts[0].context?.[0] ?? "").endsWith(`(id: x)\n\n${AUTO_MEMORY}`)).toBe(true);
});

const toolRows = [
  { name: "the plugin's own server", tools: OWN, prefix: "mcp__plugin_graphmind-helper_graphmind__gm_" },
  { name: "a graphmind setup server", tools: SETUP, prefix: "mcp__graphmind__gm_" },
  { name: "both servers: the plugin's own wins", tools: [...SETUP, ...OWN], prefix: "mcp__plugin_graphmind-helper_graphmind__gm_" },
  { name: "one of the four tools missing", tools: OWN.slice(1), prefix: "" },
  { name: "a server whose name lacks graphmind", tools: OTHER, prefix: "" },
];
for (const c of toolRows) {
  test(`tool names: ${c.name}`, async ($, on) => {
    const { prompts, calls } = setup(on, { tools: c.tools });
    await $.session.start({ source: "startup" });
    await prompt($, ASK);
    // "" = no usable tool set: nothing is called and nothing added
    expect(calls.length > 0).toBe(c.prefix !== "");
    expect(calls.every((x) => x.tool.startsWith(c.prefix))).toBe(true);
    expect(prompts[0].context === undefined).toBe(c.prefix === "");
  });
}
