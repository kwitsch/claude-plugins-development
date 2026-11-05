// Workspace-wide vitest config; each package's `test` script points here (`vitest run --config "$(git rev-parse --show-toplevel)/vitest.config.mts"`, the same at any depth).
// Several test files spawn node and stub dprint/npx scripts; vitest's 5 s default is too tight for them under load.
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { testTimeout: 30_000 } });
