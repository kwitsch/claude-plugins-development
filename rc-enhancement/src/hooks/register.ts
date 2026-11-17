/**
 * Claude Code function-hooks module of rc-enhancement: the interaction gate. A main-loop turn whose answer ends in a
 * plain-text question gets one plugin prompt telling Claude to redo it through `AskUserQuestion`, pointing back at the
 * CRITICAL RULE that `session-start.ts` injects.
 *
 * @remarks
 * EARLY ACCESS API. No engine type import: the used `$` members and events are typed structurally below. Only this
 * file is listed in `hooks.json` and nothing is bundled, so the build keeps it unmangled with its whitespace, as the
 * engine's static check wants `$`/`on` spelled as such and every hook a named function literal.
 *
 * @packageDocumentation
 */

/** The prompt the gate submits. It points at the session-start rule, and the turn it starts is recognized by this text. */
const GATE_REASON = "Interaction rule violation: the final response ends with a plain-text question to the user. "
  + "Follow the CRITICAL RULE from the session start (how to interact with the user): "
  + "route the question through the AskUserQuestion tool instead — no exceptions, not even a casual yes/no offer.";

/** The part of the engine interface `$` this module uses. */
type Engine = {
  /** Prompts a plugin sends on its own. */
  prompt: {
    /** Queues a framed plugin prompt that starts a new turn once the session is idle; resolves when that turn starts. */
    submit(input: { text: string }): Promise<unknown>;
  };
};

/** `turn.start` input. */
type TurnStart = {
  /** The prompt that starts the turn. */
  text: string;
  /** The turn's id. */
  turnId: string;
  /** Set for a subagent's turn. */
  agentId?: string;
};

/** `turn.complete` input. */
type TurnComplete = {
  /** The turn's final visible text. */
  answer: string;
  /** The turn's id. */
  turnId: string;
  /** How the turn ended. */
  reason: "answer" | "aborted" | "error";
  /** Set for a subagent's turn. */
  agentId?: string;
};

/** The hook chain's continuation. */
type Next<E> = (e: E) => Promise<unknown>;

/** The `on` the engine passes to `register`. */
type On = {
  /** Hooks `turn.start`. */
  (event: "turn.start", hook: ($: Engine, e: TurnStart, next: Next<TurnStart>) => Promise<unknown>): void;
  /** Hooks `turn.complete`. */
  (event: "turn.complete", hook: ($: Engine, e: TurnComplete, next: Next<TurnComplete>) => Promise<unknown>): void;
};

/**
 * True when the last non-empty line outside fenced code blocks ends in `?`. A rhetorical trailing `?` is an accepted
 * false positive.
 *
 * @param answer - The turn's final visible text.
 * @returns Whether the answer ends in a bare question.
 */
const isBareQuestion = (answer: string): boolean => {
  const lines = answer
    .replace(/```[\s\S]*?```/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return /\?\s*$/.test(lines[lines.length - 1] ?? "");
};

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
