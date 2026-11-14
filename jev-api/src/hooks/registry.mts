/**
 * Registration of the tools with the engine: retry with back-off, bounded waits.
 *
 * @packageDocumentation
 */

import { SPECS } from "./tools.mjs";
import { TOOLS } from "./types.mjs";
import type { Engine, ToolName } from "./types.mjs";
import { message } from "./util.mjs";

/** How long an owned tool call waits for the tools to register before it goes on (ms; session.start waits five times as long): a registration that never answers must not hold a call. */
export const REGISTER_WAIT_MS = 1000;

/** The longest a failed registration waits for its next try (ms); the first retry is immediate. */
export const MAX_RETRY_MS = 300_000;

/** The delay before the second retry of a refused tool (ms); it doubles for every further one. */
export const RETRY_BASE_MS = 5000;

/** The registration state of one module instance: what is registered, under way, refused and hanging. */
export type RegState = {
  /** Full tool name -> tool: the default names plus what the engine returned. */
  names: Map<string, ToolName>;
  /** The tools not registered yet. */
  missing: Set<ToolName>;
  /** The tools whose registration is under way. */
  pending: Map<ToolName, Promise<void>>;
  /** When a failed tool may be tried again (ms since epoch). */
  retryAt: Map<ToolName, number>;
  /** Failed attempts per tool. */
  failures: Map<ToolName, number>;
  /** Tools whose registration did not answer within a hook's wait: later hooks do not wait for them again. */
  stuck: Set<ToolName>;
};

/**
 * Registers one tool and records the full name the engine gave it; never rejects.
 *
 * @param $ - The engine.
 * @param st - The registration state.
 * @param type - The tool to register.
 */
export async function registerOne($: Engine, st: RegState, type: ToolName): Promise<void> {
  try {
    const r = await $.tool.register({ name: type, ...SPECS[type] });
    // Only a mcp__<plugin>__<type> name: a hook above answering anything else must not make this hook claim another tool.
    const tool = r?.tool;
    if (typeof tool === "string" && tool.startsWith("mcp__") && tool.endsWith(`__${type}`)) st.names.set(tool, type);
    st.missing.delete(type);
  } catch (err) {
    const n = (st.failures.get(type) ?? 0) + 1;
    st.failures.set(type, n);
    // The first retry is immediate (the next hook), then RETRY_BASE_MS, twice that, ... up to MAX_RETRY_MS: a tool the engine keeps refusing must not cost every call.
    st.retryAt.set(type, Date.now() + (n === 1 ? 0 : Math.min(MAX_RETRY_MS, RETRY_BASE_MS * 2 ** (n - 2))));
    // The engine starts a log line with the plugin's name; logging is best effort, and once per tool.
    if (n === 1) {
      try {
        // not awaited: a log call that never settles must not keep the tool pending (and so never retried)
        void Promise.resolve($.ui.log(`registering ${type} failed: ${message(err)}`)).catch(() => undefined);
      } catch {
        // best effort: this function never rejects
      }
    }
  }
}

/**
 * Starts the registration of every missing tool that is not under way and not waiting for a retry, then waits for the
 * ones that did not hang before, at most `ms`. A registration that never answers is waited for once: the tool is marked
 * stuck, and the other tools and later hooks do not wait for it again.
 *
 * @param $ - The engine.
 * @param st - The registration state.
 * @param ms - The longest wait.
 */
export async function ensureTools($: Engine, st: RegState, ms: number): Promise<void> {
  const now = Date.now();
  for (const type of TOOLS) {
    if (!st.missing.has(type) || st.pending.has(type) || (st.retryAt.get(type) ?? 0) > now) continue;
    const p = registerOne($, st, type);
    st.pending.set(type, p);
    void p.then(() => {
      st.pending.delete(type);
      st.stuck.delete(type); // a tool that hung once is waited for again when it is retried
    });
  }
  const waiting = [...st.pending].filter(([type]) => !st.stuck.has(type));
  if (waiting.length === 0) return;
  let timer: { cancel(): void } | undefined;
  try {
    const late = await Promise.race([
      Promise.all(waiting.map(([, p]) => p)).then(() => false),
      new Promise<boolean>((resolve) => {
        timer = $.clock.after(ms, () => resolve(true));
      }),
    ]);
    if (late) { for (const [type] of waiting) if (st.pending.has(type)) st.stuck.add(type); }
  } finally {
    timer?.cancel();
  }
}
