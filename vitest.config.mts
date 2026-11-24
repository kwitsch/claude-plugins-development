// Workspace-wide vitest config; each package's `test` script points here (`vitest run --config "$(git rev-parse --show-toplevel)/vitest.config.mts"`, the same at any depth).
// Several test files spawn node and stub dprint/npx scripts; vitest's 5 s default is too tight for them under load.
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// `@scripts/*` (tsconfig.base.json `paths`) is `development/scripts/*`: tests import the build scripts' pure modules with it.
// `@shared/*` mirrors tsconfig.base.json `paths` for unit tests that import a plugin's `src/`.
// `claude-tests/` run only under `claude plugin test` (a mod's integration tests: `pnpm --filter <name> test:plugin`).
export default defineConfig({
  resolve: {
    alias: [
      { find: "@scripts", replacement: fileURLToPath(new URL("./development/scripts", import.meta.url)) },
      { find: "@shared", replacement: fileURLToPath(new URL("./development/shared/src", import.meta.url)) },
    ],
  },
  test: { testTimeout: 30_000, exclude: [...configDefaults.exclude, "**/claude-tests/**"] },
});
