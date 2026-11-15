// What jevfort offers Jev and what it carries (the request, the recent steps), through the built plugin/hooks/register.mjs:
// the next-action question's criteria are the offered candidates, the state of any question is the request and recent steps.
import type { On } from "claude-engine-vitest";
import { expect } from "vitest";
import { claudeBeneath, CWD, DEFAULTS, drain, makeKit, type Msg, type Runner, type SetupOpts, step, user } from "./support/kit.ts";

// Candidates are offered from the first step of a turn; takeOnlyForBypass off so a Read is offered, not taken.
const { test: kitTest, setup } = makeKit({ ...DEFAULTS, takeOnlyForBypass: false });

/** One turn step: the messages, what Jev was asked, and the next-action question's criteria keys when it was asked. */
async function ask($: Runner, on: On, messages: Msg[], extra: Partial<SetupOpts> = {}) {
  const { sent } = setup(on, { messages, jev: () => undefined, ...extra });
  claudeBeneath(on, []);
  await drain($.turn.step(step));
  const next = sent.find((q) => q.id === "next_action");
  return { sent, keys: next ? Object.keys(next.criteria as object) : [] };
}

/** The request the questions carried (every question's state holds it). */
const requestOf = (sent: { state: string }[]) => (sent.length ? (JSON.parse(sent[0].state) as { request: string }).request : undefined);
/** The criteria of a question as a map from option to description (empty when it has none). */
const criteriaOf = (q: { criteria?: unknown } | undefined): Record<string, string> => (q?.criteria ?? {}) as Record<string, string>;
/** The read candidates among the keys. */
const reads = (keys: string[]) => keys.filter((k) => k.startsWith("read "));
/** The search candidates among the keys. */
const searches = (keys: string[]) => keys.filter((k) => k.startsWith("run grep"));
const user1 = (text: string) => [user(text)];

kitTest("quoted terms become searches, file names do not", async ($, on) => {
  const { keys } = await ask($, on, user1("where is `useAuth` used? and \"TODO: fix\" in `src/app.ts`"), { files: [`${CWD}/src/app.ts`] });
  // the search key is `run grep … -- '<term>' .`: the term is the part after `--`
  expect(searches(keys).map((k) => k.split(" -- ")[1])).toEqual(["'useAuth' .", "'TODO: fix' ."]);
  expect(reads(keys)).toEqual(["read src/app.ts"]);
});

kitTest("a quoted term with an apostrophe is not searched", async ($, on) => {
  const { keys } = await ask($, on, user1("don't search `it's`"));
  expect(searches(keys)).toEqual([]);
});

kitTest("paths with extensions are found in text, numbers and URLs are not", async ($, on) => {
  const { keys } = await ask($, on, user1("look at src/app.ts and ./README.md, not v1.2 or https://x.io/a.js"), {
    files: [`${CWD}/src/app.ts`, `${CWD}/README.md`, `${CWD}/v1.2`, `${CWD}/x.io/a.js`],
  });
  expect(reads(keys)).toEqual(["read src/app.ts", "read ./README.md"]);
});

kitTest("the tail of a quoted path with a space is not offered as another file", async ($, on) => {
  const { keys } = await ask($, on, user1("what does \"docs/my notes.md\" say?"), { files: [`${CWD}/docs/my notes.md`] });
  expect(reads(keys)).toEqual([]);
});

kitTest("a file named in backticks with a space before it is not split off", async ($, on) => {
  const { keys } = await ask($, on, user1("see `my notes.md` and \"src/app.ts\""), { files: [`${CWD}/notes.md`, `${CWD}/src/app.ts`] });
  expect(reads(keys)).toEqual(["read src/app.ts"]);
});

kitTest("a path inside a longer quoted phrase is still found", async ($, on) => {
  const { keys } = await ask($, on, user1("\"fix the bug in src/app.ts\""), { files: [`${CWD}/src/app.ts`] });
  expect(reads(keys)).toEqual(["read src/app.ts"]);
});

