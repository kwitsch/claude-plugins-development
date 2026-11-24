import { pluginConfig, type PresetOptions } from "@kwitsch/tsdown-preset-claude-code";
import { readFileSync } from "node:fs";

// the preset ignores package.json's claudePlugin key: forward it so plugin-only fields reach plugin.json
const { claudePlugin } = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")) as { claudePlugin: PresetOptions["manifest"] };

export default await pluginConfig({
  hooksTemplate: "hooks.template.json",
  // the preset has no subfolder for skill scripts: each builds to skills/<skill>/<name>.mjs beside its data files
  scripts: {
    skills: {
      "cc-compress": ["src/skills/cc-compress/scripts/compress.ts"],
      "lsp-audit": ["src/skills/lsp-audit/scripts/audit-lsp.ts"],
      "repository-audit": ["src/skills/repository-audit/scripts/detect-tools.ts"],
    },
  },
  manifest: claudePlugin,
});
