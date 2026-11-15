/**
 * dprint's project config file names, shared through `find-config.ts` by `scan-plugins.ts` and `mcp/format.ts`; `hooks/probe.ts` keeps an inlined copy (drift test in `tests/notice.test.ts`).
 *
 * @remarks
 * Pure (no imports): the function-hooks module `hooks/probe.ts` runs without Node, so it inlines the names and the test compares them with this list.
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