kitTest("a path inside a backtick phrase is still found", async ($, on) => {
  const { keys } = await ask($, on, user1("`cat the file src/app.ts`"), { files: [`${CWD}/src/app.ts`] });
  expect(reads(keys)).toEqual(["read src/app.ts"]);
});

for (const text of ["explain src/app.ts.", "what is in src/app.ts?", "src/app.ts!", "see (src/app.ts)."]) {
  kitTest(`a path at the end of a sentence is found: "${text}"`, async ($, on) => {
    const { keys } = await ask($, on, user1(text), { files: [`${CWD}/src/app.ts`] });
    expect(reads(keys)).toEqual(["read src/app.ts"]);
  });
}

kitTest("cutting the request never leaves a lone surrogate when the cut falls inside an emoji", async ($, on) => {
  const { sent } = await ask($, on, user1(`${"x".repeat(3999)}🚀 rest of request`));
  const request = requestOf(sent) ?? "";
  expect(request.startsWith("x".repeat(3999))).toBe(true);
  expect(request).toContain("more chars]");
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(request)).toBe(false);
});

kitTest("shell output rows are not taken as the request", async ($, on) => {
  // Live (2.1.325): a `!` command starts a turn of its own, so the prompt before it is not what that turn answers.
  const { sent } = await ask($, on, [user("delete the folder /tmp/x"), user("<bash-input>mkdir -p /tmp/x</bash-input>"), user("<bash-stdout>(Bash completed with no output)</bash-stdout>")]);
  expect(sent).toEqual([]);
});

kitTest("local command output is skipped and the prompt before it stands", async ($, on) => {
  const { sent } = await ask($, on, [user("delete the folder /tmp/x"), user("<local-command-stdout>Total cost: $0.01</local-command-stdout>")]);
  expect(requestOf(sent)).toBe("delete the folder /tmp/x");
});

kitTest("task notifications are not taken as the request", async ($, on) => {
  const { sent } = await ask($, on, [user("run the tests"), user("<task-notification>\n<summary>Background command \"Run the benchmark\" completed</summary>")]);
  expect(requestOf(sent)).toBe("run the tests");
});

kitTest("temp, task-output and Claude config paths are never offered for reading", async ($, on) => {
  const paths = ["/private/tmp/claude-503/-Users-x/abc/tasks/a889.output", "/tmp/jev-gate-test/notes.txt", "/Users/nimf/.claude/settings.json", "/var/folders/ab/T/claude/notes.txt"];
  const { keys } = await ask($, on, user1(`read ${paths.join(" and ")}`), { files: paths });
  expect(reads(keys)).toEqual([]);
});

kitTest("a project inside a temp dir can still be read; its transcripts cannot", async ($, on) => {
  const cwd = "/private/tmp/claude-503/x/scratchpad/ab2/routine-with-1";
  const { keys } = await ask($, on, user1(`read ${cwd}/todo.js and ${cwd}/tasks/a1.output and /private/tmp/other/notes.txt`), {
    cwd: () => cwd,
    files: [`${cwd}/todo.js`, `${cwd}/tasks/a1.output`, "/private/tmp/other/notes.txt"],
  });
  expect(reads(keys)).toEqual([`read ${cwd}/todo.js`]);
});

kitTest("a `..` path is never offered", async ($, on) => {
  const { keys } = await ask($, on, user1("read ../.aws/config.json and a/../b.ts"), { files: ["/proj/../.aws/config.json", "/proj/b.ts"] });
  expect(reads(keys)).toEqual([]);
});

// The scanner does not mention a name with `..` in it at all (isSafeToOffer alone would keep such a name); through the
// hook that is only observable as "not offered". The old unit assertion on isSafeToOffer has no hook-level equivalent.
kitTest("a name with `..` inside it is not offered by the scanner", async ($, on) => {
  const { keys } = await ask($, on, user1("read /proj/a..b/c.ts"), { files: [`${CWD}/a..b/c.ts`] });
  expect(reads(keys)).toEqual([]);
});

