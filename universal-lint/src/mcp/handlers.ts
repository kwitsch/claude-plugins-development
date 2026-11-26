/**
 * Tool handlers of the `lint` MCP server: input normalisation, the session key, the cwd memo, the outbox of ready
 * reports and the runs of the lint-core handlers. No state at module level: `createHandlers()` owns it.
 *
 * @packageDocumentation
 */
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { capSet, editedHandler, fileChangedHandler, HOOK_TIMEOUT_MS, type HookResult, markBlocked, ownerOf, type PostToolUseHookInput, runInCall, stopAlreadyBlocked, sweepHandler, truncate } from "../hooks/lint-core.js";

/** Longest hold of a keyed `next_report` (the mod's wake poll), in ms; a larger or missing `wait_ms` is clamped to it. */
export const WAKE_WAIT_MS = 25_000;
/** Arguments of every tool: the hook input plus the mod's `key` and `next_report`'s `wait_ms`; every field is checked before use. */
export type ToolArgs = PostToolUseHookInput & { key?: unknown; wait_ms?: unknown };
/** A tool's answer object (the call's `structuredContent`). */
export type Answer = Record<string, unknown>;
/** Fields an `mcp_tool` hook template fills with `""` when the event lacks them: `""` means absent. */
const EMPTY_AS_ABSENT = ["agent_id", "scratchpad_dir", "file_path", "event", "key"];

/**
 * Creates the five tool handlers with their shared state.
 *
 * @returns `file_edited`, `next_report` (called by the mod, keyed), `stop`, `file_changed`, `prompt_submitted` (called by `mcp_tool` hooks) and `closeAll` (stdin closed: abort every run, release every waiter).
 */
