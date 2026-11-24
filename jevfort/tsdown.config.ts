import { pluginConfig, type PresetOptions } from "@kwitsch/tsdown-preset-claude-code";
import { readFileSync } from "node:fs";

// the preset ignores package.json's claudePlugin key: forward it so dependencies and userConfig reach plugin.json
const { claudePlugin } = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")) as { claudePlugin: PresetOptions["manifest"] };

export default await pluginConfig({
  hooksTemplate: "hooks.template.json",
  manifest: claudePlugin,
});
