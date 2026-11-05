// Several test files spawn node, dprint or npx; 30 s covers a cold npx dprint download.
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { testTimeout: 30_000 } });
