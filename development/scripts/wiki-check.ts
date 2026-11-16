#!/usr/bin/env node
// Usage: wiki-check.ts
// Fails when development/wiki/ is inconsistent (development/wiki/CLAUDE.md): a page the index does not list, a
// relative link that leads nowhere, a page without a `# Title` first line, or a malformed log heading. Plugin sections
// (plugins/<name>/): plugins/index.md links every section's index.md, each index.md links every page of its section
// except tasks/*, every plugin of the repository has a section, and TASKS.md matches the tasks/ frontmatter (format in
// .claude/rules/plugin-docs-tasks.md). Also fails on a dead relative link in a memory file (CLAUDE.md,
// .claude/rules/*.md, at the root and per top-level directory): rules link to wiki and design pages instead of
// repeating them, so a moved page must not leave a rule pointing nowhere.
// Part of `pnpm lint` and of the PR workflow. What needs judgement (stale or contradicting facts) is the `wiki`
// skill's `lint` action.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Files of the wiki that are not topic pages. */
const SPECIAL = new Set(["index.md", "log.md", "CLAUDE.md"]);
/** A page of a plugin's section; task files start with frontmatter instead of a `# Title`. */
const PLUGIN_PAGE = /^plugins\/([^/]+)\/(.+)$/;
/** A log heading: `## [YYYY-MM-DD] ingest | <title>` or `## [YYYY-MM-DD] lint | <title>`. */
const LOG_HEADING = /^## \[\d{4}-\d{2}-\d{2}\] (?:ingest|lint) \| \S/;
/** A TASKS.md entry: checkbox, id link to the task file, status tag, priority, title. */
const ENTRY = /^- \[([ x])\] \[([^\]]+)\]\((tasks\/[^)\s]+)\) `([a-z-]+)` (\S+): \S/;
/** Task statuses that are not finished (section Remaining); `done` is section Done, `closed` is Closed without code. */
const OPEN = new Set(["open", "partial", "docs-only", "measurement-only"]);
/** The sections of a TASKS.md in the order they come. */
const SECTION = { open: "## Remaining", done: "## Done", closed: "## Closed without code" } as const;

/**
 * The targets of the relative markdown links of a text; fenced code blocks and code spans are skipped.
 *
 * @param text - Markdown source.
 * @returns Link targets without their `#fragment`, external and in-page links left out.
 */
function links(text: string): string[] {
  const prose = text.replace(/^```[\s\S]*?^```/gm, "").replace(/`[^`\n]*`/g, "");
  return [...prose.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1].split("#")[0]).filter((t) => t !== "" && !/^[a-z][a-z0-9+.-]*:/i.test(t));
}

/**
 * The links of a page as paths relative to the wiki root.
 *
 * @param rel - Path of the page relative to the wiki root.
 * @param text - Its markdown source.
 * @returns Normalised link targets.
 */
const linked = (rel: string, text: string): Set<string> => new Set(links(text).map((t) => path.posix.normalize(path.posix.join(path.posix.dirname(rel), t))));

/**
 * What is wrong with one plugin's TASKS.md against its task files.
 *
 * @param dir - Section directory, `plugins/<name>`.
 * @param files - All wiki files with their text.
 * @returns One line per problem.
 */
function taskProblems(dir: string, files: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  const tasks = [...files].filter(([rel]) => rel.startsWith(`${dir}/tasks/`));
  const text = files.get(`${dir}/TASKS.md`);
  if (text === undefined) return tasks.length > 0 ? [`${dir}/TASKS.md is missing (the section has tasks)`] : [];
  const seen = new Set<string>();
  let section = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) section = line;
    const m = ENTRY.exec(line);
    if (m === null) {
      if (/^- \[[ x]\] /.test(line)) out.push(`${dir}/TASKS.md: entry "${line.slice(0, 60)}" does not match "- [ ] [F01](tasks/<file>.md) \`status\` priority: title"`);
      continue;
    }
    const [, box, id, target, status, priority] = m;
    const task = files.get(`${dir}/${target}`);
    if (task === undefined) {
      out.push(`${dir}/TASKS.md: ${id} links ${target}, which does not exist`);
      continue;
    }
    seen.add(`${dir}/${target}`);
    const fm = Object.fromEntries((/^---\n([\s\S]*?)\n---/.exec(task)?.[1] ?? "").split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
    const want = OPEN.has(fm.status) ? SECTION.open : fm.status === "done" ? SECTION.done : fm.status === "closed" ? SECTION.closed : "";
    if (want === "") out.push(`${dir}/${target}: status "${fm.status}" is not open|partial|docs-only|measurement-only|done|closed`);
    else if (section !== want) out.push(`${dir}/TASKS.md: ${id} is in "${section}", status ${fm.status} belongs in "${want}"`);
    if (fm.id !== id) out.push(`${dir}/TASKS.md: ${id} links a task whose id is "${fm.id}"`);
    if (status !== fm.status) out.push(`${dir}/TASKS.md: ${id} says \`${status}\`, the task says ${fm.status}`);
    if (priority !== fm.priority) out.push(`${dir}/TASKS.md: ${id} says priority ${priority}, the task says ${fm.priority}`);
    if ((box === "x") === OPEN.has(fm.status)) out.push(`${dir}/TASKS.md: ${id} has the wrong checkbox for status ${fm.status}`);
  }
  for (const [rel] of tasks) if (!seen.has(rel)) out.push(`${dir}/TASKS.md: ${path.posix.basename(rel)} is not listed`);
  return out;
}

