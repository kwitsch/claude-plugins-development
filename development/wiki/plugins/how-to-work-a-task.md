# How to work a task

The steps for a task of any plugin's `TASKS.md`; every plugin's `index.md` links here and adds its own conventions under "Task conventions" where it has any. Format of the documents: `.claude/rules/plugin-docs-tasks.md`.

1. Pick an open task from "Remaining" in the plugin's `TASKS.md` (highest priority first; respect a `Dependencies` section), and read its document and the documents under its `Related` section. Check it against the current code first: symbols move.
2. Read the plugin's `CLAUDE.md`, the rules the task names and the "Task conventions" of its `index.md`. Locate code by the symbol names under `Code locations`; line numbers are deliberately absent because they drift.
3. Implement in `src/`, add the tests named under `Verification`, then run `pnpm lint && pnpm --filter <plugin> build && pnpm --filter <plugin> test`. Never edit `plugin/**/*.mjs` or `plugin/.claude-plugin/plugin.json` by hand.
4. A change of the plugin's `package.json`, `src/` or `plugin/` merged to `main` needs a version bump (`version` in `package.json`, the only manifest source; root `CLAUDE.md`).
5. Update the task: set `status` in its frontmatter, say under `Status` and `Approach` what shipped (version, test), and update its `TASKS.md` entry (checkbox, section, status tag). New numbers go into a new dated evaluation, never over old ones.
