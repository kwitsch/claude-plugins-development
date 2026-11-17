/**
 * Claude Code function-hooks module of rc-enhancement: the interaction gate. A main-loop turn whose answer ends
 * in a plain-text question gets one plugin prompt telling Claude to redo it through `AskUserQuestion`, pointing back at
 * the CRITICAL RULE that the SessionStart hook (`bin/session-start.ts`) injects.
 *
 * @remarks
 * EARLY ACCESS API. No engine type import: the used `$` members and events are typed structurally in `types.ts`. Only
 * this file is listed in `hooks.json`; `pluginBuild.bundleHooksLib` keeps it unmangled and with its whitespace, as the
 * engine's static check wants `$`/`on` spelled as such and every hook a named function literal, and bundles its
 * siblings (`types`, `gate`) into one compressed `./lib.mjs`.
 *
 * @packageDocumentation
 */

import { GATE_REASON, isBareQuestion } from "./gate.js";
import type { On } from "./types.js";

/**
 * Module entry point called by the engine.
 *
 * @param on - Registers a hook for an event.
 */
export const register = (on: On): void => {
  // State lives here, not at module level: the test kit reloads only the entry. A hot reload forgets it, which at worst
  // lets one more re-prompt through.
  // The main-loop turn the gate's own re-prompt started: never gated again, so at most one re-prompt per user turn.
  let gateTurnId: string | undefined;
  // Backstop for the text match: the next main-loop turn after a submit counts as the gate's, so a changed framing can
  // never loop. A user prompt that starts first takes the exemption instead: at worst one missed gate.
  let gatePending = false;
  on("turn.start", async function onTurnStart(_$, e, next) {
    if (e.agentId === undefined) {
      gateTurnId = gatePending || e.text.includes(GATE_REASON) ? e.turnId : undefined;
      gatePending = false;
    }
    return next(e);
  });
  on("turn.complete", async function onTurnComplete($, e, next) {
    if (e.agentId === undefined && e.reason === "answer" && e.turnId !== gateTurnId && isBareQuestion(e.answer)) {
      gatePending = true;
      // Not awaited: it resolves only once the new turn starts, which waits for this turn to end.
      $.prompt.submit({ text: GATE_REASON }).catch(() => {
        gatePending = false;
      });
    }
    return next(e);
  });
};
