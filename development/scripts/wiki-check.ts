#!/usr/bin/env node
// Usage: wiki-check.ts
// Fails when development/wiki/ is inconsistent (development/wiki/CLAUDE.md): a page the index does not list, a
// relative link that leads nowhere, a page without a `# Title` first line, or a malformed log heading.
// Part of `pnpm lint` and of the PR workflow. What needs judgement (stale or contradicting facts) is the `wiki`
// skill's `lint` action.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Files of the wiki that are not topic pages. */
const SPECIAL = new Set(["index.md", "log.md", "CLAUDE.md"]);
/** A log heading: `## [YYYY-MM-DD] ingest | <title>` or `## [YYYY-MM-DD] lint | <title>`. */
const LOG_HEADING = /^## \[\d{4}-\d{2}-\d{2}\] (?:ingest|lint) \| \S/;

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
 * Everything that is wrong with a wiki.
 *
 * @param files - Wiki files by their path relative to the wiki root (forward slashes), with their text.
 * @param exists - Whether a path relative to the wiki root (it may leave the root with `..`) exists.
 * @returns One line per problem, empty when the wiki is consistent.
 */
export function problems(files: ReadonlyMap<string, string>, exists: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const index = files.get("index.md");
  if (index === undefined) return ["index.md is missing"];
  const listed = new Set(links(index).map((t) => path.posix.normalize(t)));
  for (const [rel, text] of files) {
    if (!SPECIAL.has(rel)) {
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
const broken = new Map([
  ["index.md", "[a](facts/a.md) [gone](facts/gone.md) [out](../x.md) [web](https://example.invalid/y.md) `[code](no.md)`"],
  ["log.md", "## [2026-11-15] ingest | first\n## 2026-11-15 lint\n"],
  ["facts/a.md", "# A\n[b](b.md#part)\n"],
  ["facts/b.md", "no title\n"],
]);
assert.deepEqual(problems(broken, (rel) => rel === "../x.md"), [
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
const found = problems(new Map(list(root).map((rel) => [rel, readFileSync(path.join(root, rel), "utf8")])), (rel) => existsSync(path.join(root, rel)));
if (found.length > 0) {
  console.error(`development/wiki: ${found.length} problem(s)\n${found.join("\n")}`);
  process.exit(1);
}
