import { pluginConfig } from "../development/tsdown/index.ts";

export default pluginConfig({ mods: ["hooks/register"], scripts: ["skills/cc-compress/scripts/compress", "skills/lsp-audit/scripts/audit-lsp", "skills/repository-audit/scripts/detect-tools"] });