kitTest("Claude's config and credentials are never offered, also with cwd at $HOME", async ($, on) => {
  const paths = ["/home/u/.claude/.credentials.json", "/home/u/.claude/settings.json", "/home/u/.claude.json", "/home/u/.claude/projects/-home-u/memory/MEMORY.md", "/home/u/.claude/settings.local.json"];
  const { keys } = await ask($, on, user1(`read ${paths.join(" and ")} and /home/u/notes.md`), { cwd: () => "/home/u", files: [...paths, "/home/u/notes.md"] });
  expect(reads(keys)).toEqual(["read /home/u/notes.md"]);
});

kitTest("Claude's config is never offered with a case or backup variant", async ($, on) => {
  const paths = ["/home/u/.claude/settings.json.bak", "/home/u/.CLAUDE.json", "/home/u/.claude/Settings.json", "/home/u/.claude/.credentials.json~"];
  const { keys } = await ask($, on, user1(`read ${paths.join(" and ")}`), { cwd: () => "/home/u", files: paths });
  expect(reads(keys)).toEqual([]);
});

kitTest("Claude's transcripts and tasks are never offered inside a project, in any case", async ($, on) => {
  const paths = ["/home/u/proj/tasks/a1.OUTPUT", "/home/u/notes/a.JSONL"];
  const { keys } = await ask($, on, user1(`read ${paths.join(" and ")}`), { cwd: () => "/home/u/proj", files: paths });
  expect(reads(keys)).toEqual([]);
});

const SKILLS = [
  { name: "youtube-metadata", description: "Generate optimized YouTube video metadata including titles, tags, and descriptions", source: "user" },
  { name: "youtube-plugin:youtube-metadata", description: "Generate optimized YouTube video metadata including titles, tags, and descriptions", source: "plugin" },
  { name: "anthropic-skills:pdf", description: "Use this skill whenever the user wants to do anything with PDF files", source: "plugin" },
  { name: "pdf", description: "Use this skill whenever the user wants to do anything with PDF files", source: "user" },
  { name: "i-have-adhd:i-have-adhd", description: "Shape output for a reader with ADHD", source: "plugin" },
  { name: "chrome-browser", description: "Read this skill before the first step that uses Claude in Chrome, the browser extension", source: "user" },
];
/** The skill candidates among the keys. */
const skills = (keys: string[]) => keys.filter((k) => k.startsWith("skill "));

kitTest("a skill listed under two names is offered once, unprefixed", async ($, on) => {
  on("command.list", () => ({ value: SKILLS }));
  const { keys } = await ask($, on, user1("write youtube titles for my video"));
  expect(skills(keys)).toEqual(["skill youtube-metadata"]);
});

kitTest("two plugins' skills sharing a base name are both kept", async ($, on) => {
  on("command.list", () => ({
    value: [
      { name: "git-tools:review", description: "Review a pull request diff for correctness bugs", source: "plugin" },
      { name: "docs-kit:review", description: "Proofread markdown documentation for typos and grammar", source: "plugin" },
    ],
  }));
  const { keys } = await ask($, on, user1("review the pull request diff"));
  expect(skills(keys)).toEqual(["skill git-tools:review", "skill docs-kit:review"]);
});

kitTest("only skills whose name or description share a word with the prompt are offered", async ($, on) => {
  on("command.list", () => ({ value: [{ name: "pdf-merge", description: "merge pdf files", source: "user" }, { name: "other", description: "merge things into one", source: "user" }] }));
  const { keys } = await ask($, on, user1("merge pdf"));
  expect(skills(keys)).toEqual(["skill pdf-merge"]);
});

for (
  const [prompt, expected] of [
    ["can you show me the full list", []],
    ["run the tests", []],
    ["write youtube titles for my video", ["skill youtube-metadata"]],
    ["merge these two pdfs", ["skill pdf"]],
    ["open the page in chrome", ["skill chrome-browser"]],
  ] as const
) {
  kitTest(`only related skills are offered: "${prompt}"`, async ($, on) => {
    on("command.list", () => ({ value: SKILLS }));
    const { keys } = await ask($, on, user1(prompt));
    expect(skills(keys)).toEqual(expected);
  });
}

