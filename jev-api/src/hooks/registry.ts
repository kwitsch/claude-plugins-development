/**
 * Registration of the tool with the engine: retry with back-off, bounded waits.
 *
 * @packageDocumentation
 */

import { SPEC } from "./tools.js";
import { TOOL } from "./types.js";
import type { Engine } from "./types.js";
import { message } from "./util.js";

/** How long an owned tool call waits for the tool to register before it goes on (ms; session.start waits five times as long): a registration that never answers must not hold a call. */
export const REGISTER_WAIT_MS = 1000;

/** The longest a failed registration waits for its next try (ms); the first retry is immediate. */
export const MAX_RETRY_MS = 300_000;

/** The delay before the second retry of a refused tool (ms); it doubles for every further one. */
export const RETRY_BASE_MS = 5000;

/** The registration state of one module instance: whether the tool is registered, under way, refused or hanging. */
export type RegState = {
  /** The full tool names this module answers: the default name plus what the engine returned. */
  names: Set<string>;
  /** Whether the tool is registered. */
  registered: boolean;
  /** The registration under way, if any. */
  pending: { p: Promise<void>; gen: number } | undefined;
  /** Bumped by session.start: an attempt begun under an older generation (before the bind) is stale, its failure is not recorded. */
  gen: number;
  /** When a failed registration may be tried again (ms since epoch; 0: at once). A time more than {@link MAX_RETRY_MS} ahead of the clock means the wall clock stepped back: it counts as 0. */
  retryAt: number;
  /** Failed attempts. */
  failures: number;
  /** Whether the registration did not answer within a hook's wait: later hooks do not wait for it again. */
  stuck: boolean;
};

/**
 * Registers the tool and records the full name the engine gave it; never rejects.
 *
 * @param $ - The engine.
 * @param st - The registration state.
 */
export async function registerOne($: Engine, st: RegState): Promise<void> {
  const g = st.gen;
  try {
    const r = await $.tool.register(SPEC);
    // Only a mcp__<plugin>__<tool> name: a hook above answering anything else must not make this hook claim another tool.
    const tool = r?.tool;
    if (typeof tool === "string" && tool.startsWith("mcp__") && tool.endsWith(`__${TOOL}`)) st.names.add(tool);
    st.registered = true;
  } catch (err) {
    if (g !== st.gen) return; // stale pre-bind attempt: session.start already started a fresh one
    const n = ++st.failures;
    // The first retry is immediate (the next hook), then RETRY_BASE_MS, twice that, ... up to MAX_RETRY_MS: a tool the engine keeps refusing must not cost every call.
    st.retryAt = Date.now() + (n === 1 ? 0 : Math.min(MAX_RETRY_MS, RETRY_BASE_MS * 2 ** (n - 2)));
    // The engine starts a log line with the plugin's name; logging is best effort, and once.
    if (n === 1) {
      try {
        // not awaited: a log call that never settles must not keep the tool pending (and so never retried)
        void Promise.resolve($.ui.log(`registering ${TOOL} failed: ${message(err)}`)).catch(() => undefined);
      } catch {
        // best effort: this function never rejects
      }
    }
  }
}

/**
 * Starts the registration if the tool is missing, not under way and not waiting for a retry, then waits for it unless
 * it hung before, at most `ms`. A registration that never answers is waited for once: it is marked stuck, and later
 * hooks do not wait for it again.
 *
 * @param $ - The engine.
 * @param st - The registration state.
 * @param ms - The longest wait.
 */
export async function ensureTools($: Engine, st: RegState, ms: number): Promise<void> {
  const now = Date.now();
  // No back-off is longer than MAX_RETRY_MS: a retry time further ahead means the wall clock stepped back, and the tool is tried again at once.
  if (st.retryAt - now > MAX_RETRY_MS) st.retryAt = 0;
  if (!st.registered && st.pending?.gen !== st.gen && st.retryAt <= now) {
    const p = registerOne($, st);
    const entry = { p, gen: st.gen };
    st.pending = entry;
    void p.then(() => {
      if (st.pending !== entry) return; // replaced by a fresh attempt
      st.pending = undefined;
      st.stuck = false; // a tool that hung once is waited for again when it is retried
    });
  }
  const waiting = st.pending;
  if (waiting === undefined || waiting.gen !== st.gen || st.stuck) return;
  let timer: { cancel(): void } | undefined;
  try {
    const late = await Promise.race([
      waiting.p.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = $.clock.after(ms, () => resolve(true));
      }),
    ]);
    // Only the attempt this wait was for: one that settled meanwhile (its entry is cleared) or a fresh one that session.start started is not marked.
    if (late && st.pending === waiting) st.stuck = true;
  } finally {
    timer?.cancel();
  }
}
