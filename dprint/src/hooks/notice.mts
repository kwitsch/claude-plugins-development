/**
 * Claude Code function-hooks module: a 15 s toast when the working directory has no dprint config.
 *
 * @remarks
 * EARLY ACCESS API (Claude Code 2.1.316 declarations). Fires after `session.start`, `classic.CwdChanged` and the
 * `EnterWorktree`/`ExitWorktree` tool calls. The check runs detached after the event and swallows every error,
 * so it never blocks, delays or alters the event. No `node:` imports and no `claude-code` import (hooks modules
 * run without Node; the engine's declaration file is not in the repo), so the used engine members are typed
 * structurally below. The engine's static check wants every hook a named function literal, `$` and `on` spelled
 * as such, and no shadowed names, which is why `scripts/build.mjs` does not mangle or compress `hooks/*.mjs`.
 *
 * @packageDocumentation
 */
import { CONFIG_NAMES } from "../skills/init-dprint/config-names.mjs";

/** How long the missing-config toast stays, in ms: long enough to read, short enough not to nag; a UX default, safe to change. */
const TOAST_MS = 15_000;

/** The part of the engine interface `$` this module uses. */
type Engine = {
  /** Filesystem reads. */
  fs: {
    /** Whether the path exists. */
    exists(path: string): Promise<boolean>;
  };
  /** User interface. */
  ui: {
    /** Shows a toast. */
    toast(text: string, options?: { timeoutMs?: number }): void;
  };
  /** Session facts. */
  session: {
    /** Absolute cwd of the session. */
    cwd(): Promise<string>;
  };
};

/** Continue the hook chain. */
type Next = (e: unknown) => Promise<unknown>;

/** A function hook. */
type Hook = ($: Engine, e: unknown, next: Next) => Promise<unknown>;

/** The `on` the engine passes to `register`. */
type On = {
  /** Hook an event. */
  (event: string, hook: Hook): void;
  /** Hook an event filtered by a matcher. */
  (event: string, matcher: { tool: string }, hook: Hook): void;
};

/**
 * Show the missing-config toast unless `dir` holds one of {@link CONFIG_NAMES}.
 *
 * @param $ - Engine interface.
 * @param dir - Absolute directory to check; empty means unknown (no toast).
 * @returns Resolves once the check (and any toast) is done.
 */
async function warnIfNoConfig($: Engine, dir: string): Promise<void> {
  if (!dir) return;
  for (const n of CONFIG_NAMES) if (await $.fs.exists(`${dir}/${n}`)) return;
  $.ui.toast(
    `dprint: no dprint config in ${dir}, formatting is off (${CONFIG_NAMES.join(", ")})`,
    { timeoutMs: TOAST_MS },
  );
}

/**
 * `session.start` and `EnterWorktree`/`ExitWorktree` hook: run the event, then check the session cwd detached.
 *
 * @param $ - Engine interface.
 * @param e - Event, passed on unchanged.
 * @param next - Continues the hook chain.
 * @returns `next`'s result, unchanged.
 */
async function onSessionCwd($: Engine, e: unknown, next: Next): Promise<unknown> {
  const r = await next(e);
  // inside .then so even a synchronous throw from the engine lands in .catch
  void Promise.resolve().then(() => $.session.cwd()).then((dir) => warnIfNoConfig($, dir)).catch(() => {});
  return r;
}

/**
 * `classic.CwdChanged` hook: run the event, then check the event's `new_cwd` detached.
 *
 * @param $ - Engine interface.
 * @param e - CwdChanged event (`new_cwd`), passed on unchanged.
 * @param next - Continues the hook chain.
 * @returns `next`'s result, unchanged.
 */
async function onCwdChanged($: Engine, e: unknown, next: Next): Promise<unknown> {
  const r = await next(e);
  void warnIfNoConfig($, (e as { new_cwd?: string } | null | undefined)?.new_cwd ?? "").catch(() => {});
  return r;
}

/**
 * Module entry point called by the engine.
 *
 * @param on - Registers a hook for an event.
 */
export const register = (on: On): void => {
  on("session.start", onSessionCwd);
  on("classic.CwdChanged", onCwdChanged);
  on("tool.call", { tool: "EnterWorktree" }, onSessionCwd);
  on("tool.call", { tool: "ExitWorktree" }, onSessionCwd);
};
