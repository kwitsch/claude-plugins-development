---
paths:
  - "tests/**"
---

# Tests

Repository rules apply (`hook-tests.md`). Specific to this plugin:

- Everything runs against the built `plugin/` (what ships): the hook through the kit, the three scripts by spawning their built `.mjs` on throwaway directories (`tests/support/plugin.ts`: `tmpDir`, `run`, `makeStub`), the manifest, layout and skill/agent frontmatter as data tests on the files.
- Scripts that call `claude` or `curl`, `pnpm` run on an isolated PATH of symlinks plus a bash stub; nothing touches the network or the real HOME.
- `tests/update-cc-references.test.ts` spawns the project skill's `refresh.ts` from the repository root (dev tooling, not shipped); `tests/maintenance-skills.test.ts` checks the shape of the project skills and the validator agent.
- Test counts and the cases dropped in the migration: [migration.md](../../../development/wiki/plugins/cc-knowledge/notes/migration.md).
- No test pins a version number: the version is released by `update-cc-references` and by hand.
