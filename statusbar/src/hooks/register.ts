/**
 * Claude Code function-hooks module of statusbar: every hook and every `$` use. It keeps the line of the user's
 * `statusline-command.sh` current: `refresh` recomputes it at `session.start`, every `turn.complete`, every
 * `session.measure` and every 10 s, and the StatusLine render hook hands it to the site in place of the status line
 * command's output.
 *
 * @remarks
 * EARLY ACCESS API. No engine type import: the used `$` members and events are typed structurally below. The pure
 * formatter and git lookup live in `line.ts`, inlined into `plugin/hooks/register.js` by the build. The render hook
 * makes no `$` call; `$.fs` is handed to `gitBranch` as closures (the engine rejects a bare `$.<noun>` value).
 *
 * @packageDocumentation
 */
import { gitBranch, type GitFs, statusLine } from "./line.js";

/** One entry of `$.session.usage().rateLimits`. */
type RateLimit = {
  /** The window: `five_hour`, `seven_day`, ... */
  kind: string;
  /** How much of it is used, 0-100. */
  percentUsed: number;
};
/** What `$.session.usage()` resolves. */
type Usage = {
  /** The context fill. */
  context: {
    /** Tokens in the context. */
    tokens?: number;
    /** The context window size. */
    window?: number;
    /** The fill, 0-100; may be missing while tokens and window are known. */
    percent?: number;
  };
  /** The account's rate-limit windows; absent when Claude Code has none. */
  rateLimits?: readonly RateLimit[];
};
/** The part of the engine interface `$` this module uses. */
type Engine = {
  /** The session's directory and usage. */
  session: {
    /** The session's working directory. */
    cwd(): Promise<string>;
    /** Context fill and rate limits (an in-memory read). */
    usage(): Promise<Usage>;
  };
  /** Filesystem reads for the git lookup. */
  fs: GitFs;
  /** Time. */
  clock: {
    /** Calls `fn` every `ms` until cancelled; the engine does not wait for `fn`, so a slow call overlaps the next. */
    every(ms: number, fn: () => void): { cancel(): void };
  };
  /** User interface. */
  ui: {
    /** Redraws the render sites of an event. */
    invalidate(event: "ui.render"): void;
  };
};
/** A `ui.render` event of the StatusLine site; `props.text` is the status line command's output. */
type RenderEvent = { props: { text?: string } & Record<string, unknown> };
/** Continues the hook chain with an event. */
type Next<E, R> = (e: E) => Promise<R>;
/** A function hook taking event `E` and resolving `R`. */
type Hook<E, R> = ($: Engine, e: E, next: Next<E, R>) => Promise<R>;
/** The `on` the engine passes to `register`, one overload per hooked event. */
type On = {
  /** Arms the timer and draws the first line. */
  (event: "session.start", hook: Hook<unknown, unknown>): void;
  /** Redraws after every completed turn (main or subagent). */
  (event: "turn.complete", hook: Hook<unknown, unknown>): void;
  /** Redraws whenever the engine measures the session. */
  (event: "session.measure", hook: Hook<unknown, unknown>): void;
  /** Substitutes the StatusLine site's text. */
  (event: "ui.render", matcher: { component: "StatusLine" }, hook: ($: Engine, e: RenderEvent, next: (e: RenderEvent) => unknown) => unknown): void;
};

/** The line last handed to the StatusLine site; undefined until the first successful refresh. */
let shown: string | undefined;
/** This session's 10 s refresh timer. */
let timer: { cancel(): void } | undefined;
/** A refresh is running; an overlapping trigger returns at once (`$.clock.every` does not wait for its callback). */
let busy = false;

/**
 * Recomputes the line from the cwd, the git HEAD and the usage, and redraws the StatusLine site when it changed.
 * Never throws: a failure keeps the last line and the next trigger retries.
 *
 * @param $ - Engine interface.
 */
async function refresh($: Engine): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const [cwd, u] = await Promise.all([$.session.cwd(), $.session.usage()]);
    const git = await gitBranch(cwd, { exists: (path) => $.fs.exists(path), read: (path) => $.fs.read(path) });
    const c = u.context;
    const context = c.percent || (c.window ? ((c.tokens ?? 0) / c.window) * 100 : undefined);
    const used = (kind: string): number | undefined => u.rateLimits?.find((r) => r.kind === kind)?.percentUsed;
    const line = statusLine({ cwd, isGit: git.isGit, branch: git.branch, context, fiveHour: used("five_hour"), sevenDay: used("seven_day") });
    if (line !== shown) {
      shown = line;
      $.ui.invalidate("ui.render");
    }
  } catch {
    // keep the last line; the next trigger retries
  } finally {
    busy = false;
  }
}

/**
 * The `turn.complete` and `session.measure` hook: redraws after the chain ran. `refresh` is the catch for every `$`
 * call after `next`: it never throws.
 *
 * @param $ - Engine interface.
 * @param e - The event.
 * @param next - Continues the hook chain.
 * @returns The chain's result.
 */
const redraw: Hook<unknown, unknown> = async ($, e, next) => {
  const r = await next(e);
  await refresh($);
  return r;
};

/**
 * Registers the module's hooks.
 *
 * @param on - The engine's hook registration.
 */
export const register = (on: On): void => {
  on("session.start", async function sessionStart($, e, next) {
    const r = await next(e);
    try {
      timer?.cancel();
      timer = $.clock.every(10_000, () => void refresh($));
    } catch {
      // the hook never throws after next; the next trigger redraws
    }
    await refresh($);
    return r;
  });
  on("turn.complete", redraw);
  on("session.measure", redraw);
  on("ui.render", { component: "StatusLine" }, function render($, e, next) {
    return shown === undefined ? next(e) : next({ ...e, props: { ...e.props, text: shown } });
  });
};
