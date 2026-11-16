---
name: wiki
description: Maintain the repository's knowledge base in development/wiki/ - file what a task established (ingest) or check the pages for stale, contradicting and duplicated content (lint). Use at the end of a task that verified a behaviour of Claude Code or an external tool, took a decision that holds across plugins, worked out a method or hit a pitfall; when the user asks to remember, document or write down a finding; and when the user asks to check, clean up or lint the wiki. When invoking this skill yourself, pass ingest or lint as the first argument.
argument-hint: "ingest [what to file] | lint"
---

# wiki

Schema, page format and the "where knowledge goes" table: `development/wiki/CLAUDE.md`. Read it and `development/wiki/index.md` first. The first argument selects the action; without one, run `ingest` on what this session established.

## ingest

1. List the candidates: each thing this task established that a later session would otherwise have to find out again. Drop what only matters to this task (file lists, progress, a fix the code and its commit already show).
2. Sort each candidate by the table in `development/wiki/CLAUDE.md`:
   - a constraint for certain files goes into a rule, knowledge about one plugin into that plugin's `CLAUDE.md`, rules or wiki section `development/wiki/plugins/<plugin>/` (`design/` for reasons and residuals of an area, `notes/` for other records, `evaluations/` for measurement runs, `tasks/` plus `TASKS.md` for work items; layout and formats: `.claude/rules/plugin-docs-tasks.md`), a repeated workflow into a skill;
   - the rest goes into a wiki page.
3. Check the index before writing: extend the page that already covers the topic; create a new page only for a new topic. Never state a fact a rule or another page already holds: link to it.
4. Write in the page format: how each fact is known `(live <version>)`, `(binary <version>)`, `(typings)`, `(docs)`, `(measured <date>)`; decisions with date, reason and rejected alternatives. A claim you did not verify and cannot source is left out. A fact that replaces an older one replaces its text; the page does not keep both.
5. Update the index: `development/wiki/index.md` for a page outside `plugins/` (one line per new page; correct a line whose page changed its scope), the `## Pages` list of `development/wiki/plugins/<plugin>/index.md` for a plugin page (a task goes into `TASKS.md` instead), and `plugins/index.md` for a new plugin section and append one entry to `development/wiki/log.md`: `## [YYYY-MM-DD] ingest | <title>`, then what was filed where and from which source (PR, task document, session).
6. Run `node development/scripts/wiki-check.ts`; fix what it reports.
7. Save at most a one-line pointer in the machine-local memory (`graphmind memory add "<topic>: development/wiki/<page>" --type context`), never the fact itself.

## lint

1. `node development/scripts/wiki-check.ts` (pages missing from an index, broken links, malformed log headings, and for `plugins/<plugin>/`: the file layout, the plugin `index.md` and its link to `plugins/how-to-work-a-task.md`, `TASKS.md` against the task frontmatter, required headings of evaluations and tasks).
2. Read every page under `development/wiki/` and report, per page:
   - facts whose version stamp is more than two minor Claude Code versions behind `claude --version`, or older than three months: list them as "re-verify", do not delete them;
   - statements that contradict another page, a rule or the current code (check the code before deciding which side is wrong);
   - facts that a rule or a plugin document also states (keep one, link from the other);
   - pages no other page or index line links to, and topics several pages mention that have no page of their own.
3. Compare with the machine-local memory (`graphmind memory list --limit 500`): an entry that holds a fact which is not in the repository is a candidate for `ingest`.
4. Fix what is clear-cut (duplicates, broken links, a superseded statement); ask the user through `AskUserQuestion` before removing a fact or deciding a contradiction that the code does not settle.
5. Append `## [YYYY-MM-DD] lint | <summary>` to `development/wiki/log.md` with what was found and what was changed.

## Rules

- Never write secrets, values of environment variables, private host names or personal data into a page.
- A re-verification (`live-verify` skill) updates the stamp on the fact; a fact that turned out wrong is corrected in place and the log entry says so.
- A plugin page is not named in the root `index.md`; the root index links only `plugins/index.md`, which links each plugin's `index.md`.
- The wiki is not released: changes under `development/wiki/` need no version bump.
