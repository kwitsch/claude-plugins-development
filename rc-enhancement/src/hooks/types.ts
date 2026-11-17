/**
 * Engine and event types of rc-enhancement, typed structurally (no engine type import): only the `$` members and
 * events the plugin uses.
 *
 * @packageDocumentation
 */

/** The part of the engine interface `$` this plugin uses. */
export type Engine = {
  /** Prompts a plugin sends on its own. */
  prompt: {
    /** Queues a framed plugin prompt that starts a new turn once the session is idle; resolves when that turn starts. */
    submit(input: { text: string }): Promise<unknown>;
  };
};

/** `turn.start` input. */
export type TurnStart = {
  /** The prompt that starts the turn. */
  text: string;
  /** The turn's id. */
  turnId: string;
  /** Set for a subagent's turn. */
  agentId?: string;
};

/** `turn.complete` input. */
export type TurnComplete = {
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
export type Next<E, R = unknown> = (e: E) => R;

/** The `on` the engine passes to `register`, one overload per hooked event. */
export type On = {
  /** Hooks `turn.start`. */
  (event: "turn.start", hook: ($: Engine, e: TurnStart, next: Next<TurnStart, Promise<unknown>>) => Promise<unknown>): void;
  /** Hooks `turn.complete`. */
  (event: "turn.complete", hook: ($: Engine, e: TurnComplete, next: Next<TurnComplete, Promise<unknown>>) => Promise<unknown>): void;
};
