# GitHub and the plugin marketplace

Behaviour of GitHub and of Claude Code's marketplace files that affects how this repository ships.

The workflows themselves: [ci.md](../../../.claude/rules/ci.md).

- One `git push` that updates more than three branches fires no `push` or `pull_request` `synchronize` events. An atomic force-push of a whole PR stack leaves its PRs without CI, and the required check `changed-plugins` stays missing. Push each branch in its own push (seen 2026-11-11).
- `pr.yml` has only the `pull_request` trigger; it cannot be started by hand. The protection of `main` is strict: the bottom PR of a stack must be up to date with `main` (repository settings, 2026-11-11).
- In `marketplace.json`, an entry's unset display field (`displayName`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`) falls back to the plugin's `plugin.json`, also before install for relative-path sources. `category` and `tags` exist on the entry only (docs, marketplace reference "Display fields").
