/**
 * Claude Code function-hooks module: a 15 s toast when the working directory has a dprint config but dprint cannot run.
 *
 * @remarks
 * EARLY ACCESS API (Claude Code 2.1.316 declarations). Fires after `session.start`, `classic.CwdChanged` and the
 * `EnterWorktree`/`ExitWorktree` tool calls. The check runs detached after the event and swallows every error,
 * so it never blocks, delays or alters the event. A directory without a dprint config is left alone and nothing is
 * spawned; with one, the module picks the one dprint `find-dprint.ts` would pick (first `<PATH entry>/dprint` that
 * exists, else `$DPRINT_INSTALL/bin/dprint` (default `~/.dprint/bin/dprint`), else the npx cache), runs `--version` on it via `$.process.run`, and only an
 * unusable pick (cannot start, exits non-zero, prints no version, older than `MIN_VERSION`) toasts, naming the
 * cause. Only this file is listed in `hooks.json`; `development/scripts/build-plugin.ts`
 * (`pluginBuild.bundleHooksLib`) keeps it unmangled, uncompressed and with its whitespace, since the engine's static
 * check wants `$` and `on` spelled as such and every hook a named function literal. Its siblings (`types`, `probe`)
 * are bundled into one `./lib.mjs`. No engine type import (hooks modules run without Node and the engine's
 * declaration file is not in the repo): the used members are typed structurally in `types.ts`.
 *
 * @packageDocumentation
 */

import { afterCwdChanged, afterSessionCwd } from "./probe.js";
import type { NoticeState, On } from "./types.js";

/**
 * Module entry point called by the engine.
 *
 * @param on - Registers a hook for an event.
 */
export const register = (on: On): void => {
  // State lives here, not at module level: the test kit reloads only this entry, and a bundled helper shares no state.
  const st: NoticeState = { shownAt: undefined, probe: null, dprintRuns: false };
  on("session.start", async function onSessionStart($, e, next) {
    return afterSessionCwd($, st, e, next);
  });
  on("classic.CwdChanged", async function onCwdChanged($, e, next) {
    return afterCwdChanged($, st, e, next);
  });
  on("tool.call", { tool: "EnterWorktree" }, async function onEnterWorktree($, e, next) {
    return afterSessionCwd($, st, e, next);
  });
  on("tool.call", { tool: "ExitWorktree" }, async function onExitWorktree($, e, next) {
    return afterSessionCwd($, st, e, next);
  });
};
