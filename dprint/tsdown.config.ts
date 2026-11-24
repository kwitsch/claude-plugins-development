import { pluginConfig, type PresetOptions } from "@kwitsch/tsdown-preset-claude-code";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// the preset ignores package.json's claudePlugin key: forward it so plugin-only fields reach plugin.json
const { claudePlugin } = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")) as { claudePlugin: PresetOptions["manifest"] };

export default await pluginConfig({
  hooksTemplate: "hooks.template.json",
  mcpTemplate: "mcp.template.json",
  scripts: { skills: { dprint: ["src/skills/dprint/check-dprint.ts", "src/skills/dprint/run-dprint.ts", "src/skills/dprint/scan-plugins.ts"] } },
  manifest: claudePlugin,
  overrides: {
    alias: { "@shared": fileURLToPath(new URL("../development/shared/src", import.meta.url)) },
  },
});
