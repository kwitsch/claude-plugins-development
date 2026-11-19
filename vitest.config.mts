// Workspace-wide vitest config; each package's `test` script points here (`vitest run --config "$(git rev-parse --show-toplevel)/vitest.config.mts"`, the same at any depth).
// Several test files spawn node and stub dprint/npx scripts; vitest's 5 s default is too tight for them under load.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `@scripts/*` (tsconfig.base.json `paths`) is `development/scripts/*`: tests import the build scripts' pure modules with it.
export default defineConfig({
  resolve: { alias: { "@scripts": fileURLToPath(new URL("./development/scripts", import.meta.url)) } },
  test: { testTimeout: 30_000 },
});
