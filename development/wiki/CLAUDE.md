# development/wiki/

The repository's knowledge base for agent sessions: what earlier sessions verified, decided, worked out or tripped over, written so a later session can look it up instead of finding it out again. Pattern: an LLM-maintained wiki (index, log, topic pages; ingest, query, lint). Claude writes and maintains the pages; the user reviews them in the PR. Not shipped, not user documentation, English.

## Where knowledge goes

| Kind of knowledge                                                                                                                    | Home                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| A constraint that must be known before editing certain files                                                                         | a rule with `paths:` (`.claude/rules/`, `<plugin>/.claude/rules/`)                                      |
| How one plugin works, its decisions and measurements                                                                                 | that plugin's `CLAUDE.md` and rules, its task list, evaluations and design pages in `plugins/<plugin>/` |
| A step-by-step workflow that is run again and again                                                                                  | a skill (`.claude/skills/`)                                                                             |
| Anything else worth keeping: behaviour of Claude Code or an external tool, a repo-wide decision and its reasons, a method, a pitfall | a page here                                                                                             |
| Personal preferences of the user, and one-line pointers to pages                                                                     | the machine-local memory (graphmind, auto-memory); never the only copy of a fact                        |

A fact has one home. A page links to a rule instead of repeating it, and a rule links to a page for background.

Rules and `CLAUDE.md` files load into every agent that touches a matching file; pages here load only when someone follows a link. So a rule keeps the constraint in a line or two and links, as `[topic](relative/path.md)`, to the page with the reasons, the evidence, the residuals and the rejected alternatives: this wiki for what spans plugins, `plugins/<plugin>/design/` for one plugin (model: `universal-lint/.claude/rules/lint-file.md`). `wiki-check.ts` fails on a dead link in a rule.

## Layout

- `index.md`: the catalog. One line per page (link plus what a reader finds there), grouped by kind, and one line per knowledge source outside this directory (rules, plugin docs, skills). Read it first; it is the only file a session needs to find the rest.
- `log.md`: append-only, newest entry last. One entry per ingest or lint pass, headed `## [YYYY-MM-DD] ingest | <title>` or `## [YYYY-MM-DD] lint | <title>`, so `grep '^## \[' log.md` lists the history.
- `facts/`: verified behaviour of something this repository does not control (Claude Code, npm, a linter, an API, GitHub).
- `decisions/`: a decision that holds across plugins, with its date, the reason and what was rejected.
- `methods/`: how to find something out or test something (a recipe that is not a skill).
- `pitfalls/`: what went wrong in a session and how to avoid it.
- `plugins/<plugin>/`: one plugin's task list (`TASKS.md`, `tasks/`), dated evaluations and design pages (`design/`), format in `.claude/rules/plugin-docs-tasks.md`. `plugins/index.md` is the plugin sections' own index (the root index links only to it): it lists each plugin's `README.md`, or every page of a plugin without one; the other pages are reached from there. `wiki-check.ts` requires the `plugins/index.md` entries and does not require a `# Title` there (task files start with frontmatter).

## Page format

- File name in kebab-case; first line `# <Title>`; then one sentence that says what the page answers (the index line repeats it). No frontmatter.
- A fact states how it is known, right behind it: `(live 2.1.325)` = seen in a real session of that Claude Code version, `(binary 2.1.322)` = read from the binary, `(typings)`, `(docs)` = documentation only, not run, `(measured 2026-11-14)`. A claim without one of these does not go in.
- A decision states its date, who decided, the reason, and the alternatives that were rejected.
- Short bullets. No narrative of the session that found it; the log holds the date and the source.
- Never: secrets, the value of an environment variable, a private host name, personal data.

## Operations

- **Query:** read `index.md`, then the pages it names. A good answer that needed several pages or new checking is filed as a page.
- **Ingest:** the `wiki` skill (`.claude/skills/wiki/SKILL.md`, action `ingest`): file what a task established, update `index.md`, append to `log.md`.
- **Lint:** `node development/scripts/wiki-check.ts` (index and links; part of `pnpm lint` and of the PR workflow) and the skill's action `lint` (stale version stamps, contradictions, duplicates of a rule).
