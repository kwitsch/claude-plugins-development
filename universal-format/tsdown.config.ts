import { pluginConfig, type PresetOptions } from "@kwitsch/tsdown-preset-claude-code";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// the preset ignores package.json's claudePlugin key: forward it so plugin-only fields reach plugin.json
const { claudePlugin } = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")) as { claudePlugin: PresetOptions["manifest"] };

const require = createRequire(import.meta.url);
/** prettier-plugin-java's entry: its grammar wasm lies beside it, web-tree-sitter is its dependency. */
const java = require.resolve("prettier-plugin-java");

export default await pluginConfig({
  hooksTemplate: "hooks.template.json",
  mcpTemplate: "mcp.template.json",
  scripts: { skills: { "universal-format": ["src/skills/universal-format/format-files.ts"] } },
  // prettier and its java, php and shell plugins, bundled once for the server and the skill driver
  bundles: { "mcp/vendor": "src/mcp/vendor/index.ts" },
  // the wasm files those plugins load at runtime, each where its plugin looks for it (main.wasm one level above the chunks)
  files: {
    "mcp/vendor/web-tree-sitter.wasm": createRequire(java).resolve("web-tree-sitter/web-tree-sitter.wasm"),
    "mcp/vendor/tree-sitter-java_orchard.wasm": path.join(path.dirname(java), "tree-sitter-java_orchard.wasm"),
    "mcp/main.wasm": createRequire(require.resolve("prettier-plugin-sh")).resolve("sh-syntax/main.wasm"),
  },
  manifest: claudePlugin,
  overrides: {
    alias: { "@shared": fileURLToPath(new URL("../development/shared/src", import.meta.url)) },
  },
});