kitTest("two stopwords alone do not make a skill related", async ($, on) => {
  on("command.list", () => ({ value: [{ name: "deploy", description: "Run the deploy pipeline", source: "user" }] }));
  const { keys } = await ask($, on, user1("run the tests"));
  expect(skills(keys)).toEqual([]);
});

kitTest("words keep umlauts whole: a German prompt finds the German skill", async ($, on) => {
  on("command.list", () => ({ value: [{ name: "groesse", description: "Größe ändern", source: "user" }] }));
  const { keys } = await ask($, on, user1("Größe ändern"));
  expect(skills(keys)).toEqual(["skill groesse"]);
});

kitTest("words keep combining marks inside words (NFD umlauts)", async ($, on) => {
  on("command.list", () => ({ value: [{ name: "übersetzung", description: "Prüfe Übersetzungen gründlich", source: "user" }] }));
  const { keys } = await ask($, on, user1("Übersetzung gründlich prüfen".normalize("NFD")));
  expect(skills(keys)).toEqual(["skill übersetzung"]);
});

kitTest("words keep Devanagari vowel signs inside words", async ($, on) => {
  on("command.list", () => ({ value: [{ name: "anuvad", description: "हिन्दी अनुवाद जाँचें", source: "user" }] }));
  const { keys } = await ask($, on, user1("हिन्दी अनुवाद जाँचें"));
  expect(skills(keys)).toEqual(["skill anuvad"]);
});

kitTest("a path named in an earlier step stays offered until it is read, and a new one is added", async ($, on) => {
  const messages = user1("see a/one.ts");
  const { sent } = setup(on, { messages, jev: () => undefined, files: [`${CWD}/a/one.ts`, `${CWD}/b/two.ts`] });
  claudeBeneath(on, []);
  await drain($.turn.step(step));
  const first = sent.find((q) => q.id === "next_action");
  expect(reads(Object.keys(criteriaOf(first)))).toEqual(["read a/one.ts"]);
  messages.push(user("and b/two.ts, a/one.ts"));
  const before = sent.length;
  await drain($.turn.step({ ...step, index: 1, messageCount: 2 }));
  const second = sent.slice(before).find((q) => q.id === "next_action");
  // the earlier path is offered again (no Read of it yet); the candidates are a set, the order is not the point
  expect(reads(Object.keys(criteriaOf(second))).sort()).toEqual(["read a/one.ts", "read b/two.ts"]);
});

kitTest("a summary of the recent steps keeps only the last 8 entries, and old rows are never serialized", async ($, on) => {
  const poison = {
    toJSON: () => {
      throw new Error("old row serialized");
    },
  };
  const row = (n: number, input: Record<string, unknown> = { n }): Msg => ({ role: "assistant", text: `t${n}`, toolUses: [{ tool_use_id: `c${n}`, tool: "Read", input, text: `r${n}` }] });
  const messages: Msg[] = [user("fix the bug"), row(0, poison), row(1, poison), ...Array.from({ length: 5 }, (_, i) => row(i + 2))];
  const { sent } = await ask($, on, messages);
  const recent = (JSON.parse(sent[0].state) as { recent: unknown[] }).recent;
  expect(recent).toHaveLength(8);
  expect(recent[0]).toEqual({ assistant: "t3" });
  expect(recent[7]).toEqual({ tool: "Read", input: "{\"n\":6}", result: "r6" });
});

