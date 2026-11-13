/**
 * Claude Code function-hooks module: a 15 s toast when the working directory has a dprint config but dprint cannot run.
 *
 * @remarks
 * EARLY ACCESS API (Claude Code 2.1.316 declarations). Fires after `session.start`, `classic.CwdChanged` and the
 * `EnterWorktree`/`ExitWorktree` tool calls. The check runs detached after the event and swallows every error,
 * so it never blocks, delays or alters the event. A directory without a dprint config is left alone and nothing is
 * spawned; with one, the module picks the one dprint `find-dprint.mts` would pick (first `<PATH entry>/dprint` that
 * exists, else `~/.dprint/bin/dprint`, else the npx cache), runs `--version` on it via `$.process.run`, and only an
 * unusable pick (cannot start, exits non-zero, prints no version, older than `MIN_VERSION`) toasts, naming the
 * cause. No imports at all (hooks modules run without Node and the engine's declaration file is not
 * in the repo), so the used engine members are typed structurally below. The engine's static check wants every
 * hook a named function literal, `$` and `on` spelled as such, and no shadowed names, which is why
 * `development/scripts/build-plugin.mts` does not mangle or compress `hooks/*.mjs`.
 *
 * @packageDocumentation
 */

/**
 * dprint's config file names. A copy of `CONFIG_NAMES` (`skills/dprint/config-names.mts`): a relative import
 * may not resolve in the engine; `tests/notice.test.mts` fails on drift.
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

/** Timeout of each dprint probe, in ms (same value as `NPX_PROBE_TIMEOUT_MS` in `find-dprint.mts`; these probes never download). */
const PROBE_TIMEOUT_MS = 10_000;

/** How long a failed probe stays cached before the next event re-probes, in ms (same as `NPX_RETRY_MS` in `find-dprint.mts`). */
const PROBE_RETRY_MS = 30_000;

/** Minimum dprint version the format hooks need (`dprint lsp`). A copy of `MIN_VERSION` (`skills/dprint/check-dprint.mts`); `tests/notice.test.mts` fails on drift. */
const MIN_VERSION = "0.50.0";

/** The reason when no dprint exists on PATH, in `~/.dprint/bin` or in the npx cache (the wording lives only here). */
const NOT_INSTALLED = "no dprint is installed (none on PATH, in ~/.dprint/bin or in the npx cache)";

/** When the last toast was shown (`Date.now()`); the cause is machine-wide, so one toast per {@link TOAST_MS} covers every directory. */
let shownAt: number | undefined;

/** Why one dprint is not usable: `kind` drives the caller's logic, `text` goes into the toast. */
type Problem = {
  /** Spawn rejected (cannot start or timeout), non-zero exit, no version in the output, or below {@link MIN_VERSION}. */
  kind: "start" | "exit" | "output" | "old";
  /** The reason as the toast shows it. */
  text: string;
};

