/**
 * Every Jev decision, agreeing or not, goes to a capped log in the plugin store so Jev's decisions can be reviewed and
 * thresholds tuned. Pure: the store reads and writes (`record`, `readLog`, `clearLog`, `stats`) live in `register.mts`.
 *
 * @packageDocumentation
 */

/** What a decision was about. */
export type Kind = "take" | "compare" | "route" | "gate" | "done" | "outcome" | "turn" | "bypass" | "classify" | "agent" | "compact" | "error";

/** One logged decision. */
export type Entry = {
  /** When it was made (the engine clock). */
  at: number;
  /** What it was about. */
  kind: Kind;
  /** Whether the decision changed what happened (false for a pass). */
  applied: boolean;
  /** One line for `/jev`. */
  text: string;
  /** How long the Jev request took, in ms. */
  ms?: number;
  /** The turn it belongs to. */
  turnId?: string;
  /** Details for the report. */
  data?: Record<string, unknown>;
};

/** The store key of the log. */
export const LOG_KEY = "log";
/** How many entries the store keeps (the newest). */
export const MAX_ENTRIES = 1000;
/** How many entries this session's `/jev` view keeps. */
const RECENT_MAX = 50;

/** This session's entries, for the short `/jev` view; a hot reload starts it over. */
const recent: Entry[] = [];

/**
 * Keeps `entry` for this session's `/jev` view (the last {@link RECENT_MAX}).
 *
 * @param entry - The decision just recorded.
 */
export function remember(entry: Entry): void {
  recent.push(entry);
  if (recent.length > RECENT_MAX) recent.shift();
}

/**
 * This session's decisions, oldest first.
 *
 * @returns A copy of the recent buffer.
 */
export function recentDecisions(): Entry[] {
  return recent.slice();
}

/**
 * The counter a decision increments: its kind, with `:pass` when it changed nothing.
 *
 * @param d - The decision.
 * @returns The stats key.
 */
export function statsKey(d: Pick<Entry, "kind" | "applied">): string {
  return d.applied ? d.kind : `${d.kind}:pass`;
}