kitTest("the summary keeps the caps: inputs 300 and results 400 characters, errors kept", async ($, on) => {
  const big = "x".repeat(5000);
  const wide = (n: number): Msg => ({
    role: "assistant",
    text: `t${n}`,
    toolUses: [
      { tool_use_id: `w${n}a`, tool: "Read", input: { big }, text: big },
      { tool_use_id: `w${n}b`, tool: "Bash", input: { big }, text: big, isError: true },
      { tool_use_id: `w${n}c`, tool: "Grep", input: { big }, text: big },
    ],
  });
  const small: Msg = { role: "assistant", text: "s", toolUses: [{ tool_use_id: "s", tool: "Read", input: {}, text: "r" }] };
  // 4 + 2 + 4 entries from the end: the loop overshoots 8, only the slice trims it.
  const { sent } = await ask($, on, [user("fix the bug"), wide(0), small, wide(1)]);
  const recent = (JSON.parse(sent[0].state) as { recent: { tool?: string; input?: string; result?: string; isError?: true }[] }).recent;
  expect(recent).toHaveLength(8);
  expect(recent[0]).toMatchObject({ tool: "Bash" });
  const note = (s: string) => /… \[\d+ more chars\]$/.exec(s)?.[0].length ?? 0;
  const tools = recent.filter((e) => "tool" in e) as { input: string; result?: string; isError?: true }[];
  for (const e of tools.filter((t) => t.input.length > 2)) {
    expect(note(e.input)).toBeGreaterThan(0);
    expect(e.input.length).toBeLessThanOrEqual(300 + note(e.input));
    expect(note(e.result ?? "")).toBeGreaterThan(0);
    expect((e.result ?? "").length).toBeLessThanOrEqual(400 + note(e.result ?? ""));
  }
  expect(tools.filter((t) => t.isError)).toHaveLength(2);
});

/** The project script candidates among the keys (`run npm …`). */
const scripts = (keys: string[]) => keys.filter((k) => k.startsWith("run npm")).sort();

kitTest("only safe project scripts are offered: no fixers, watchers or dev servers", async ($, on) => {
  const names = ["lint:fix", "lint:write", "lint:prettier:fix", "test:update", "test:u", "test:update-snapshots", "test:watch", "test:dev", "test:watchAll", "lint:autofix", "lint:fixAll", "lint:eslint_fix", "test:e2e:ui", "test:UI", "test:open", "test:debug", "test:updateSnapshot", "lint:CSSFix", "test:E2EWatch"];
  const safe = ["test", "lint", "build", "test:unit", "lint:types", "test:e2e", "test:unit:ci", "type-check", "test:typesOnly"];
  const packageJson = { scripts: Object.fromEntries([...names, ...safe].map((n) => [n, "echo"])) };
  const { keys } = await ask($, on, user1("run the project checks"), { packageJson });
  expect(scripts(keys)).toEqual(safe.map((n) => (n === "test" ? "run npm test" : `run npm run ${n}`)).sort());
});

kitTest("only the Makefile's safe targets are offered", async ($, on) => {
  const targets = ["test", "tests", "check", "lint", "build", "typecheck", "lint-fix", "test-update", "build-and-push", "testwatch", "deploy", "pre-test"];
  const makefile = targets.map((t) => `${t}:\n\techo ${t}\n`).join("\n");
  const { keys } = await ask($, on, user1("run the project checks"), { makefile });
  expect(keys.filter((k) => k.startsWith("run make ")).sort()).toEqual(["run make build", "run make check", "run make lint", "run make test", "run make tests", "run make typecheck"]);
});

kitTest("a script's description cuts its command at 79 characters and never leaves a lone surrogate", async ($, on) => {
  const packageJson = { scripts: { lint: `${"x".repeat(79)}🚀 tail` } };
  const { sent, keys } = await ask($, on, user1("run the project checks"), { packageJson });
  const next = sent.find((q) => q.id === "next_action");
  const description = criteriaOf(next)["run npm run lint"];
  expect(keys).toContain("run npm run lint");
  expect(description).toBe(`Run the project's "lint" script (${"x".repeat(79)}…)`);
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(description)).toBe(false);
});

kitTest("a Bash call just made is not offered again, even with a trailing space in it", async ($, on) => {
  const packageJson = { scripts: { test: "node --test", build: "tsc" } };
  const messages: Msg[] = [user("run the project checks"), { role: "assistant", text: "", toolUses: [{ tool_use_id: "b1", tool: "Bash", input: { command: "npm test " }, text: "ok" }] }];
  const { keys } = await ask($, on, messages, { packageJson });
  expect(scripts(keys)).toEqual(["run npm run build"]);
});

kitTest("a call that differs in its argument is still offered", async ($, on) => {
  const packageJson = { scripts: { test: "node --test" } };
  const messages: Msg[] = [user("run the project checks"), { role: "assistant", text: "", toolUses: [{ tool_use_id: "b2", tool: "Bash", input: { command: "npm run build" }, text: "ok" }] }];
  const { keys } = await ask($, on, messages, { packageJson });
  expect(scripts(keys)).toEqual(["run npm test"]);
});