/**
 * Everything that is wrong with a wiki.
 *
 * @param files - Wiki files by their path relative to the wiki root (forward slashes), with their text.
 * @param exists - Whether a path relative to the wiki root (it may leave the root with `..`) exists.
 * @param plugins - Names of the plugins of the repository; each needs a section `plugins/<name>/`.
 * @returns One line per problem, empty when the wiki is consistent.
 */
export function problems(files: ReadonlyMap<string, string>, exists: (rel: string) => boolean, plugins: readonly string[] = []): string[] {
  const out: string[] = [];
  const index = files.get("index.md");
  if (index === undefined) return ["index.md is missing"];
  const listed = linked("index.md", index);
  const sections = new Set([...files.keys()].flatMap((rel) => PLUGIN_PAGE.exec(rel)?.[1] ?? []));
  for (const name of plugins) if (!sections.has(name)) out.push(`plugins/${name}/index.md is missing (every plugin has a wiki section)`);
  const pluginsIndex = linked("plugins/index.md", files.get("plugins/index.md") ?? "");
  for (const name of sections) {
    const dir = `plugins/${name}`;
    const own = files.get(`${dir}/index.md`);
    if (own === undefined) out.push(`${dir}/index.md is missing`);
    else {
      if (!own.startsWith("# ")) out.push(`${dir}/index.md: the first line is not a "# Title"`);
      const mine = linked(`${dir}/index.md`, own);
      for (const rel of files.keys()) if (rel.startsWith(`${dir}/`) && rel !== `${dir}/index.md` && !rel.startsWith(`${dir}/tasks/`) && !mine.has(rel)) out.push(`${rel}: not listed in ${dir}/index.md`);
    }
    if (!pluginsIndex.has(`${dir}/index.md`)) out.push(`${dir}/index.md: not listed in plugins/index.md`);
    out.push(...taskProblems(dir, files));
  }
  for (const [rel, text] of files) {
    if (!PLUGIN_PAGE.test(rel) && !SPECIAL.has(rel)) {
      if (!listed.has(rel)) out.push(`${rel}: not listed in index.md`);
      if (!text.startsWith("# ")) out.push(`${rel}: the first line is not a "# Title"`);
    }
    for (const target of links(text)) {
      const to = path.posix.normalize(path.posix.join(path.posix.dirname(rel), target));
      if (!files.has(to) && !exists(to)) out.push(`${rel}: link to ${target} leads nowhere`);
    }
  }
  for (const line of (files.get("log.md") ?? "").split("\n")) {
    if (line.startsWith("## ") && !LOG_HEADING.test(line)) out.push(`log.md: heading "${line}" is not "## [YYYY-MM-DD] ingest|lint | <title>"`);
  }
  return out;
}

