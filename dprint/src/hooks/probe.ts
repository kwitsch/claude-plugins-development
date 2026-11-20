/**
 * Probe and toast logic of the function-hooks module: does the directory use dprint, can the dprint the MCP server
 * would pick run, and the toast when it cannot. Inlined into `hooks/register.js` by the build; every function takes
 * the whole engine `$` and the entry's {@link NoticeState} (no module-level state).
 *
 * @remarks
 * The engine's static check wants `$` spelled as such and no `$.<noun>` passed as a bare value. Hooks modules run
 * without Node, so the config names, `MIN_VERSION` and the `dprint X.Y.Z` regex are copies of the skill scripts'
 * (`skills/dprint/config-names.ts`, `check-dprint.ts`); `tests/notice.test.ts` fails on drift.
 *
 * @packageDocumentation
 */

import type { Engine, Next, NoticeState, Probe, Problem, WorktreeResult } from "./types.js";

/**
 * dprint's config file names. A copy of `CONFIG_NAMES` (`skills/dprint/config-names.ts`): a hooks module
 * takes nothing from the skill scripts (they import node: modules); `tests/notice.test.ts` fails on drift.
 */
export const CONFIG_NAMES = [
  "dprint.json",
  "dprint.jsonc",
  ".dprint.json",
  ".dprint.jsonc",
  ".config/dprint.json",
  ".config/dprint.jsonc",
];

/** How long the cannot-run toast stays, in ms: long enough to read, short enough not to nag; a UX default, safe to change. */
export const TOAST_MS = 15_000;

/** Timeout of each dprint probe, in ms (same value as `NPX_PROBE_TIMEOUT_MS` in `find-dprint.ts`; these probes never download). */
export const PROBE_TIMEOUT_MS = 10_000;

/** How long a failed probe stays cached before the next event re-probes, in ms (same as `NPX_RETRY_MS` in `find-dprint.ts`). */
export const PROBE_RETRY_MS = 30_000;

/** Minimum dprint version the format hooks need (`dprint lsp`). A copy of `MIN_VERSION` (`skills/dprint/check-dprint.ts`); `tests/notice.test.ts` fails on drift. */
export const MIN_VERSION = "0.50.0";

/** The reason when no dprint exists on PATH, in `$DPRINT_INSTALL/bin` (default `~/.dprint/bin`) or in the npx cache (the wording lives only here). */
export const NOT_INSTALLED = "no dprint is installed (none on PATH, in $DPRINT_INSTALL/bin (default ~/.dprint/bin) or in the npx cache)";

/**
 * Whether `since` (a `Date.now()` stamp) is less than `ms` ago; a stamp in the future (the wall clock stepped back) counts as expired.
 *
 * @param since - Earlier `Date.now()` value.
 * @param ms - Window in ms.
 * @returns Whether the window is still open.
 */
export function withinMs(since: number, ms: number): boolean {
  const age = Date.now() - since;
  return age >= 0 && age < ms;
}

/**
 * Parent of `dir`, string-wise (no Node `path`).
 *
 * @param dir - Absolute directory with `/` or `\` separators.
 * @returns The parent, or `""` at the top.
 */
export function parentOf(dir: string): string {
  const i = Math.max(dir.lastIndexOf("/"), dir.lastIndexOf("\\"));
  if (i > 0) return dir.slice(0, i);
  return i === 0 && dir.length > 1 ? dir.slice(0, 1) : "";
}

/**
 * Judge one dprint: it must start and answer `--version` within {@link PROBE_TIMEOUT_MS}, exit 0, print
 * `dprint X.Y.Z` (the regex and compare rule of `check-dprint.ts`; a prerelease of an equal version sorts below)
 * and be at least {@link MIN_VERSION}.
 *
 * @param $ - Engine interface.
 * @param argv - Program and arguments, run without a shell.
 * @param cwd - Working directory of the run.
 * @param name - How the toast names this dprint (its path, or `npx`).
 * @returns Why it is not usable (`kind` for callers, `text` for the toast), `null` when it is.
 */
