// tests/support/kit.ts of __NAME__: the fake environment of the plugin's tests, bound to the source src/hooks/register.ts.
// A test file calls `makeKit(options)` (.claude/rules/hook-tests.md).
// A full example: graphmind-helper/tests/support/kit.ts (tool list and calls, process.run, fs, env, toast).
import { createKit } from "claude-engine-vitest";
import type { On } from "claude-engine-vitest";

/** The manifest defaults (package.json claudePlugin.userConfig): the kit does not fill userConfig defaults. */
export const DEFAULTS = {};

/** The kit's mock helpers, as createKit returns them. */
export type MockKit = ReturnType<typeof createKit>["mock"];

/** The working directory the fake session reports. */
export const CWD = "/proj";

/** What `setup` fakes; add the reads and answers the plugin's hooks make. */
export type SetupOpts = { cwd?: () => string; env?: Record<string, string>; store?: Record<string, unknown> };

/**
 * A kit bound to src/hooks/register.ts with the given userConfig options.
 *
 * @param options - The manifest defaults of the test.
 * @returns The kit's `test` and `mock`, and `setup` bound to that mock.
 */
export function makeKit(options: Record<string, unknown> = DEFAULTS) {
  const kit = createKit({ module: new URL("../../src/hooks/register.ts", import.meta.url), plugin: "__NAME__", options });
  return { ...kit, setup: (on: On, opts: SetupOpts = {}) => setupWith(kit.mock, on, opts) };
}

/**
 * Answers the calls the mod makes on `$` beneath it. One `setup` per test: `on()` after the test's first `$` call throws,
 * and a second `setup` stacks hooks; several cases in one test go through state the fakes read at call time.
 *
 * @param mock - The kit's mock helpers.
 * @param on - The test's `on`.
 * @param opts - What the environment holds.
 */
export function setupWith(mock: MockKit, on: On, opts: SetupOpts) {
  mock.env(on, opts.env ?? {});
  mock.store(on, opts.store ?? {});
  mock.clock(on);
  on("session.cwd", () => ({ value: opts.cwd?.() ?? CWD }));
}
