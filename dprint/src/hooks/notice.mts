/**
 * Claude Code function-hooks module: a 15 s toast when the working directory has no dprint config.
 *
 * @remarks
 * EARLY ACCESS API (Claude Code 2.1.316 declarations). Fires after `session.start`, `classic.CwdChanged` and the
 * `EnterWorktree`/`ExitWorktree` tool calls. The check runs detached after the event and swallows every error,
 * so it never blocks, delays or alters the event. No imports at all (hooks modules run without Node and the
 * engine's declaration file is not in the repo), so the used engine members are typed structurally below. The
 * engine's static check wants every hook a named function literal, `$` and `on` spelled as such, and no shadowed
 * names, which is why `scripts/build.mjs` does not mangle or compress `hooks/*.mjs`.
 *
 * @packageDocumentation
 */

/**
 * dprint's config file names. A copy of `CONFIG_NAMES` (`skills/init-dprint/config-names.mts`): a relative import
 * may not resolve in the engine; `tests/notice.test.mjs` fails on drift.
 */
const CONFIG_NAMES = [
  "dprint.json",
  "dprint.jsonc",
  ".dprint.json",
  ".dprint.jsonc",
  ".config/dprint.json",
  ".config/dprint.jsonc",
];

/** How long the missing-config toast stays, in ms: long enough to read, short enough not to nag; a UX default, safe to change. */
const TOAST_MS = 15_000;

/** When each directory (trailing separators stripped) last got a toast, pruned after {@link TOAST_MS}; one action can fire several of the hooks below. */
const shown = new Map<string, number>();

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

/** Where a worktree tool reports the directory it moved to. */
type WorktreeResult = { worktreePath?: string; restoredCwd?: string } | null | undefined;

/**
 * Parent of `dir`, string-wise (no Node `path`).
 *
 * @param dir - Absolute directory with `/` or `\` separators.
 * @returns The parent, or `""` at the top.
 */
function parentOf(dir: string): string {
  const i = Math.max(dir.lastIndexOf("/"), dir.lastIndexOf("\\"));
  if (i > 0) return dir.slice(0, i);
  return i === 0 && dir.length > 1 ? dir.slice(0, 1) : "";
}

/**
 * Show the missing-config toast unless `dir` or an ancestor up to the git repository or worktree root (as for the
 * format gate) holds one of {@link CONFIG_NAMES}. At most one toast per directory per {@link TOAST_MS}.
 *
 * @param $ - Engine interface.
 * @param dir - Absolute directory to check; empty means unknown (no toast).
 * @returns Resolves once the check (and any toast) is done.
 */
async function warnIfNoConfig($: Engine, dir: string): Promise<void> {
  if (!dir) return;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  for (let d = dir; d; d = parentOf(d)) {
    const base = d.endsWith(sep) ? d : d + sep;
    for (const n of CONFIG_NAMES) if (await $.fs.exists(base + n)) return;
    if (await $.fs.exists(base + ".git")) break; // repository or worktree root: never search above it
  }
  const now = Date.now();
  for (const [k, t] of shown) if (now - t >= TOAST_MS) shown.delete(k); // expired entries never dedupe again
  const key = dir.replace(/[\\/]+$/, "") || dir; // `/a/b` and `/a/b/` are one dir
  if (shown.has(key)) return;
  shown.set(key, now);
  $.ui.toast(
    `dprint: no dprint config in ${dir} or above (up to the git root), formatting is off (${CONFIG_NAMES.join(", ")})`,
    { timeoutMs: TOAST_MS },
  );
}

/**
 * The directory the event left the session in: a worktree tool's own result (as the format gate reads it), else
 * the session cwd.
 *
 * @param $ - Engine interface.
 * @param e - Event, may carry `tool_response`.
 * @param r - The chain's result.
 * @returns Absolute directory, or `""` when unknown.
 */
async function resultingCwd($: Engine, e: unknown, r: unknown): Promise<string> {
  const fromEvent = (e as { tool_response?: WorktreeResult } | null | undefined)?.tool_response;
  for (const x of [fromEvent, r as WorktreeResult]) {
    const dir = x?.worktreePath ?? x?.restoredCwd;
    if (typeof dir === "string" && dir) return dir;
  }
  return $.session.cwd();
}

/**
 * `session.start` and `EnterWorktree`/`ExitWorktree` hook: run the event, then check the resulting cwd detached.
 *
 * @param $ - Engine interface.
 * @param e - Event, passed on unchanged.
 * @param next - Continues the hook chain.
 * @returns `next`'s result, unchanged.
 */
async function onSessionCwd($: Engine, e: unknown, next: Next): Promise<unknown> {
  const r = await next(e);
  // inside .then so even a synchronous throw from the engine lands in .catch
  void Promise.resolve().then(() => resultingCwd($, e, r)).then((dir) => warnIfNoConfig($, dir)).catch(() => {});
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
