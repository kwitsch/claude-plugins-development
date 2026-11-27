import { defineConfig } from "tsdown";

/**
 * Build of the published package `@kwitsch/claude-code-plugin-shared`: one ESM file plus declarations per entry in
 * `dist/`, which the consuming plugin's preset inlines (so `plugin/` stays zero-dependency).
 */
export default defineConfig({
  entry: ["src/scope.ts", "src/mcp-core.ts", "src/graphmind-paths.ts"],
  format: "esm",
  platform: "node",
  target: "node26",
  fixedExtension: true, // .mjs / .d.mts, matching the exports map
  // no typescript in the workspace. `dts: { oxc: true }` fails with tsdown 0.23.7: the root tsconfig lacks
  // isolatedDeclarations, and with it in compilerOptions rolldown-plugin-dts crashes on oxc.stripInternal.
  dts: { compilerOptions: { isolatedDeclarations: true } },
  minify: false, // consumers minify when they inline
  clean: true,
});
