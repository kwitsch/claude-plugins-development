// Pure logic of the built plugin/hooks/{candidates,report,context,policy}.mjs: upstream jev-pilot tests/candidates.test.ts.
import { expect, test } from "vitest";
import { commandKey, coversStep, dedupeSkills, isSafeToOffer, mentionedPaths, quotedTerms, relevant, words } from "../plugin/hooks/candidates.mjs";
import { splitTurn } from "../plugin/hooks/context.mjs";
import { route } from "../plugin/hooks/policy.mjs";
import { buildReport, when } from "../plugin/hooks/report.mjs";

test("quoted terms become searches, file names do not", () => {
  expect(quotedTerms("where is `useAuth` used? and \"TODO: fix\" in `src/app.ts`")).toEqual(["useAuth", "TODO: fix"]);
  expect(quotedTerms("don't search `it's`")).toEqual([]);
});

test("paths with extensions are found in text", () => {
  expect(mentionedPaths(["look at src/app.ts and ./README.md, not v1.2 or https://x.io/a.js"])).toEqual(["src/app.ts", "./README.md"]);
});

test("an empty log gives a hint, not a crash", () => {
  expect(buildReport([], 0.85)).toContain("the log is empty");
  expect(buildReport([], 0.85)).not.toContain("shadow");
});

test("shell output and slash-command rows are not taken as the request", () => {
  // Live (2.1.325): a `!` command starts a turn of its own, so the prompt before it is not what that turn answers.
  const turn = splitTurn([
    { role: "user", text: "delete the folder /tmp/x", toolUses: [] },
    { role: "user", text: "<bash-input>mkdir -p /tmp/x</bash-input>", toolUses: [] },
    { role: "user", text: "<bash-stdout>(Bash completed with no output)</bash-stdout>", toolUses: [] },
  ]);
  expect(turn).toBeUndefined();
  // Output of a local command (no bash-input) is skipped and the prompt before it stands.
  const local = splitTurn([
    { role: "user", text: "delete the folder /tmp/x", toolUses: [] },
    { role: "user", text: "<local-command-stdout>Total cost: $0.01</local-command-stdout>", toolUses: [] },
  ]);
  expect(local?.request).toBe("delete the folder /tmp/x");
});

test("times show HH:MM, with the date when not on the latest entry's day", () => {
  const latest = new Date(2026, 9, 14, 15, 30).getTime();
  expect(when(new Date(2026, 9, 14, 9, 5).getTime(), latest)).toBe("09:05");
  expect(when(new Date(2026, 9, 13, 23, 59).getTime(), latest)).toBe("10-13 23:59");
});

test("temp, task-output and Claude config paths are never offered for reading", () => {
  expect(isSafeToOffer("/private/tmp/claude-503/-Users-x/abc/tasks/a889.output")).toBe(false);
  expect(isSafeToOffer("/tmp/jev-gate-test/notes.txt")).toBe(false);
  expect(isSafeToOffer("/Users/nimf/.claude/settings.json")).toBe(false);
  expect(isSafeToOffer("/Users/nimf/Work/jev-demo/todo-app/todo.js")).toBe(true);
});

test("a project inside a temp dir can still be read; its transcripts cannot", () => {
  const cwd = "/private/tmp/claude-503/x/scratchpad/ab2/routine-with-1";
  expect(isSafeToOffer(`${cwd}/todo.js`, cwd)).toBe(true);
  expect(isSafeToOffer(`${cwd}/tasks/a1.output`, cwd)).toBe(false);
  expect(isSafeToOffer("/private/tmp/other/notes.txt", cwd)).toBe(false);
});

test("task notifications and reminders are not taken as the request", () => {
  const turn = splitTurn([
    { role: "user", text: "run the tests", toolUses: [] },
    { role: "user", text: "<task-notification>\n<summary>Background command \"Run the benchmark\" completed</summary>", toolUses: [] },
  ]);
  expect(turn?.request).toBe("run the tests");
});

const SKILLS = [
  { name: "youtube-metadata", description: "Generate optimized YouTube video metadata including titles, tags, and descriptions" },
  { name: "youtube-plugin:youtube-metadata", description: "Generate optimized YouTube video metadata including titles, tags, and descriptions" },
  { name: "anthropic-skills:pdf", description: "Use this skill whenever the user wants to do anything with PDF files" },
  { name: "pdf", description: "Use this skill whenever the user wants to do anything with PDF files" },
  { name: "i-have-adhd:i-have-adhd", description: "Shape output for a reader with ADHD" },
  { name: "chrome-browser", description: "Read this skill before the first step that uses Claude in Chrome, the browser extension" },
];

test("a skill listed under two names is offered once, unprefixed", () => {
  expect(dedupeSkills(SKILLS).map((s) => s.name)).toEqual(["youtube-metadata", "pdf", "i-have-adhd:i-have-adhd", "chrome-browser"]);
});

test("relevant scores a name word 2 (once, also when the description repeats it), a description word 1, and stays fast on a pasted log", () => {
  const items = [{ name: "pdf-merge", description: "merge pdf files" }, { name: "other", description: "merge things into one" }];
  expect(relevant("merge pdf", items).map((i) => i.name)).toEqual(["pdf-merge"]);
  // 300 items against 2 MB of distinct words took 1.7 s when the loop ran over the prompt's words.
  const many = Array.from({ length: 300 }, (_, i) => ({ name: `tool-${i}`, description: `does thing ${i} with files` }));
  const log = Array.from({ length: 200_000 }, (_, i) => `req${i.toString(36)}x`).join(" ");
  const t = performance.now();
  relevant(`look at this log ${log}`, many);
  expect(performance.now() - t).toBeLessThan(800);
});