export async function judge($: Engine, argv: string[], cwd: string, name: string): Promise<Problem | null> {
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
 * `find-dprint.ts`'s order: the first `<PATH entry>/dprint` that exists, else `$DPRINT_INSTALL/bin/dprint` (default `$HOME/.dprint/bin/dprint`) if it
 * exists, else the npx cache; only the pick is run (`--version`), so a broken PATH dprint is never masked by a
 * working later one, as `findDprint` would not mask it either. Unlike `find-dprint.ts` (which runs on a format
 * request) this runs unprompted on every session start and cd, so npx gets `--no` (no download) and every probe runs
 * in HOME (else `/`), never in the project, whose `node_modules/.bin` npx would prefer. Concurrent callers share one
 * probe; a success is cached for the life of the module, a failure for {@link PROBE_RETRY_MS}.
 *
 * @param $ - Engine interface.
 * @param st - The entry's state (probe cache, success flag).
 * @returns Why the pick is unusable, `null` when it is usable.
 */
export function dprintProblem($: Engine, st: NoticeState): Promise<string | null> {
  const prev = st.probe;
  if (prev && (prev.failedAt === undefined || withinMs(prev.failedAt, PROBE_RETRY_MS))) return prev.problem;
  const entry: Probe = {
    problem: (async () => {
      const [home, pathVar, install] = await Promise.all([$.env.get("HOME"), $.env.get("PATH"), $.env.get("DPRINT_INSTALL")]);
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
      // the official installer puts dprint in ${DPRINT_INSTALL:-$HOME/.dprint}/bin (as findDprint looks)
      const fallback = install ? `${install.replace(/\/+$/, "")}/bin/dprint` : home ? `${home}/.dprint/bin/dprint` : "";
      if (!pick && fallback && (await $.fs.exists(fallback))) pick = fallback;
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
    if (problem === null) st.dprintRuns = true;
    else fail();
  }, fail);
  st.probe = entry;
  return entry.problem;
}

/**
 * Show the cannot-run toast when `dir` or an ancestor up to the git repository or worktree root (as for the format
 * gate) holds one of {@link CONFIG_NAMES} but the dprint the hooks would use is unusable (the toast names why). No config: nothing is probed and no toast. At most one
 * toast per {@link TOAST_MS}.
 *
 * @param $ - Engine interface.
 * @param st - The entry's state (toast time, probe cache, success flag).
 * @param dir - Absolute directory to check; empty means unknown (no toast).
 * @returns Resolves once the check (and any toast) is done.
 */
export async function warnIfNoDprint($: Engine, st: NoticeState, dir: string): Promise<void> {
  const recentlyShown = () => st.shownAt !== undefined && withinMs(st.shownAt, TOAST_MS);
  // before the config walk: these events cost no filesystem work
  if (!dir || st.dprintRuns || recentlyShown()) return;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  let found = false;
  for (let d = dir; d && !found; d = parentOf(d)) {
    const base = d.endsWith(sep) ? d : d + sep;
    const [git, ...configs] = await Promise.all([".git", ...CONFIG_NAMES].map((n) => $.fs.exists(base + n)));
    found = configs.some(Boolean);
    if (git) break; // repository or worktree root: never search above it
  }
  if (!found) return; // the project does not use dprint: nothing to warn about, nothing spawned
  const problem = await dprintProblem($, st);
  if (problem === null) return; // before the dedupe, so a dir whose probe succeeds never takes a slot
  if (recentlyShown()) return; // a concurrent event may have toasted while the probe ran
  st.shownAt = Date.now();
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
export async function resultingCwd($: Engine, e: unknown, r: unknown): Promise<string> {
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
 * `session.start` and `EnterWorktree`/`ExitWorktree` hook body: run the event, then check the resulting cwd detached.
 *
 * @param $ - Engine interface.
 * @param st - The entry's state.
 * @param e - Event, passed on unchanged.
 * @param next - Continues the hook chain.
 * @returns `next`'s result, unchanged.
 */
export async function afterSessionCwd($: Engine, st: NoticeState, e: unknown, next: Next): Promise<unknown> {
  const r = await next(e);
  // resultingCwd is async, so even a synchronous engine throw inside it lands in .catch
  void resultingCwd($, e, r).then((dir) => warnIfNoDprint($, st, dir)).catch(() => {});
  return r;
}

/**
 * `classic.CwdChanged` hook body: run the event, then check the event's `new_cwd` detached.
 *
 * @param $ - Engine interface.
 * @param st - The entry's state.
 * @param e - CwdChanged event (`new_cwd`), passed on unchanged.
 * @param next - Continues the hook chain.
 * @returns `next`'s result, unchanged.
 */
export async function afterCwdChanged($: Engine, st: NoticeState, e: unknown, next: Next): Promise<unknown> {
  const r = await next(e);
  void warnIfNoDprint($, st, (e as { new_cwd?: string } | null | undefined)?.new_cwd ?? "").catch(() => {});
  return r;
}
