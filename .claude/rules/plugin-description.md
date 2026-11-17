---
paths:
  - "*/package.json"
---

# Rule: the `description` in a plugin's `package.json`

The `description` becomes the plugin's `description` in `plugin.json` and is what an end user reads in the plugin list to decide whether to install it. User decision 2026-11-17 (rc-enhancement 0.4.0).

- It says what the user **gets**, in plain words: the behaviour or capability, not how it is built. One sentence, short (aim for 120 characters, at most 200), English, third person, starting with a verb (`Makes …`, `Runs …`, `Adds …`).
- Left out: how it is implemented (hooks, mods, MCP servers, skills internals, build or file names, algorithms), configuration (environment variables, options), requirements and version numbers, tool lists, limits and edge cases. They belong in the plugin's `README.md`.
- Names the user types or sees stay (a slash command, a tool or product the plugin works with), when the description is unclear without them.
- It applies to every plugin from its next change: whoever edits a plugin's `package.json`, `src/` or `plugin/` shortens an old description to this form in the same change. No mass rewrite of untouched plugins.
- `keywords` are plain topic words (`hooks`, `interaction`), not feature or event names.