/** One dprint probe, in flight or settled. */
type Probe = {
  /** Why the dprint `findDprint` would pick is not usable, `null` when it is. */
  problem: Promise<string | null>;
  /** When the probe resolved with a problem or rejected (`Date.now()`); unset while in flight and after a success. */
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
 * Judge one dprint: it must start and answer `--version` within {@link PROBE_TIMEOUT_MS}, exit 0, print
 * `dprint X.Y.Z` (the regex and compare rule of `check-dprint.mts`; a prerelease of an equal version sorts below)
 * and be at least {@link MIN_VERSION}.
 *
 * @param $ - Engine interface.
 * @param argv - Program and arguments, run without a shell.
 * @param cwd - Working directory of the run.
 * @param name - How the toast names this dprint (its path, or `npx`).
 * @returns Why it is not usable (`kind` for callers, `text` for the toast), `null` when it is.
 */
async function judge($: Engine, argv: string[], cwd: string, name: string): Promise<Problem | null> {
  let r: Awaited<ReturnType<Engine["process"]["run"]>>;
  try {
    r = await $.process.run(argv, { cwd, timeoutMs: PROBE_TIMEOUT_MS });
  } catch {
    // shortcut: timeout and cannot-start share one text, the engine's rejection shape is not in the repo; split when it is
    return { kind: "start", text: `${name} could not start or took over ${PROBE_TIMEOUT_MS / 1000} s to answer --version` };
  }
  if (r.exitCode !== 0) return { kind: "exit", text: `${name} --version exited ${r.exitCode}` };
  const m = /^dprint (\d+)\.(\d+)\.(\d+)(-\S+)?/.exec(r.stdout.trim());
  if (!m) return { kind: "output", text: `${name} --version printed no dprint version` };
  const min = MIN_VERSION.split(".").map(Number);
  let cmp = 0;
  for (let i = 0; i < 3 && cmp === 0; i++) cmp = Number(m[i + 1]) - min[i];
  if (cmp === 0 && m[4]) cmp = -1; // a prerelease of the minimum sorts below it
  if (cmp >= 0) return null;
  return { kind: "old", text: `${name} is dprint ${m[1]}.${m[2]}.${m[3]}${m[4] ?? ""}, the plugin needs >= ${MIN_VERSION}` };
}

/**
 * Why the dprint the MCP server's `findDprint` would pick is not usable, `null` when it is. Picks exactly one, in
 * `find-dprint.mts`'s order: the first `<PATH entry>/dprint` that exists, else `$HOME/.dprint/bin/dprint` if it
 * exists, else the npx cache; only the pick is run (`--version`), so a broken PATH dprint is never masked by a
 * working later one, as `findDprint` would not mask it either. Unlike `find-dprint.mts` (which runs on a format
 * request) this runs unprompted on every session start and cd, so npx gets `--no` (no download) and every probe runs
 * in HOME (else `/`), never in the project, whose `node_modules/.bin` npx would prefer. Concurrent callers share one
 * probe; a success is cached for the life of the module, a failure for {@link PROBE_RETRY_MS}.
 *
 * @param $ - Engine interface.
 * @returns Why the pick is unusable, `null` when it is usable.
 */
function dprintProblem($: Engine): Promise<string | null> {
  if (probe && (probe.failedAt === undefined || withinMs(probe.failedAt, PROBE_RETRY_MS))) return probe.problem;
  const entry: Probe = {
    problem: (async () => {
      const [home, pathVar] = await Promise.all([$.env.get("HOME"), $.env.get("PATH")]);
      // a HOME that does not exist would make every spawn fail and the toast blame dprint
      const cwd = home && (await $.fs.exists(home)) ? home : "/";
      // shortcut: existence is weaker than findDprint's executable-file check (a non-executable `dprint` earlier on PATH is picked here), upgrade when the engine offers an executable check
      // shortcut: relative PATH entries are skipped (findDprint resolves them against the MCP server's cwd, unknown here), upgrade if the hook can learn that cwd
      const candidates = (pathVar ?? "")
        .split(":")
        .filter((d) => d.startsWith("/"))
        .map((d) => `${d.replace(/\/+$/, "")}/dprint`);
      const found = await Promise.all(candidates.map((p) => $.fs.exists(p)));
      let pick = candidates.find((_, i) => found[i]);
      if (!pick && home && (await $.fs.exists(`${home}/.dprint/bin/dprint`))) pick = `${home}/.dprint/bin/dprint`;
      if (pick) return (await judge($, [pick, "--version"], cwd, pick))?.text ?? null;
      // `--` keeps npx from reading --version as its own flag once --no is given; --prefer-offline: npx checks a
      // name-only spec against the registry's latest, which offline or after a new release fails a cached dprint
      const npx = await judge($, ["npx", "--no", "--prefer-offline", "--", "dprint", "--version"], cwd, "npx");
      // `npx --no` exits non-zero when nothing is cached; every other cause keeps its own text
      return npx?.kind === "exit" ? NOT_INSTALLED : (npx?.text ?? null);
    })(),
  };
  // a rejected chain (env.get, fs.exists) is retried like a failed one, never cached for good
  const fail = () => {
    entry.failedAt = Date.now();
  };
  entry.problem.then((problem) => {
    if (problem === null) dprintRuns = true;
    else fail();
  }, fail);
  probe = entry;
  return entry.problem;
}

/**
 * Show the cannot-run toast when `dir` or an ancestor up to the git repository or worktree root (as for the format
 * gate) holds one of {@link CONFIG_NAMES} but the dprint the hooks would use is unusable (the toast names why). No config: nothing is probed and no toast. At most one
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
  const problem = await dprintProblem($);
  if (problem === null) return; // before the dedupe, so a dir whose probe succeeds never takes a slot
  if (recentlyShown()) return; // a concurrent event may have toasted while the probe ran
  shownAt = Date.now();
  $.ui.toast(`dprint: ${dir} (or a parent up to the git root) has a dprint config but ${problem}; run /dprint:dprint init`, { timeoutMs: TOAST_MS });
}

/**
 * The directory the event left the session in: a worktree tool's own result (as the format gate reads it), else
 * the session cwd.
 *
 * @remarks
 * Each tool names its own field: `EnterWorktree` the new `worktreePath`, `ExitWorktree` the `restoredCwd` (its
 * output also carries the `worktreePath` it just left, which must not be checked). The engine hands a tool's output
 * back as `{ result }` in the chain's result; a `tool_response` on the event is read too.
 *
 * @param $ - Engine interface.
 * @param e - Event: `tool` names the worktree tool; may carry `tool_response`.
 * @param r - The chain's result.
 * @returns Absolute directory, or `""` when unknown.
 */
async function resultingCwd($: Engine, e: unknown, r: unknown): Promise<string> {
  const ev = e as { tool?: string; tool_response?: WorktreeResult } | null | undefined;
  const key = ev?.tool === "ExitWorktree" ? "restoredCwd" : ev?.tool === "EnterWorktree" ? "worktreePath" : null;
  if (key !== null) {
    for (const x of [ev?.tool_response, (r as { result?: WorktreeResult } | null | undefined)?.result, r as WorktreeResult | null | undefined]) {
      const dir = x?.[key];
      if (typeof dir === "string" && dir) return dir;
    }
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
