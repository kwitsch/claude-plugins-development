/**
 * dprint's project config file names, shared through `find-config.mts` by `scan-plugins.mts` and `mcp/format.mts`; `hooks/notice.mts` keeps an inlined copy (drift test in `tests/notice.test.mts`).
 *
 * @remarks
 * Pure (no imports): the function-hooks module `hooks/notice.mts` runs without Node, so it inlines the names and the test compares them with this list.
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