export function createHandlers() {
  /** Accepted cwds (the server's cwd, the project dir, every cwd a hook or a keyed call named). */
  const roots = new Map<string, true>();
  /** Scratchpad per session, learned from hook calls; unknown means no scratchpad exclusion. */
  const scratchpads = new Map<string, string>();
  /** The one key per session, issued to its first caller. */
  const keys = new Map<string, string>();
  /** Ready reports in arrival order, each for one owner. */
  const outbox = new Map<number, { owner: string; text: string }>();
  /** A pending `next_report` per owner (the wake poll); resolved by a delivery or a prompt. */
  const waiters = new Map<string, (r: Answer) => void>();
  /** Abort controllers of the detached lint runs. */
  const jobs = new Set<AbortController>();
  /** Next outbox sequence number. */
  let seq = 0;
  capSet(roots, process.cwd(), true);
  if (process.env.CLAUDE_PROJECT_DIR) capSet(roots, process.env.CLAUDE_PROJECT_DIR, true);

  /**
   * Whether the session runs headless (SDK, `claude -p`): no idle wake there.
   *
   * @returns True when `CLAUDE_CODE_ENTRYPOINT` starts with `sdk`.
   */
  const headless = (): boolean => process.env.CLAUDE_CODE_ENTRYPOINT?.startsWith("sdk") === true;
  /**
   * The main conversation's owner of a session.
   *
   * @param session - The session id.
   * @returns The owner key `ownerOf` gives a call without `agent_id`.
   */
  const mainOwner = (session: unknown): string => ownerOf({ cwd: "", session_id: session });

  /**
   * Normalises a tool's arguments: `""` of the template-filled fields means absent, `stop_hook_active` (text in a hook input) becomes a boolean.
   *
   * @param raw - The arguments as received.
   * @returns A normalised copy.
   */
  function normalise(raw: ToolArgs): ToolArgs {
    const a: ToolArgs = { ...raw };
    for (const k of EMPTY_AS_ABSENT) if (a[k] === "") Reflect.deleteProperty(a, k);
    a.stop_hook_active = raw.stop_hook_active === true || raw.stop_hook_active === "true";
    return a;
  }

  /**
   * The key check of the mod's tools.
   *
   * @param a - Normalised arguments.
   * @returns `"ok"` for the session's key, `"reject"` for a missing session or a missing or wrong key, the key issue `{ key, headless }` for a session's first call.
   */
  function gate(a: ToolArgs): "ok" | "reject" | { key: string; headless: boolean } {
    if (typeof a.session_id !== "string" || a.session_id === "") return "reject";
    const known = keys.get(a.session_id);
    if (known === undefined) {
      const key = randomUUID();
      capSet(keys, a.session_id, key);
      return { key, headless: headless() };
    }
    return a.key === known ? "ok" : "reject";
  }

  /**
   * Accepts a cwd: a known root, or an absolute path to an existing directory that is not a filesystem root (then remembered).
   *
   * @param cwd - The call's cwd.
   * @returns Whether it is accepted.
   */
  function acceptCwd(cwd: unknown): boolean {
    try {
      if (typeof cwd !== "string") return false;
      if (roots.has(cwd)) return true;
      if (!path.isAbsolute(cwd)) return false;
      const real = realpathSync(cwd);
      if (!statSync(real).isDirectory() || path.parse(real).root === real) return false;
      capSet(roots, cwd, true);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A hook-called tool's bookkeeping: memo of its cwd and of the session's scratchpad.
   *
   * @param a - Normalised arguments.
   */
  function learn(a: ToolArgs): void {
    acceptCwd(a.cwd);
    if (typeof a.session_id === "string" && a.session_id && typeof a.scratchpad_dir === "string") capSet(scratchpads, a.session_id, a.scratchpad_dir);
  }

  /**
   * Puts a report into the outbox and wakes the owner's waiter.
   *
   * @param owner - Who gets the report.
   * @param text - The report; nothing happens when it is empty.
   */
  function deliver(owner: string, text: string | undefined): void {
    if (!text) return;
    capSet(outbox, seq++, { owner, text });
    waiters.get(owner)?.({ state: "ready" });
  }
  /**
   * Whether an owner has a ready report.
   *
   * @param owner - The owner.
   * @returns True when the outbox holds one for it.
   */
  const pending = (owner: string): boolean => [...outbox.values()].some((o) => o.owner === owner);
  /**
   * Takes every ready report of an owner out of the outbox.
   *
   * @param owner - The owner.
   * @returns The reports joined by a blank line, truncated; `""` when there is none.
   */
  function drain(owner: string): string {
    const texts: string[] = [];
    for (const [n, o] of outbox) {
      if (o.owner !== owner) continue;
      texts.push(o.text);
      outbox.delete(n);
    }
    return truncate(texts.join("\n\n"));
  }

  /**
   * One lint run with its own deadline; `signal` (an awaited call) aborts it too, without one the run is a detached job.
   *
   * @param fn - The lint-core handler run.
   * @param signal - The tool call's abort signal.
   * @returns The run's findings text, if any.
   */
  function run(fn: () => Promise<HookResult>, signal?: AbortSignal): Promise<string | undefined> {
    const c = new AbortController();
    const onAbort = (): void => c.abort();
    const timer = setTimeout(onAbort, HOOK_TIMEOUT_MS);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    else jobs.add(c);
    return runInCall(c.signal, fn).then((r) => r.hookSpecificOutput?.additionalContext).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      jobs.delete(c);
    });
  }

  /**
   * The mod's Write/Edit call (keyed): lints the written file (a subagent's edit is only journaled) and answers the main conversation's ready reports.
   *
   * @param raw - Hook-shaped arguments plus `key`.
   * @param signal - Aborts when the call is cancelled.
   * @returns `{ context }` with the main conversation's reports, a key issue, or `{}`.
   */
  async function file_edited(raw: ToolArgs, signal: AbortSignal): Promise<Answer> {
    try {
      const a = normalise(raw);
      const g = gate(a);
      if (g === "reject") return {};
      if (g !== "ok") return g;
      if (!acceptCwd(a.cwd)) return {};
      Reflect.deleteProperty(a, "key");
      const sp = scratchpads.get(String(a.session_id));
      if (sp === undefined) Reflect.deleteProperty(a, "scratchpad_dir");
      else a.scratchpad_dir = sp;
      const owner = ownerOf(a);
      deliver(owner, await run(() => editedHandler(a), signal));
      const main = mainOwner(a.session_id);
      return a.agent_id === undefined && pending(main) ? { context: drain(main) } : {};
    } catch {
      return {};
    }
  }

  /**
   * The mod's wake poll (keyed): whether the main conversation has a ready report. Never carries finding text, consumes nothing.
   *
   * @param raw - `session_id`, `key`, `wait_ms`.
   * @returns `{ state: "ready" | "timeout" | "busy" }` or a key issue.
   */
  function next_report(raw: ToolArgs): Answer {
    try {
      const a = normalise(raw);
      const g = gate(a);
      if (g === "reject") return { state: "busy" };
      if (g !== "ok") return g;
      if (pending(mainOwner(a.session_id))) return { state: "ready" };
      const wait = Math.min(Math.max(typeof a.wait_ms === "number" && Number.isFinite(a.wait_ms) ? a.wait_ms : WAKE_WAIT_MS, 0), WAKE_WAIT_MS);
      return { state: wait === 0 ? "timeout" : "busy" };
    } catch {
      return { state: "busy" };
    }
  }

  /**
   * Stop and SubagentStop: sweep the stopping agent's unreported files and block the stop once with its reports.
   *
   * @param raw - The hook input.
   * @param signal - Aborts when the call is cancelled.
   * @returns `{ decision: "block", reason }` or `{}`.
   */
  async function stop(raw: ToolArgs, signal: AbortSignal): Promise<Answer> {
    try {
      const a = normalise(raw);
      learn(a);
      const owner = ownerOf(a);
      if (stopAlreadyBlocked(a)) return {};
      const swept = await run(() => sweepHandler(a), signal);
      const reason = [drain(owner), swept].filter(Boolean).join("\n\n");
      if (!reason) return {};
      markBlocked(owner);
      return { decision: "block", reason };
    } catch {
      return {};
    }
  }

  /**
   * FileChanged: lint a watched file changed outside Write/Edit; its findings go to the main conversation's outbox.
   *
   * @param raw - The hook input.
   * @param signal - Aborts when the call is cancelled.
   * @returns Always `{}`.
   */
  async function file_changed(raw: ToolArgs, signal: AbortSignal): Promise<Answer> {
    try {
      const a = normalise(raw);
      learn(a);
      deliver(mainOwner(a.session_id), await run(() => fileChangedHandler(a), signal));
    } catch {
      // fail open
    }
    return {};
  }

  /**
   * UserPromptSubmit: end the main conversation's wake poll and hand it its ready reports.
   *
   * @param raw - The hook input.
   * @returns The reports as `UserPromptSubmit` context, or `{}`.
   */
  function prompt_submitted(raw: ToolArgs): Answer {
    try {
      const a = normalise(raw);
      learn(a);
      const owner = mainOwner(a.session_id);
      waiters.get(owner)?.({ state: "busy" });
      return pending(owner) ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: drain(owner) } } : {};
    } catch {
      return {};
    }
  }

  /** stdin closed: abort every detached run and release every waiter. */
  function closeAll(): void {
    for (const c of jobs) c.abort();
    for (const w of waiters.values()) w({ state: "busy" });
  }

  return { file_edited, next_report, stop, file_changed, prompt_submitted, closeAll };
}