kitTest("a related skill the last call did not invoke is still offered", async ($, on) => {
  on("command.list", () => ({ value: [{ name: "pdf", description: "Use this skill whenever the user wants to do anything with PDF files", source: "user" }] }));
  const messages: Msg[] = [user("merge these two pdfs"), { role: "assistant", text: "", toolUses: [{ tool_use_id: "s2", tool: "Skill", input: { skill: "docx" }, text: "ok" }] }];
  const { keys } = await ask($, on, messages);
  expect(skills(keys)).toEqual(["skill pdf"]);
});

kitTest("the same skill as the last call is not offered again", async ($, on) => {
  on("command.list", () => ({ value: [{ name: "pdf", description: "Use this skill whenever the user wants to do anything with PDF files", source: "user" }] }));
  const messages: Msg[] = [user("merge these two pdfs"), { role: "assistant", text: "", toolUses: [{ tool_use_id: "s3", tool: "Skill", input: { skill: "pdf" }, text: "ok" }] }];
  const { keys } = await ask($, on, messages);
  expect(skills(keys)).toEqual([]);
});

// relevant() scans the prompt's words against the skill list once: a pasted log must not cost ten times the prompt's own scan.
kitTest("relevant stays fast on a pasted log with many skills", async ($, on) => {
  const many = Array.from({ length: 300 }, (_, i) => ({ name: `tool-${i}`, description: `does thing ${i} with files`, source: "user" }));
  const log = `look at this log ${Array.from({ length: 50_000 }, (_, i) => `req${i.toString(36)}x`).join(" ")}`;
  // The skill list is read once per turn, so each timed turn gets its own turn id; the list is set before any `$` use.
  let skillsList: typeof many = [];
  setup(on, { messages: user1(log), jev: () => undefined });
  on("command.list", () => ({ value: skillsList }));
  claudeBeneath(on, []);
  const time = async (turn: number) => {
    const t = performance.now();
    await drain($.turn.step({ ...step, turnId: `turn-${turn}` }));
    return performance.now() - t;
  };
  let n = 0;
  const best = async (list: typeof many) => {
    skillsList = list;
    return Math.min(await time(n++), await time(n++), await time(n++));
  };
  const base = await best([]);
  const withSkills = await best(many);
  expect(withSkills).toBeLessThan(3 * base);
});

const typed = (text: string): Msg => user(text);
const reply: Msg = { role: "assistant", text: "ok", toolUses: [] };

kitTest("a slash command that started a turn is the request, arguments raw", async ($, on) => {
  const { sent } = await ask($, on, [typed("Thanks!"), reply, typed("<command-message>audit</command-message>\n<command-name>/audit</command-name>\n<command-args>src</command-args>")]);
  expect(requestOf(sent)).toBe("/audit src");
});

kitTest("a `<` in a command's arguments does not cut them", async ($, on) => {
  const { sent } = await ask($, on, [typed("Thanks!"), typed("<command-message>fix</command-message>\n<command-name>/fix</command-name>\n<command-args>the <Button> props, Map<string, number></command-args>")]);
  expect(requestOf(sent)).toBe("/fix the <Button> props, Map<string, number>");
});

kitTest("a typed prompt that starts with a pasted tag is the request itself", async ($, on) => {
  const { sent } = await ask($, on, [typed("Thanks!"), typed("<system-reminder>x</system-reminder>\nWhy is this added?")]);
  expect(requestOf(sent)).toBe("<system-reminder>x</system-reminder>\nWhy is this added?");
});

kitTest("a `</command-args>` inside the arguments stays in them", async ($, on) => {
  const { sent } = await ask($, on, [typed("Thanks!"), typed("<command-message>fix</command-message>\n<command-name>/fix</command-name>\n<command-args>why does </command-args> end it</command-args>")]);
  expect(requestOf(sent)).toBe("/fix why does </command-args> end it");
});

