import { pluginConfig } from "@kwitsch/tsdown-preset-claude-code";
import { fileURLToPath } from "node:url";

export default await pluginConfig({
  hooksTemplate: "hooks.template.json",
  mcpTemplate: "mcp.template.json",
  overrides: {
    alias: { "@shared": fileURLToPath(new URL("../development/shared/src", import.meta.url)) },
  },
});
