---
paths:
  - ".github/**"
---

# Rule: CI workflows

PR (`.github/workflows/pr.yml`), on every PR except one that changes only `development/**` (`paths-ignore` in pr.yml, release.yml and dependabot-automerge.yml: such a PR gets no `changed-plugins` status, so the required check is missing and it needs an admin merge; a `development/scripts/` or test-kit change is not tested by CI):

- Plugin dirs: one whose `package.json` has a `claudePlugin` key, checked by `.github/scripts/is-plugin.sh` (also used by release.yml and sync.yml), so a plugin with uncommitted `plugin/` still fails the freshness check.
- For PRs into `main`, per changed plugin dir: the version-bump rule of the root `CLAUDE.md` (`.github/scripts/ships.sh` decides which change needs it); Release (below) skips a plugin that needs none too (no tag, no sync).
- `<name>/tsdown.config.ts` is not in the path set of `ships.sh`: a config change that alters what ships changes the committed `plugin/`, which is. `development/tsdown/**` falls under the `development/**` paths-ignore, like `development/scripts/`.
- One workspace-wide `pnpm exec oxlint` must pass, and `node development/scripts/wiki-check.ts` (the knowledge base `development/wiki/`: every page in an index, no dead link).
- Per tested plugin: `pnpm --filter <name> lint` (only if the plugin defines a `lint` script), `build` and `test` must pass, and the committed `<name>/plugin/` must equal the fresh build (`check-plugin-fresh.sh`, which also runs `development/scripts/check-plugin-layout.ts`, the allowlist of what `plugin/` may ship).
- Tested set: pnpm's graph `...[origin/<base>]`, i.e. changed workspace packages plus their dependents. A `development/vitest/claude-engine/` change runs its tests and re-tests every plugin using it (no version bump for those); a change in the root package itself (shared config, lockfile, `.github/`, docs) re-checks every package.
- Job `changed-plugins` is the required status check on `main` via branch protection in GitHub settings (see root `CLAUDE.md`).

Wiki (`.github/workflows/wiki.yml`): on a PR that changes `development/wiki/**` or `development/scripts/wiki-check.ts` (the paths pr.yml ignores), job `wiki-check` runs `node development/scripts/wiki-check.ts` and fails the PR on any problem. Not a required status check unless set in branch protection.

Dependabot (`.github/dependabot.yml`, `.github/workflows/dependabot-automerge.yml`): weekly npm (pnpm workspace) and github-actions updates. Every update except a major one (patch, minor, pin/digest) gets auto-merge (squash) once `changed-plugins` is green; major updates need a manual merge. Dependabot PRs skip the version-bump check for a plugin as long as its `plugin/` is unchanged (the freshness check still catches a changed build).

Release (`.github/workflows/release.yml`): On push to `main`, tag the pushed commit `<name>-<version>` for each plugin dir the push changed, then run Sync for every changed plugin's tag (a tag that already exists is not re-created but is still synced, which makes re-runs idempotent).

Sync (`.github/workflows/sync.yml`): On tag push `<name>-<version>` or when called by Release: the tag's commit must be an ancestor of `origin/main`; build+test that plugin and require the committed `<name>/plugin/` to equal the fresh build; then replace `plugins/<name>` in kwitsch/claude-plugins with `<name>/plugin/` and push that commit straight to its `main` (`RELEASE_TOKEN`, an admin PAT), where `tag-on-version-bump.yml` tags `<name>-<version>`. Release runs one sync per plugin in parallel, so a push rejected because another sync landed first is rebased and retried (up to 5 times); never drop that loop (it failed the Release of #105 for 2 of 7 plugins).