kitTest("a local command (no turn of its own) leaves the prompt before it as the request", async ($, on) => {
  const local = typed("<command-name>/jev</command-name>\n<command-args></command-args>");
  const { sent } = await ask($, on, [typed("Thanks!"), reply, local]);
  expect(requestOf(sent)).toBe("Thanks!");
});

kitTest("a notice after a local command does not make it a turn", async ($, on) => {
  const local = typed("<command-name>/jev</command-name>\n<command-args></command-args>");
  const { sent } = await ask($, on, [typed("Thanks!"), reply, local, typed("<task-notification>done</task-notification>")]);
  expect(requestOf(sent)).toBe("Thanks!");
});

kitTest("a command row with a long run of blanks in its name is read in linear time, blanks around the name are trimmed", async ($, on) => {
  // A lazy name group beside `\s*` took 2 s at 2000 blanks and grows cubically: a pasted prompt could hang the hook.
  const t = performance.now();
  const { sent } = await ask($, on, [typed("Thanks!"), typed(`<command-message>x</command-message><command-name>${" ".repeat(20_000)}y`)]);
  expect(requestOf(sent)).toBe("Thanks!");
  expect(performance.now() - t).toBeLessThan(500);
});

kitTest("blanks around a command name are trimmed in the request", async ($, on) => {
  const { sent } = await ask($, on, [typed("<command-message>f</command-message>\n<command-name> /f\n</command-name>\n<command-args> a </command-args>")]);
  expect(requestOf(sent)).toBe("/f a");
});

kitTest("a compaction summary is not the request, the prompt before it is", async ($, on) => {
  const summary = typed("This session is being continued from a previous conversation that ran out of context. The summary below covers...");
  const { sent } = await ask($, on, [typed("fix the bug"), reply, summary]);
  expect(requestOf(sent)).toBe("fix the bug");
});

kitTest("a summary that starts the turn is the request", async ($, on) => {
  const summary = typed("This session is being continued from a previous conversation that ran out of context. The summary below covers...");
  const { sent } = await ask($, on, [summary, reply]);
  expect(requestOf(sent)).toContain("This session is being continued");
});

kitTest("an interrupt marker is no request", async ($, on) => {
  const { sent } = await ask($, on, [typed("fix the bug"), reply, typed("[Request interrupted by user]")]);
  expect(sent).toEqual([]);
});

kitTest("a bang command with its output is no request", async ($, on) => {
  const { sent } = await ask($, on, [typed("fix the bug"), reply, typed("<bash-input>echo hi</bash-input>"), typed("<bash-stdout>hi</bash-stdout><bash-stderr></bash-stderr>")]);
  expect(sent).toEqual([]);
});

kitTest("an image-only prompt is no request", async ($, on) => {
  const { sent } = await ask($, on, [typed("what colour?"), reply, typed("")]);
  expect(sent).toEqual([]);
});

kitTest("a tool search just made is not offered again, a different one is", async ($, on) => {
  const tools = [{ name: "mcp__jev-api__batch", description: "Ask Jev", mcp: true }, { name: "slack-tools", description: "Slack messages", mcp: true }];
  const search = (query: string): Msg => ({ role: "assistant", text: "", toolUses: [{ tool_use_id: "t1", tool: "ToolSearch", input: { query, max_results: 1 }, text: "ok" }] });
  const again = await ask($, on, [user("send a slack message"), search("select:slack-tools")], { tools });
  expect(again.keys.filter((k) => k.startsWith("load "))).toEqual([]);
});

kitTest("a tool search for another tool does not hide the related one", async ($, on) => {
  const tools = [{ name: "mcp__jev-api__batch", description: "Ask Jev", mcp: true }, { name: "slack-tools", description: "Slack messages", mcp: true }];
  const other: Msg = { role: "assistant", text: "", toolUses: [{ tool_use_id: "t2", tool: "ToolSearch", input: { query: "select:gmail-tools", max_results: 1 }, text: "ok" }] };
  const { keys } = await ask($, on, [user("send a slack message"), other], { tools });
  expect(keys.filter((k) => k.startsWith("load "))).toEqual(["load slack-tools"]);
});