test("a slash command that started a turn is the request, a local command is not", () => {
  const typed = (text: string) => ({ role: "user" as const, text, toolUses: [] });
  const skill = typed("<command-message>audit</command-message>\n<command-name>/audit</command-name>\n<command-args>src</command-args>");
  expect(splitTurn([typed("Thanks!"), { role: "assistant", text: "ok", toolUses: [] }, skill])?.request).toBe("/audit src");
  // Arguments are raw text: a `<` in them must not cut them.
  const angle = typed("<command-message>fix</command-message>\n<command-name>/fix</command-name>\n<command-args>the <Button> props, Map<string, number></command-args>");
  expect(splitTurn([typed("Thanks!"), angle])?.request).toBe("/fix the <Button> props, Map<string, number>");
  // A prompt the person typed that merely starts with a pasted tag is their request; `</command-args>` inside arguments stays.
  expect(splitTurn([typed("Thanks!"), typed("<system-reminder>x</system-reminder>\nWhy is this added?")])?.request).toBe("<system-reminder>x</system-reminder>\nWhy is this added?");
  const closing = typed("<command-message>fix</command-message>\n<command-name>/fix</command-name>\n<command-args>why does </command-args> end it</command-args>");
  expect(splitTurn([typed("Thanks!"), closing])?.request).toBe("/fix why does </command-args> end it");
  // A local command (`<command-name>` first) starts no turn, whether the last row is it or a notice after it.
  const local = typed("<command-name>/jev</command-name>\n<command-args></command-args>");
  expect(splitTurn([typed("Thanks!"), { role: "assistant", text: "ok", toolUses: [] }, local])?.request).toBe("Thanks!");
  expect(splitTurn([typed("Thanks!"), { role: "assistant", text: "ok", toolUses: [] }, local, typed("<task-notification>done</task-notification>")])?.request).toBe("Thanks!");
});

test("rows that are no request: compaction summary, interrupt, a bang command, an image-only prompt", () => {
  const typed = (text: string) => ({ role: "user" as const, text, toolUses: [] });
  const reply = { role: "assistant" as const, text: "ok", toolUses: [] };
  const summary = typed("This session is being continued from a previous conversation that ran out of context. The summary below covers...");
  expect(splitTurn([typed("fix the bug"), reply, summary])?.request).toBe("fix the bug");
  expect(splitTurn([summary, reply])?.request).toContain("This session is being continued");
  expect(splitTurn([typed("fix the bug"), reply, typed("[Request interrupted by user]")])).toBeUndefined();
  expect(splitTurn([typed("fix the bug"), reply, typed("<bash-input>echo hi</bash-input>"), typed("<bash-stdout>hi</bash-stdout><bash-stderr></bash-stderr>")])).toBeUndefined();
  expect(splitTurn([typed("what colour?"), reply, typed("")])).toBeUndefined();
});

test("only skills related to the prompt are offered", () => {
  const skills = dedupeSkills(SKILLS);
  expect(relevant("can you show me the full list", skills)).toEqual([]);
  expect(relevant("run the tests", skills)).toEqual([]);
  expect(relevant("write youtube titles for my video", skills).map((s) => s.name)).toEqual(["youtube-metadata"]);
  expect(relevant("merge these two pdfs", skills).map((s) => s.name)).toEqual(["pdf"]);
  expect(relevant("open the page in chrome", skills).map((s) => s.name)).toEqual(["chrome-browser"]);
});

test("commands compare by what they run, not how the output is filtered", () => {
  expect(commandKey("npm test 2>&1 | grep -E '^(ok|not ok)'")).toBe(commandKey("npm test"));
  expect(commandKey("cd /x/todo-app && npm test")).toBe("npm test");
  expect(commandKey("git status; git diff --stat | head -40")).toBe(commandKey("git status --short && git diff --stat"));
  expect(commandKey("git log --oneline -5")).toBe(commandKey("git log --oneline -n 15"));
  expect(commandKey("npm run lint")).not.toBe(commandKey("npm run build"));
  expect(commandKey("git diff")).not.toBe(commandKey("git status --short && git diff --stat"));
});

test("a step matches only when Jev's one action would replace all of it", () => {
  const jev = { tool: "Bash", input: { command: "npm test" } };
  expect(coversStep([{ tool: "Bash", input: { command: "npm test 2>&1 | tail -20" } }], jev)).toBe(true);
  expect(coversStep([{ tool: "Bash", input: { command: "ls && cat package.json && npm test" } }], jev)).toBe(false);
  expect(coversStep([{ tool: "Bash", input: { command: "npm test" } }, { tool: "Read", input: { file_path: "/a" } }], jev)).toBe(false);
});

const rated = (score: number, confidence = 0.9) => ({ type: "score" as const, score, probabilities: {}, confidence });

test("route: in model mode trivial goes to Haiku and routine to Sonnet; effort mode only rates", () => {
  expect(route(rated(0.95), "model")).toEqual({ level: 0.95, model: "claude-haiku-5-5" });
  expect(route(rated(1.5), "model")).toEqual({ level: 1.5, model: "claude-sonnet-5-5" });
  expect(route(rated(2.9), "model")).toEqual({ level: 2.9 });
  expect(route(rated(0.95), "effort")).toEqual({ level: 0.95 });
  expect(route(rated(2.9, 0.3), "model")).toBeUndefined();
});

test("words keeps umlauts whole instead of splitting at them", () => {
  expect([...words("ändere die Größe")]).toEqual(expect.arrayContaining(["änder", "größ"]));
});
