# Knowledge index

Catalog of what earlier sessions wrote down, in this wiki and elsewhere in the repository. Read this first, then only the pages a question needs. How the wiki is kept: [CLAUDE.md](CLAUDE.md); history: [log.md](log.md).

## Wiki pages

### Facts: behaviour of things this repository does not control

- [mods-engine-lifecycle.md](facts/mods-engine-lifecycle.md): how a function-hooks module is loaded and reloaded, hook order and tiers, the 10 s budget, skipped hooks, `userConfig` checks, `$.env`, `$.store`, the scratchpad path.
- [mods-engine-tools.md](facts/mods-engine-tools.md): `$.tool.register` naming and lifetime, serving a tool, permissions of hook-served tools, `$.tool.call` between plugins, what `tool.check` sees and can decide.
- [mods-engine-io.md](facts/mods-engine-io.md): `$.http.fetch` limits and error texts, `$.model.complete` cut-off replies, `$.clock` overflow and overlap, `$.mcp.connect`/`call`, `$.ui.log` and the band above the prompt.
- [mods-engine-session.md](facts/mods-engine-session.md): `$.session.messages` row shapes, `prompt.submit` origins, how `$.command.run` queues, what a `session.compact` hook replaces, usage and cache lifetime.
- [claude-code-command-hooks.md](facts/claude-code-command-hooks.md): `if` and FileChanged matcher filters, physical cwd in payloads, the transcript records a hook's exit 2 leaves.
- [test-kit-vs-engine.md](facts/test-kit-vs-engine.md): where `claude-engine-vitest` and `claude plugin test` differ from a real session.
- [npm-npx-and-node.md](facts/npm-npx-and-node.md): npx lookup order, registry re-check and lock, non-blocking stdin after importing `node:process`, timer overflow, lookup cost under WSL.
- [build-lint-and-format-tools.md](facts/build-lint-and-format-tools.md): oxlint nested configs and tsgolint lookup, the oxc-minify template-literal rewrite, eslint config lookup, dprint CLI behaviour.
- [mcp-protocol-eras.md](facts/mcp-protocol-eras.md): how Claude Code's MCP client negotiates the 2025-11-25 and 2026-07-28 eras, cancellation, tool `_meta` fields, the tasks extension, what is unverified.
- [github-and-marketplace.md](facts/github-and-marketplace.md): no CI events for a push of more than three branches, `pr.yml` triggers, display-field fallback in `marketplace.json`.

### Decisions

- [repo-tooling.md](decisions/repo-tooling.md): why dprint with a minimal config, one oxlint run, vitest, `.ts` sources, generated manifests, English content, this wiki, and rules that hold constraints only; what was rejected each time.

### Methods

- [transcript-mining.md](methods/transcript-mining.md): measuring from local transcripts what a hook did across sessions (which records to count, how to find the triggering edit, traps).
- [hook-payload-probe.md](methods/hook-payload-probe.md): a throwaway logging plugin to see hook payloads, hook environment and the effect of an exit code, for subagents and workflow agents too.
- [plugins/how-to-work-a-task.md](plugins/how-to-work-a-task.md): the five steps for working a task of any plugin's task list (every plugin's `index.md` links it).
- [scratch-test-harnesses.md](methods/scratch-test-harnesses.md): running a plugin's tests against a modified or older copy from the scratchpad (repro, mutation check, A/B measurement).

### Pitfalls

- [worktree-and-auto-mode-sessions.md](pitfalls/worktree-and-auto-mode-sessions.md): commands a worktree session refuses, refused calls after a formatter rewrote tool input, lint findings on a half-finished edit.
- [delegated-delivery.md](pitfalls/delegated-delivery.md): what went wrong when implementers and reviewers worked on task branches, and how to phrase the hand-off.
- [porting-shell-to-node.md](pitfalls/porting-shell-to-node.md): grep versus JS regex, the lookups the shell did for you, Claude Code's own config files (`CLAUDE_CONFIG_DIR`, `.claude.json`), output budgets and dedupe.

## Rules (load by file path and hold constraints; listed here so a search by topic finds them)

- Claude Code behaviour: [claude-code-hook-facts.md](../../.claude/rules/claude-code-hook-facts.md) (constraints for a function-hooks module), [claude-code-tool-hook-facts.md](../../.claude/rules/claude-code-tool-hook-facts.md) (tool hooks, subagents, Stop, FileChanged), [claude-code-skill-facts.md](../../.claude/rules/claude-code-skill-facts.md) (tools a skill uses), [mcp-dual-era.md](../../.claude/rules/mcp-dual-era.md) (constraints for a plugin's MCP server).
- Writing hook code: [hook-file-safety.md](../../.claude/rules/hook-file-safety.md) (scope, git, file content, concurrent hook processes, slow file systems), [hook-caches-and-tests.md](../../.claude/rules/hook-caches-and-tests.md) (caches, buffers, regression tests).
- Sources, build, tests: [plugin-src.md](../../.claude/rules/plugin-src.md), [src-typescript.md](../../.claude/rules/src-typescript.md), [plugin-build-output.md](../../.claude/rules/plugin-build-output.md), [hooks-lib-bundle.md](../../.claude/rules/hooks-lib-bundle.md), [hook-tests.md](../../.claude/rules/hook-tests.md), [tsdoc.md](../../.claude/rules/tsdoc.md), [lint-config.md](../../.claude/rules/lint-config.md).
- Process: [ci.md](../../.claude/rules/ci.md) (PR, release, sync workflows), [plugin-docs-tasks.md](../../.claude/rules/plugin-docs-tasks.md) (task lists and evaluations).

## Per plugin

Each plugin keeps its own knowledge: `CLAUDE.md` (overview and part list), `.claude/rules/` (one file per part) and a wiki section. [plugins/index.md](plugins/index.md) lists the sections (task list, one file per task, dated evaluations, design pages).

- The test kit: [README.md](../vitest/claude-engine/README.md).

## Skills (repeated workflows)

`.claude/skills/`: `wiki` (keep this knowledge base), `live-verify` (check behaviour in a real session), `bughunt`, `perf-worklist`, `refactor-plugin`, `scaffold-plugin`, `convert-plugin-ts`, `split-hooks-lib`.
