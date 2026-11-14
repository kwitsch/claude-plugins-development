/**
 * Claude Code function-hooks module: a toast at session start when the graphmind binary is missing.
 *
 * @remarks
 * Without the binary every other function of the plugin (hooks, MCP wrapper) is inert by itself; this module only
 * tells the user why. The binary is looked up as the setup scripts do: the first `graphmind` on PATH, else
 * `~/.graphmind/bin`, `~/.local/bin`, `/usr/local/bin`. No imports (hooks modules run without Node), so the used
 * engine members are typed structurally.
 *
 * @packageDocumentation
 */

/** How long the toast stays, in ms. */
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
  /** Environment of the Claude Code process. */
  env: {
    /** Value of the variable, `undefined` when unset. */
    get(name: string): Promise<string | undefined>;
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
};

/**
 * Whether a graphmind binary exists where the hooks look for it.
 *
 * @remarks
 * The directory list is a copy of `findGraphmind` in `src/bin/common.mts` (this module may not import); keep both in step.
 *
 * @param $ - Engine interface.
 * @returns True when found.
 */
async function hasGraphmind($: Engine): Promise<boolean> {
  const [home, pathVar] = await Promise.all([$.env.get("HOME"), $.env.get("PATH")]);
  const dirs = (pathVar ?? "").split(":").filter((d) => d.startsWith("/"));
  if (home) dirs.push(`${home}/.graphmind/bin`, `${home}/.local/bin`);
  dirs.push("/usr/local/bin");
  const found = await Promise.all(dirs.map((d) => $.fs.exists(`${d.replace(/\/+$/, "")}/graphmind`)));
  return found.some(Boolean);
}

/**
 * `session.start` hook: run the event, then check for the binary detached; a missing one toasts.
 *
 * @param $ - Engine interface.
 * @param e - Event, passed on unchanged.
 * @param next - Continues the hook chain.
 * @returns `next`'s result, unchanged.
 */
async function onSessionStart($: Engine, e: unknown, next: Next): Promise<unknown> {
  const r = await next(e);
  void hasGraphmind($).then((found) => {
    if (!found) $.ui.toast("graphmind-helper: the graphmind binary was not found (PATH, ~/.graphmind/bin, ~/.local/bin); the plugin's hooks and MCP server stay off until it is installed (https://github.com/aouicher/graphmind)", { timeoutMs: TOAST_MS });
  }).catch(() => {});
  return r;
}

/**
 * Module entry point called by the engine.
 *
 * @param on - Registers a hook for an event.
 */
export const register = (on: On): void => {
  on("session.start", onSessionStart);
};
