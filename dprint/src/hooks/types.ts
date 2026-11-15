/**
 * Structural types of the function-hooks module: the engine members it uses (the engine's declaration file is not in
 * the repo) and the state one `register()` call owns.
 *
 * @packageDocumentation
 */

/** Why one dprint is not usable: `kind` drives the caller's logic, `text` goes into the toast. */
export type Problem = {
  /** Spawn rejected (cannot start or timeout), non-zero exit, no version in the output, or below the minimum version. */
  kind: "start" | "exit" | "output" | "old";
  /** The reason as the toast shows it. */
  text: string;
};

/** One dprint probe, in flight or settled. */
export type Probe = {
  /** Why the dprint `findDprint` would pick is not usable, `null` when it is. */
  problem: Promise<string | null>;
  /** When the probe resolved with a problem or rejected (`Date.now()`); unset while in flight and after a success. */
  failedAt?: number;
};

/** What one `register()` call remembers between events (never module-level: the test kit reloads only the entry). */
export type NoticeState = {
  /** When the last toast was shown (`Date.now()`); the cause is machine-wide, so one toast per toast window covers every directory. */
  shownAt: number | undefined;
  /** The latest dprint probe; a success is kept for the life of the module, a failure for the retry window. */
  probe: Probe | null;
  /** Set once a probe succeeded: from then on no event walks the filesystem, as no toast can follow. */
  dprintRuns: boolean;
};

/** The part of the engine interface `$` this module uses. */
export type Engine = {
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
export type Next = (e: unknown) => Promise<unknown>;

/** A function hook. */
export type Hook = ($: Engine, e: unknown, next: Next) => Promise<unknown>;

/** The `on` the engine passes to `register`. */
export type On = {
  /** Hook an event. */
  (event: string, hook: Hook): void;
  /** Hook an event filtered by a matcher. */
  (event: string, matcher: { tool: string }, hook: Hook): void;
};

/** Where a worktree tool reports the directory it moved to. */
export type WorktreeResult = { worktreePath?: string; restoredCwd?: string } | null | undefined;
