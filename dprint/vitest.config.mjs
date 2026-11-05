// Several test files spawn node and stub dprint/npx scripts; vitest's 5 s default is too tight for them under load.
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { testTimeout: 30_000 } });
