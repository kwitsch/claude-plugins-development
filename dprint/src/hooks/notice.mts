/**
 * Claude Code function-hooks module: a 15 s toast when the working directory has a dprint config but dprint cannot run.
 *
 * @remarks
 * EARLY ACCESS API (Claude Code 2.1.316 declarations). Fires after `session.start`, `classic.CwdChanged` and the
 * `EnterWorktree`/`ExitWorktree` tool calls. The check runs detached after the event and swallows every error,
 * so it never blocks, delays or alters the event. A directory without a dprint config is left alone and nothing is
 * spawned; with one, `$.process.run` probes for a runnable dprint in the order of `find-dprint.mts`, and only a
 * failed probe toasts. No imports at all (hooks modules run without Node and the engine's declaration file is not
 * in the repo), so the used engine members are typed structurally below. The engine's static check wants every
 * hook a named function literal, `$` and `on` spelled as such, and no shadowed names, which is why
 * `scripts/build.mjs` does not mangle or compress `hooks/*.mjs`.
 *
 * @packageDocumentation
 */

/**
 * dprint's config file names. A copy of `CONFIG_NAMES` (`skills/dprint/config-names.mts`): a relative import
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

/** How long the cannot-run toast stays, in ms: long enough to read, short enough not to nag; a UX default, safe to change. */
const TOAST_MS = 15_000;

/** Timeout of each dprint probe, in ms; a cold `npx --yes dprint` download measured about 2 s (same value as `find-dprint.mts`). */
const PROBE_TIMEOUT_MS = 10_000;

/** How long a failed probe stays cached before the next event re-probes, in ms (same as `NPX_RETRY_MS` in `find-dprint.mts`). */
const PROBE_RETRY_MS = 30_000;

/** When the last toast was shown (`Date.now()`); the cause is machine-wide, so one toast per {@link TOAST_MS} covers every directory. */
let shownAt: number | undefined;

/** One dprint probe, in flight or settled. */
type Probe = {
  /** Whether a dprint runs on this machine. */
  ok: Promise<boolean>;
  /** When the probe resolved false or rejected (`Date.now()`); unset while in flight and after a success. */
  failedAt?: number;
};

/** The latest dprint probe; a success is kept for the life of the module, a failure for {@link PROBE_RETRY_MS}. */
let probe: Probe | null = null;

/** Set once a probe succeeded: from then on no event walks the filesystem, as no toast can follow. */
let dprintRuns = false;

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
  /** Environment of the Claude Code process. */
  env: {
    /** Value of the variable, `undefined` when unset. */
    get(name: string): Promise<string | undefined>;
  };
  /** Child processes. */
  process: {
    /** Run `argv` without a shell; resolves with the exit code, rejects when the program cannot start or times out. */
    run(argv: string[], init?: { cwd?: string; timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
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
 * Whether `since` (a `Date.now()` stamp) is less than `ms` ago; a stamp in the future (the wall clock stepped back) counts as expired.
 *
 * @param since - Earlier `Date.now()` value.
 * @param ms - Window in ms.
 * @returns Whether the window is still open.
 */
function withinMs(since: number, ms: number): boolean {
  const age = Date.now() - since;
  return age >= 0 && age < ms;
}

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
 * Whether `argv` runs and prints a dprint version, read as `find-dprint.mts` reads it: exit code 0 and stdout
 * starting with `dprint ` and a digit. A rejected run (program not found, timeout) counts as a failure.
 *
 * @param $ - Engine interface.
 * @param argv - Program and arguments, run without a shell.
 * @param cwd - Working directory of the run.
 * @returns Whether that dprint runs.
 */
async function runsDprint($: Engine, argv: string[], cwd: string): Promise<boolean> {
  try {
    const r = await $.process.run(argv, { cwd, timeoutMs: PROBE_TIMEOUT_MS });
    return r.exitCode === 0 && /^dprint \d/.test(r.stdout.trim());
  } catch {
    return false;
  }
}

/**
 * Whether a dprint can run on this machine, in the order of `find-dprint.mts`: `dprint` on PATH, then
 * `~/.dprint/bin/dprint`, then a dprint already in the npx cache. Unlike `find-dprint.mts` (which runs on a format
 * request) this runs unprompted on every session start and cd, so npx gets `--no` (no download) and every probe runs
 * in HOME (else `/`), never in the project, whose `node_modules/.bin` npx would prefer. Concurrent callers share one
 * probe; a success is cached for the life of the module, a failure for {@link PROBE_RETRY_MS}.
 *
 * @param $ - Engine interface.
 * @returns Whether any of the three runs dprint.
 */
function hasDprint($: Engine): Promise<boolean> {
  if (probe && (probe.failedAt === undefined || withinMs(probe.failedAt, PROBE_RETRY_MS))) return probe.ok;
  const entry: Probe = {
    ok: (async () => {
      const home = await $.env.get("HOME");
      const cwd = home || "/";
      if (await runsDprint($, ["dprint", "--version"], cwd)) return true;
      if (home && (await runsDprint($, [`${home}/.dprint/bin/dprint`, "--version"], cwd))) return true;
      // `--` keeps npx from reading --version as its own flag once --no is given
      return runsDprint($, ["npx", "--no", "--", "dprint", "--version"], cwd);
    })(),
  };
  // a rejected chain (env.get) is retried like a failed one, never cached for good
  const fail = () => {
    entry.failedAt = Date.now();
  };
  entry.ok.then((ok) => {
    if (ok) dprintRuns = true;
    else fail();
  }, fail);
  probe = entry;
  return entry.ok;
}

/**
 * Show the cannot-run toast when `dir` or an ancestor up to the git repository or worktree root (as for the format
 * gate) holds one of {@link CONFIG_NAMES} but no dprint runs. No config: nothing is probed and no toast. At most one
 * toast per {@link TOAST_MS}.
 *
 * @param $ - Engine interface.
 * @param dir - Absolute directory to check; empty means unknown (no toast).
 * @returns Resolves once the check (and any toast) is done.
 */
async function warnIfNoDprint($: Engine, dir: string): Promise<void> {
  const recentlyShown = () => shownAt !== undefined && withinMs(shownAt, TOAST_MS);
  // before the config walk: these events cost no filesystem work
  if (!dir || dprintRuns || recentlyShown()) return;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  let found = false;
  for (let d = dir; d && !found; d = parentOf(d)) {
    const base = d.endsWith(sep) ? d : d + sep;
    const [git, ...configs] = await Promise.all([".git", ...CONFIG_NAMES].map((n) => $.fs.exists(base + n)));
    found = configs.some(Boolean);
    if (git) break; // repository or worktree root: never search above it
  }
  if (!found) return; // the project does not use dprint: nothing to warn about, nothing spawned
  if (await hasDprint($)) return; // before the dedupe, so a dir whose probe succeeds never takes a slot
  if (recentlyShown()) return; // a concurrent event may have toasted while the probe ran
  shownAt = Date.now();
  $.ui.toast(
    `dprint: ${dir} has a dprint config but no dprint is installed (none on PATH, in ~/.dprint/bin or in the npx cache); run /dprint:dprint init`,
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
  // resultingCwd is async, so even a synchronous engine throw inside it lands in .catch
  void resultingCwd($, e, r).then((dir) => warnIfNoDprint($, dir)).catch(() => {});
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
  void warnIfNoDprint($, (e as { new_cwd?: string } | null | undefined)?.new_cwd ?? "").catch(() => {});
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
