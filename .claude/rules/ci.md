---
paths:
  - ".github/**"
---

# Rule: CI workflows

PR (`.github/workflows/pr.yml`): On every PR, for each plugin dir with changes (a plugin dir is one whose `package.json` has a `claudePlugin` key, checked by `.github/scripts/is-plugin.sh` in pr.yml, release.yml and sync.yml, so a plugin with uncommitted `plugin/` still fails the freshness check): for PRs into `main` the `package.json` version must be higher than on `main` and tag `<name>-<version>` must not exist here or in kwitsch/claude-plugins; then one workspace-wide `pnpm exec oxlint` must pass, and per tested plugin `pnpm --filter <name> lint` (only if the plugin defines a `lint` script), `build` and `test` must pass and the committed `<name>/plugin/` must equal the fresh build. The tested set is pnpm's graph `...[origin/<base>]`: changed workspace packages plus their dependents, so a `development/vitest/claude-engine/` change runs its tests and re-tests every plugin using it (no version bump for those); a change in the root package itself (shared config, `development/scripts/`, lockfile, `.github/`, docs) re-checks every package. `check-plugin-fresh.sh` also runs `development/scripts/check-plugin-layout.mts` (allowlist of what `plugin/` may ship; `development/scripts/build-plugin.mts` also runs it as step 0). Job `changed-plugins` is the required status check on `main` (branch protection in GitHub settings) — do not rename it.

Dependabot (`.github/dependabot.yml`, `.github/workflows/dependabot-automerge.yml`): weekly npm (pnpm workspace) and github-actions updates. Patch and pin/digest updates get auto-merge (squash) once `changed-plugins` is green; minor/major need a manual merge. Dependabot PRs skip the version-bump check for a plugin as long as its `plugin/` is unchanged (the freshness check still catches a changed build).

Release (`.github/workflows/release.yml`): On push to `main`, tag the pushed commit `<name>-<version>` for each plugin dir the push changed, then run Sync for every changed plugin's tag (a tag that already exists is not re-created but is still synced, which makes re-runs idempotent).

Sync (`.github/workflows/sync.yml`): On tag push `<name>-<version>` or when called by Release: the tag's commit must be an ancestor of `origin/main`; build+test that plugin and require the committed `<name>/plugin/` to equal the fresh build; then open a PR in kwitsch/claude-plugins replacing `plugins/<name>` with `<name>/plugin/`; merging that PR tags `<name>-<version>` there (its `tag-on-version-bump.yml`). Needs secret `RELEASE_TOKEN`.
