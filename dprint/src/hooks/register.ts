/**
 * Claude Code function-hooks module: a 15 s toast when the working directory has a dprint config but dprint cannot run.
 *
 * @remarks
 * EARLY ACCESS API (Claude Code 2.1.316 declarations). Fires after `session.start`, the `Bash` tool calls (only when
 * the session cwd changed) and the `EnterWorktree`/`ExitWorktree` tool calls. No classic Claude Code event is hooked:
 * a managed org's `cc-plugin-sec-default` passes those over user-tier plugins. The check runs detached after the event
 * and swallows every error, so it never blocks, delays or alters the event. A directory without a dprint config is left alone and nothing is
 * spawned; with one, the module picks the one dprint `find-dprint.ts` would pick (first `<PATH entry>/dprint` that
 * exists, else `$DPRINT_INSTALL/bin/dprint` (default `~/.dprint/bin/dprint`), else the npx cache), runs `--version` on it via `$.process.run`, and only an
 * unusable pick (cannot start, exits non-zero, prints no version, older than `MIN_VERSION`) toasts, naming the
 * cause. Only this file is listed in `hooks.json` (as `./register.js`); tsdown builds it with its siblings
 * (`types`, `probe`) inlined, compressed but never mangled, since the engine's static check wants `$` and `on` spelled
 * as such and every hook a named function literal. No engine type import (hooks modules run without Node and the engine's
 * declaration file is not in the repo): the used members are typed structurally in `types.ts`.
 *
 * @packageDocumentation
 */

import { afterBash, afterSessionCwd } from "./probe.js";
import type { NoticeState, On } from "./types.js";

/**
 * Module entry point called by the engine.
 *
 * @param on - Registers a hook for an event.
 */
export const register = (on: On): void => {
  // State lives here, not at module level: the test kit reloads only this entry, and an inlined helper keeps no state.
  const st: NoticeState = { shownAt: undefined, probe: null, dprintRuns: false, lastDir: undefined };
  on("session.start", async function onSessionStart($, e, next) {
    return afterSessionCwd($, st, e, next);
  });
  on("tool.call", { tool: "Bash" }, async function onBash($, e, next) {
    return afterBash($, st, e, next);
  });
  on("tool.call", { tool: "EnterWorktree" }, async function onEnterWorktree($, e, next) {
    return afterSessionCwd($, st, e, next);
  });
  on("tool.call", { tool: "ExitWorktree" }, async function onExitWorktree($, e, next) {
    return afterSessionCwd($, st, e, next);
  });
};