// self-check: a script that guards the wiki must not pass a broken one
const task = (id: string, status: string, priority = "low") => `---\nid: ${id}\ntitle: t\nstatus: ${status}\npriority: ${priority}\narea: a\n---\n`;
const broken = new Map([
  ["index.md", "[a](facts/a.md) [gone](facts/gone.md) [out](../x.md) [pl](plugins/index.md) [web](https://example.invalid/y.md) `[code](no.md)`"],
  ["log.md", "## [2026-11-15] ingest | first\n## 2026-11-15 lint\n"],
  ["facts/a.md", "# A\n[b](b.md#part)\n"],
  ["facts/b.md", "no title\n"],
  ["plugins/index.md", "# P\n[p](p/index.md)\n"],
  ["plugins/p/index.md", "# P\n[TASKS](TASKS.md)\n"],
  ["plugins/p/TASKS.md", "# p tasks\n\n## Remaining\n\n- [ ] [F01](tasks/F01.md) `open` low: t\n- [x] [F02](tasks/F02.md) `open` low: t\n\n## Done\n\n- [x] [F03](tasks/F03.md) `done` high: t\n- [x] bad line\n"],
  ["plugins/p/tasks/F01.md", task("F01", "open")],
  ["plugins/p/tasks/F02.md", task("F02", "open")],
  ["plugins/p/tasks/F03.md", task("F03", "done")],
  ["plugins/p/tasks/F04.md", task("F04", "done")],
  ["plugins/p/extra.md", "# Extra\n"],
  ["plugins/q/a.md", "x\n"],
]);
assert.deepEqual(problems(broken, (rel) => rel === "../x.md", ["p", "r"]), [
  "plugins/r/index.md is missing (every plugin has a wiki section)",
  "plugins/p/extra.md: not listed in plugins/p/index.md",
  "plugins/p/TASKS.md: F02 has the wrong checkbox for status open",
  "plugins/p/TASKS.md: F03 says priority high, the task says low",
  "plugins/p/TASKS.md: entry \"- [x] bad line\" does not match \"- [ ] [F01](tasks/<file>.md) `status` priority: title\"",
  "plugins/p/TASKS.md: F04.md is not listed",
  "plugins/q/index.md is missing",
  "plugins/q/index.md: not listed in plugins/index.md",
  "index.md: link to facts/gone.md leads nowhere",
  "facts/b.md: not listed in index.md",
  "facts/b.md: the first line is not a \"# Title\"",
  "log.md: heading \"## 2026-11-15 lint\" is not \"## [YYYY-MM-DD] ingest|lint | <title>\"",
]);

const root = path.resolve(import.meta.dirname, "../wiki");
/**
 * Every markdown file below a directory.
 *
 * @param dir - Directory to list.
 * @returns Paths relative to the wiki root, forward slashes.
 */
const list = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const abs = path.join(dir, d.name);
    if (d.isDirectory()) return list(abs);
    return d.name.endsWith(".md") ? [path.relative(root, abs).split(path.sep).join("/")] : [];
  });
const repo = path.resolve(root, "../..");
const tops = readdirSync(repo, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== "node_modules" && !d.name.startsWith(".")).map((d) => path.join(repo, d.name));
const pluginNames = tops.filter((d) => /"claudePlugin"/.test(existsSync(path.join(d, "package.json")) ? readFileSync(path.join(d, "package.json"), "utf8") : "")).map((d) => path.basename(d));
const found = problems(new Map(list(root).map((rel) => [rel, readFileSync(path.join(root, rel), "utf8")])), (rel) => existsSync(path.join(root, rel)), pluginNames);

/**
 * The memory files of one directory: its `CLAUDE.md` and its `.claude/rules/*.md`.
 *
 * @param dir - Directory to look in.
 * @returns Absolute paths of the files that exist.
 */
const memoryFiles = (dir: string): string[] => {
  const rules = path.join(dir, ".claude/rules");
  return [path.join(dir, "CLAUDE.md"), ...(existsSync(rules) ? readdirSync(rules).filter((n) => n.endsWith(".md")).map((n) => path.join(rules, n)) : [])].filter((f) => existsSync(f));
};
for (const file of [repo, ...tops].flatMap(memoryFiles)) {
  for (const target of links(readFileSync(file, "utf8"))) {
    if (!existsSync(path.resolve(path.dirname(file), target))) found.push(`${path.relative(repo, file)}: link to ${target} leads nowhere`);
  }
}
if (found.length > 0) {
  console.error(`knowledge links: ${found.length} problem(s)\n${found.join("\n")}`);
  process.exit(1);
}
