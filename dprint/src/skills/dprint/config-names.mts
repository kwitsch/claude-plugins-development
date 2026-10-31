/**
 * dprint's project config file names, shared by `scan-plugins.mts`, `mcp/format.mts` and `hooks/notice.mts`.
 *
 * @remarks
 * Pure (no imports): the function-hooks module `hooks/notice.mts` runs without Node.
 *
 * @packageDocumentation
 */

/** dprint's project config file names, in its discovery order; the two `.config/` names last. */
export const CONFIG_NAMES = [
  "dprint.json",
  "dprint.jsonc",
  ".dprint.json",
  ".dprint.jsonc",
  ".config/dprint.json",
  ".config/dprint.jsonc",
] as const;
