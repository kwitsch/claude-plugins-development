---
paths:
  - ".github/**"
---

# Rule: CI workflows

PR (`.github/workflows/pr.yml`), on every PR:

- Plugin dirs: one whose `package.json` has a `claudePlugin` key, checked by `.github/scripts/is-plugin.sh` (also used by release.yml and sync.yml), so a plugin with uncommitted `plugin/` still fails the freshness check.
- For PRs into `main`, per changed plugin dir: the `package.json` version must be higher than on `main`, and tag `<name>-<version>` must not exist here or in kwitsch/claude-plugins.
- One workspace-wide `pnpm exec oxlint` must pass.
- Per tested plugin: `pnpm --filter <name> lint` (only if the plugin defines a `lint` script), `build` and `test` must pass, and the committed `<name>/plugin/` must equal the fresh build (`check-plugin-fresh.sh`, which also runs `development/scripts/check-plugin-layout.mts`, the allowlist of what `plugin/` may ship; `development/scripts/build-plugin.mts` runs it as step 0 too).
- Tested set: pnpm's graph `...[origin/<base>]`, i.e. changed workspace packages plus their dependents. A `development/vitest/claude-engine/` change runs its tests and re-tests every plugin using it (no version bump for those); a change in the root package itself (shared config, `development/scripts/`, lockfile, `.github/`, docs) re-checks every package.
- Job `changed-plugins` is the required status check on `main` (branch protection in GitHub settings): do not rename it.

Dependabot (`.github/dependabot.yml`, `.github/workflows/dependabot-automerge.yml`): weekly npm (pnpm workspace) and github-actions updates. Every update except a major one (patch, minor, pin/digest) gets auto-merge (squash) once `changed-plugins` is green; major updates need a manual merge. Dependabot PRs skip the version-bump check for a plugin as long as its `plugin/` is unchanged (the freshness check still catches a changed build).

Release (`.github/workflows/release.yml`): On push to `main`, tag the pushed commit `<name>-<version>` for each plugin dir the push changed, then run Sync for every changed plugin's tag (a tag that already exists is not re-created but is still synced, which makes re-runs idempotent).

Sync (`.github/workflows/sync.yml`): On tag push `<name>-<version>` or when called by Release: the tag's commit must be an ancestor of `origin/main`; build+test that plugin and require the committed `<name>/plugin/` to equal the fresh build; then open a PR in kwitsch/claude-plugins replacing `plugins/<name>` with `<name>/plugin/`; merging that PR tags `<name>-<version>` there (its `tag-on-version-bump.yml`). Needs secret `RELEASE_TOKEN`.
