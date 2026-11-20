import { pluginConfig } from "../development/tsdown/index.ts";

export default pluginConfig({ mods: ["hooks/register"], scripts: ["mcp/server", "hooks/watch-paths", "skills/dprint/check-dprint", "skills/dprint/run-dprint", "skills/dprint/scan-plugins"] });
