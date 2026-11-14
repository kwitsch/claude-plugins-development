#!/usr/bin/env node
/**
 * universal-lint plugin: lint-only checker for Write/Edit results and files changed outside them.
 *
 * @remarks
 * Command hook, invoked directly per event (no MCP server). stdin = hook JSON (PostToolUseHookInput); `main()`
 * dispatches on `hook_event_name`: SessionStart/CwdChanged print the git watch list as `watchPaths` (stdout JSON,
 * exit 0); FileChanged lints a watched file changed outside Write/Edit (unlink, scope, digest and git gates, then a
 * cross-process slot);
 * anything else is PostToolUse Write|Edit (digest recorded, then lint). `asyncRewake: true` in hooks.json for
 * PostToolUse and FileChanged: runs in the background (safe because linting never mutates the file); findings go to
 * stderr with exit 2, which wakes Claude with them; no finding = no output, exit 0.
 *
 * lint flow (every failure path returns `{}` silently, fail open): guard `tool_response.success !== false`, then
 * `scopedTarget` (real path strictly inside the real cwd, not excluded: node_modules/vendor/.git, .claude/worktrees,
 * .claude/agent-memory, *.local.*, see `isExcludedPath`; not inside `scratchpad_dir`; no dangling link; lintable
 * extension; file exists). Then up to two INDEPENDENT checks run, at once unless an oxlint `typeCheck` config makes
 * tsc depend on the chain outcome (see `lintResolved`), and their findings combine: the language's chain
 * tool (first on PATH wins, else a project-local `node_modules/.bin`, else npx, see `selectLintTool`; no per-file skip, since no style mapping exists for linters; JS/TS runs one only when an
 * eslint or oxlint config exists, and CSS/SCSS only when a stylelint config exists, see `lintResolved`) through `spawnGroup` (own
 * process group, 30 s timeout, group killed on timeout, stdout+stderr captured), classified by exit code for most tools (checkstyle by stripped
 * output, since its exit code counts only ERROR-severity violations and the bundled default ruleset runs at
 * `warning`); and, for .ts/.tsx/.mts/.cts only, a whole-project `tsc --noEmit` via the nearest tsconfig.json (see
 * `runTypeCheck`). Any issues found: truncated, joined text (stderr, exit 2, chain finding first); no finding from either check: nothing
 * printed.
 *
 * @packageDocumentation
 */
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess, SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import type { Hash } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism, homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { json } from "node:stream/consumers";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/**
 * `node:crypto`'s `createHash`, loading the module on first use (`process.getBuiltinModule`, synchronous) so events that never
 * hash (out-of-scope Write/Edit, FileChanged `unlink`, SessionStart/CwdChanged) skip its load, about 7 ms per spawn (F26).
 * `process.getBuiltinModule` (Node >= 22.3 / 20.16) is preferred; older Node falls back to `createRequire(import.meta.url)("node:crypto")`,
 * so the floor stays 18.14 (`os.availableParallelism`); the `node:module` import was measured at 0 ms (already resident in the ESM loader).
 *
 * @param algorithm - Hash algorithm name (`sha256`, `sha512`).
 * @returns A fresh hash object.
 */
function createHash(algorithm: string): Hash {
  return (process.getBuiltinModule?.("node:crypto") ?? (createRequire(import.meta.url)("node:crypto") as typeof import("node:crypto"))).createHash(algorithm);
}

/** Inner linter timeout: kills the child's whole process group (SIGTERM, SIGKILL after `KILL_GRACE_MS`); the hook-level timeout (hooks.json timeout: 90 = the lint budget) is the backstop. */
const SPAWN_TIMEOUT_MS = 30000;

/**
 * Budget of every npx-route spawn: bare `npx --yes` (a cold install can exceed SPAWN_TIMEOUT_MS) and the npx-cached
 * bin `runNpx` runs directly. One spawn ends within 56 s with `KILL_GRACE_MS`, inside the hooks.json timeout 90, but
 * it is not in the FileChanged reservation (`FILE_CHANGED_BUDGET_MS`): the sequential oxlint-`typeCheck` fallback
 * (55 + 45 + 2 s) or a late-slotted npx-route FileChanged lint can pass 90 s and is lost (hook-design.md "Timeout
 * budget", Accepted). A timeout kills the child's whole process group (SIGTERM, SIGKILL after `KILL_GRACE_MS`).
 */
const NPX_SPAWN_TIMEOUT_MS = 55000;

/**
 * How long a package in npx's cache runs directly (runNpx) before one lint goes through `npx --yes` again: npx (npm
 * 11.19.1) checks a name-only spec against the registry's `latest` on every call and upgrades its cache, the direct
 * route never does.
 */
const NPX_REFRESH_MS = 24 * 60 * 60 * 1000;

/** How long a negative onPath answer persisted in the probe file stays valid: a linter installed later is found within this window. */
const PROBE_MISS_TTL_MS = 10 * 60 * 1000;

/** Cap on the additionalContext findings text. */
const MAX_CONTEXT_CHARS = 4000;

/** Per-stream output cap of `spawnGroup` (spawnSync's 1MB default truncated a noisy linter's output as ENOBUFS). */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * Full-project incremental type-check: slower than a single-file/dir tool (SPAWN_TIMEOUT_MS) but not a cold registry
 * install (NPX_SPAWN_TIMEOUT_MS); kept its own, smaller budget so a stale async finding (this hook is async:true)
 * doesn't arrive too late to be useful. A timeout kills the child's whole process group (SIGTERM, SIGKILL after
 * `KILL_GRACE_MS`). Runs at once with the chain unless an oxlint `typeCheck` config exists (`lintResolved`).
 */
const TSC_SPAWN_TIMEOUT_MS = 45000;

/**
 * cargo check/clippy compile the crate; slower than a single-file/dir tool (SPAWN_TIMEOUT_MS), same budget rationale
 * as TSC_SPAWN_TIMEOUT_MS; stays under the hook-level timeout backstop. A timeout kills the child's whole process
 * group (SIGTERM, SIGKILL after `KILL_GRACE_MS`): rustc/clippy-driver grandchildren die with cargo.
 */
const CARGO_SPAWN_TIMEOUT_MS = 45000;

/** SIGKILL follows the timeout's SIGTERM to the process group after this long (a child trapping SIGTERM must still die). */
const KILL_GRACE_MS = 1000;

/**
 * Most files per chain-tool spawn in `lintFilesHandler` (the skill driver's batch path). Caps the argv length (sized
 * for Linux/macOS ARG_MAX; no length-based chunking) and keeps one batch inside its unchanged per-spawn timeout:
 * 10 .md batched measured 143 ms, so 100 files stay far below `SPAWN_TIMEOUT_MS`. Also bounds the single-file reruns
 * of a chunk whose batch run was a skip verdict, spawn error, signal or timeout.
 */
const BATCH_MAX_FILES = 100;

/** Above this many lintable files the watch list is empty (nothing watched), as dprint's watch-list.mts. */
export const WATCH_LIMIT = 5000;

/** Budget of each git call (ls-files for the watch list, status for the FileChanged gate). */
const GIT_TIMEOUT_MS = 10000;

/**
 * hooks.json `timeout` of PostToolUse and FileChanged (90 s), the backstop that kills a hook process; a slot file whose
 * mtime is this far from now (past or future) was left by a killed holder or survived a clock jump. Re-derive with
 * hook-design.md "Timeout budget" when hooks.json changes.
 */
const HOOK_TIMEOUT_MS = 90000;

/**
 * FileChanged nominal worst case (85 s): git status + slot wait + lint end by then; the 5 s under `HOOK_TIMEOUT_MS`
 * cover node startup before `process.uptime()` counts, the findings gate and the exit. The per-file lint budget
 * `fileChangedHandler` reserves before waiting mirrors `runChainLint`'s one spawn timeout per tool
 * (`CARGO_SPAWN_TIMEOUT_MS` for a `manifestPath` tool, else `SPAWN_TIMEOUT_MS`) and `runTypeCheck`'s
 * `TSC_SPAWN_TIMEOUT_MS`; update it together with them (a chain that runs a second tool per file needs a larger
 * reservation). The reservation stays the sum chain + tsc although the phases overlap since F18, because the
 * oxlint-`typeCheck` fallback path runs them in sequence. `coalesceProjectCheck` (F13) stops waiting for a project-check
 * lock at uptime `FILE_CHANGED_BUDGET_MS` minus the check's spawn timeout and then runs unlocked, so the lock wait
 * stays inside this budget. Worst end = max(slot deadline + sequential phases, lock-wait deadline + check timeout)
 * + `KILL_GRACE_MS` per phase: 40 + 45 + 1 = 86 s (`.ts` concurrent, `.rs`), 55 + 30 + 1 = 86 s (`.go`), 10 + 30 + 1
 * + 45 + 1 = 87 s (`.ts` fallback), all inside the 5 s margin under `HOOK_TIMEOUT_MS`.
 */
const FILE_CHANGED_BUDGET_MS = HOOK_TIMEOUT_MS - 5000;

/**
 * Concurrent FileChanged lints across all hook processes sharing one plugin data dir (3 on 12 cores, at least 2).
 * Exported for the tests.
 */
export const FILE_CHANGED_SLOTS = Math.max(2, Math.floor(availableParallelism() / 4));

/** tsc only understands real TypeScript syntax; .js/.jsx/.mjs/.cjs get only the chain lint (eslint or oxlint, see lintResolved), none without a lint config. */
const TYPE_CHECK_EXTS = new Set([".ts", ".tsx", ".mts", ".cts"]);

/** One linter in a language's chain. */
interface LintTool {
  /** Binary name: probed on PATH, and spawned unless `spawnAs` is set. */
  name: string;
  /** Static arguments placed before the target. */
  args: string[];
  /** Lint the edited file's directory (package) instead of the file. */
  targetsDir?: boolean;
  /** Take no positional target: emit `--manifest-path <nearest Cargo.toml>` instead. */
  manifestPath?: boolean;
  /** Classify by stdout (`classifyCheckstyleOutput`) instead of the exit code. */
  classify?: "output";
  /** Pass `-c <resolved checkstyle config>`. */
  needsCheckstyleConfig?: boolean;
  /** Disable yamllint's line-length rule when the project has no yamllint config. */
  guardYamlLineLength?: boolean;
  /** Disable markdownlint's MD013 when the project has no markdownlint config. */
  guardMarkdownLineLength?: boolean;
  /**
   * npm package to run via npx (its npx-cached bin directly when npx would run that, `runNpx`) when the binary is
   * absent from PATH. Its presence also opts the tool into the project-local `node_modules/.bin/<name>` lookup
   * (`selectLintTool`), which runs before npx.
   */
  npmSpec?: string;
  /** Binary and leading arguments actually spawned, when they differ from the probed `name`. */
  spawnAs?: { name: string; args: string[] };
}

/** A language's lint chain. */
interface LangEntry {
  /** Tools in preference order; the first one on PATH wins. */
  chain: LintTool[];
}

/** One tool's issues, ready to be rendered into the hook's additionalContext. */
export interface Finding {
  /** Name of the tool that reported. */
  tool: string;
  /** What was checked, relative to the project root. */
  target: string;
  /** The tool's raw findings text. */
  text: string;
  /** Absolute directory the tool's relative paths are resolved against. */
  base: string;
}

/** The subset of Claude Code's hook payloads this module reads (PostToolUse, FileChanged, SessionStart, CwdChanged). */
interface PostToolUseHookInput {
  /** Project root the session runs in. */
  cwd: string;
  /** Hook event (`PostToolUse`, `FileChanged`, `SessionStart`, `CwdChanged`); missing in older payloads (treated as PostToolUse). */
  hook_event_name?: unknown;
  /** The session scratchpad directory; files inside it are out of scope. */
  scratchpad_dir?: unknown;
  /** FileChanged: the changed file. */
  file_path?: unknown;
  /** FileChanged: `"change"`, `"add"` or `"unlink"`. */
  event?: unknown;
  /** CwdChanged: the new working directory. */
  new_cwd?: unknown;
  /** Name of the tool that fired the hook (`Write` or `Edit`). */
  tool_name?: unknown;
  /** The tool's input; `file_path` names the written file. Absent for non-tool events. */
  tool_input?: { file_path?: unknown };
  /** The tool's result; `success: false` marks a failed Write/Edit, `structuredPatch` holds the Edit tool's diff hunks. */
  tool_response?: { success?: boolean; structuredPatch?: unknown };
  [key: string]: unknown;
}

/** The hook's stdout JSON, empty when there is nothing to report. */
interface HookResult {
  /** Findings, delivered to Claude as context on the next turn. */
  hookSpecificOutput?: { hookEventName: string; additionalContext: string };
}

/**
 * Lowercased file extension (incl. leading dot) -> language key. A subset of the universal-format plugin's EXT_MAP:
 * .json is deliberately excluded here, no exit-code-clean standalone JSON linter exists (see
 * `.claude/rules/languages.md`, "JSON: not covered").
 */
const EXT_MAP: Record<string, string> = {
  ".sh": "shell",
  ".bash": "shell",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".js": "jsts",
  ".jsx": "jsts",
  ".mjs": "jsts",
  ".cjs": "jsts",
  ".ts": "jsts",
  ".tsx": "jsts",
  ".mts": "jsts",
  ".cts": "jsts",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".md": "markdown",
  ".css": "css",
  ".scss": "css",
  ".php": "php",
  ".rs": "rust",
};

/**
 * Linter registry. chain = `selectLintTool` order: first tool on PATH, else first npm tool (`npmSpec`) with a
 * project-local `node_modules/.bin`, else first npm tool via npx. Every entry runs check-only --
 * never --fix/--format/--write. Go entries target the edited file's DIRECTORY
 * (package), not the bare file: go vet/golangci-lint operate on packages, and a
 * lone file referencing sibling-file symbols would otherwise fail with spurious
 * "undefined: X" compile-context errors. checkstyle is classified by stdout, not
 * exit code (see classifyCheckstyleOutput) -- its exit code counts only
 * ERROR-severity violations, and the bundled default ruleset runs at `warning`.
 */
export const REGISTRY: Record<string, LangEntry> = {
  shell: { chain: [{ name: "shellcheck", args: [] }] },
  java: {
    chain: [
      {
        name: "checkstyle",
        args: [],
        classify: "output",
        needsCheckstyleConfig: true,
      },
    ],
  },
  kotlin: { chain: [{ name: "ktlint", args: [] }] },
  jsts: { chain: [{ name: "eslint", args: [], npmSpec: "eslint" }] },
  // Alternate jsts chain, picked by resolveOxlintConfig (not in EXT_MAP).
  // --no-error-on-unmatched-pattern: a file excluded by the project's oxlint
  // ignorePatterns otherwise exits 1 ("No files found to lint") -> false finding.
  oxlint: { chain: [{ name: "oxlint", args: ["--no-error-on-unmatched-pattern"], npmSpec: "oxlint" }] },
  python: { chain: [{ name: "ruff", args: ["check"] }] },
  go: {
    chain: [
      { name: "golangci-lint", args: ["run"], targetsDir: true },
      { name: "go", args: ["vet"], targetsDir: true },
    ],
  },
  yaml: {
    chain: [{ name: "yamllint", args: [], guardYamlLineLength: true }],
  },
  markdown: {
    chain: [
      {
        name: "markdownlint-cli2",
        args: ["--no-globs"], // a project config's top-level `globs` would lint the whole repo per edit; cli2 only (classic markdownlint has no such option)
        npmSpec: "markdownlint-cli2",
        guardMarkdownLineLength: true,
      },
      {
        name: "markdownlint",
        args: [],
        npmSpec: "markdownlint-cli",
        guardMarkdownLineLength: true,
      },
    ],
  },
  css: { chain: [{ name: "stylelint", args: [], npmSpec: "stylelint" }] },
  php: {
    chain: [
      { name: "phpstan", args: ["analyse"] },
      { name: "psalm", args: [] },
    ],
  },
  rust: {
    chain: [
      // name/onPath gates on the standalone cargo-clippy driver binary --
      // its presence on PATH is how the clippy rustup component is detected
      // (see `.claude/rules/languages.md`, "Rust"). But
      // that bare binary does NOT accept --manifest-path (it belongs to
      // cargo/its clippy subcommand, not the driver clippy-driver itself
      // invokes) -- spawnAs runs the actually-selected tool as `cargo
      // clippy` instead, so buildArgv's --manifest-path lands on a command
      // that understands it. onPath/selectLintTool still probe `name`
      // unchanged.
      { name: "cargo-clippy", args: ["--", "-D", "warnings"], manifestPath: true, spawnAs: { name: "cargo", args: ["clippy"] } },
      { name: "cargo", args: ["check"], manifestPath: true },
    ],
  },
};

/** onPath answers persisted per PATH string: tool name -> directory it was found in, or -> Date.now() of the miss. */
type ProbeStore = { hits: Record<string, string>; misses: Record<string, number> };

/** Per-process memo of onPath answers (each hook event is its own process; the cross-process copy is the probe file). */
const probeCache = new Map<string, boolean>();

/** Probe store for the current PATH, loaded by the first onPath call of the process; null until then. */
let probeStore: ProbeStore | null = null;

/**
 * Absolute path of the probe file for the current PATH: `${CLAUDE_PLUGIN_DATA || os.tmpdir()}/probe-<hashPath(PATH)>.json`.
 * Never inside the project tree; both env values are constant within a hook process.
 *
 * @returns Absolute path of the probe file.
 */
function probeFilePath(): string {
  return path.resolve(process.env.CLAUDE_PLUGIN_DATA || tmpdir(), `probe-${hashPath(process.env.PATH || "")}.json`);
}

/**
 * Read and shape-check the probe file; any read, parse or shape failure returns an empty store (probe again).
 * Single entries are type-checked at lookup in onPath, so a bad entry costs one probe and is overwritten.
 *
 * @param file - Probe file path (`probeFilePath()`).
 * @returns The stored answers, or an empty store.
 */
function loadProbeStore(file: string): ProbeStore {
  const isObject = (v: unknown): boolean => typeof v === "object" && v !== null && !Array.isArray(v);
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as { hits?: unknown; misses?: unknown } | null;
    if (isObject(s) && isObject(s?.hits) && isObject(s?.misses)) return s as ProbeStore;
  } catch {
    // unreadable or not JSON: probe again
  }
  return { hits: {}, misses: {} };
}

/**
 * Write the store atomically (temp file + renameSync); errors are swallowed (cost: the next process probes again).
 * No locking: the last writer wins.
 *
 * @param file - Probe file path (`probeFilePath()`).
 * @param store - Store to persist.
 */
function saveProbeStore(file: string, store: ProbeStore): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(store));
    renameSync(tmp, file);
  } catch {
    // fail open: an unwritable data dir means the next process probes again
  }
}

/**
 * Whether a tool is executable on PATH (memoized per process, persisted across processes in the probe file).
 *
 * @param tool - Binary name to look for.
 * @returns True when an executable of that name sits in a PATH directory.
 * @remarks A stored hit is re-validated with one `accessSync` on its directory; a stored miss is trusted while
 * `0 <= Date.now() - at < PROBE_MISS_TTL_MS` (a future-dated miss is expired); otherwise PATH is scanned and the
 * result written back. Residuals: (1) a newly installed tool is not seen for up to 10 min after a persisted miss,
 * also an earlier chain tool (a later chain tool, a local bin or npx runs meanwhile); (2) a copy added to an
 * earlier PATH dir is not noticed (presence only: the spawn is by bare name, so PATH's first binary runs); (3) a
 * tool reachable only through a relative PATH entry is cwd-dependent: never cached as a hit, and its miss is per
 * PATH string, not per cwd; (4) in the shared `os.tmpdir()` fallback another user with the same PATH string can
 * plant entries (a hit only for a tool executable in that dir, a miss suppresses that tool's lint for the TTL).
 */
function onPath(tool: string): boolean {
  const cached = probeCache.get(tool);
  if (cached !== undefined) return cached;
  const file = probeFilePath();
  probeStore ??= loadProbeStore(file);
  const known = probeStore.hits[tool];
  if (typeof known === "string" && path.isAbsolute(known)) {
    try {
      accessSync(path.join(known, tool), fsConstants.X_OK);
      probeCache.set(tool, true);
      return true;
    } catch {
      /* gone or no longer executable: probe PATH again */
    }
  }
  const at = probeStore.misses[tool];
  if (typeof at === "number") {
    const age = Date.now() - at;
    if (age >= 0 && age < PROBE_MISS_TTL_MS) {
      // a future-dated miss (clock jump, synced data dir) counts as expired
      probeCache.set(tool, false);
      return false;
    }
  }
  let foundDir: string | null = null;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      accessSync(path.join(dir, tool), fsConstants.X_OK);
      foundDir = dir;
      break;
    } catch {
      /* keep looking */
    }
  }
  // a hit through a relative PATH entry depends on the cwd: memoize it for this process only
  if (foundDir === null || path.isAbsolute(foundDir)) {
    Reflect.deleteProperty(probeStore.hits, tool);
    Reflect.deleteProperty(probeStore.misses, tool);
    if (foundDir === null) probeStore.misses[tool] = Date.now();
    else probeStore.hits[tool] = foundDir;
    saveProbeStore(file, probeStore);
  }
  const found = foundDir !== null;
  probeCache.set(tool, found);
  return found;
}

/**
 * A tool is available directly on PATH, or indirectly via `npx <npmSpec>` when
 * the registry declares npmSpec (a verified-official npm package only -- see
 * the REGISTRY comments) and npx itself is on PATH. Booleans are passed in
 * rather than calling onPath() internally so this stays a pure, unit-testable
 * function.
 *
 * @remarks
 * Models only the PATH-or-npx availability. It ignores the project-local
 * `node_modules/.bin` route, so it is not the production selection:
 * `selectLintTool` (PATH > local bin > npx) is.
 *
 * @param tool - Chain entry to check.
 * @param toolOnPath - Whether the tool binary is on PATH.
 * @param npxOnPath - Whether npx is on PATH.
 * @returns True when the tool can run directly or via npx.
 */
export function isToolAvailable(tool: LintTool, toolOnPath: boolean, npxOnPath: boolean): boolean {
  return toolOnPath || (!!tool.npmSpec && npxOnPath);
}

/** Signals on which the hook or driver kills its live linter groups before exiting (`installSignalHandler`). */
const GROUP_KILL_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];

/** Process-group ids (the leader's pid) of every `spawnGroup` child still running: added after spawn, removed on resolution. */
const liveGroups = new Set<number>();

/** Whether `installSignalHandler` already ran (one handler per process). */
let groupSignalHandlerInstalled = false;

/**
 * Send `sig` to the process group led by `pgid` (`process.kill(-pgid)`); ESRCH (the group is already gone) and any
 * other error are swallowed. POSIX only (the plugin's hook runs through a shebang `.mjs`, so Windows is unsupported).
 *
 * @param pgid - The group leader's pid.
 * @param sig - The signal to send.
 */
function killGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    // ESRCH: already gone
  }
}

/**
 * Install, once per process, one handler for SIGTERM, SIGINT and SIGHUP that SIGKILLs every live `spawnGroup` group
 * (the children are detached, so the signal that kills the hook or driver would not reach them), removes itself and
 * re-raises the signal on this process so the default exit still happens. Normal exit is unchanged. A SIGKILL of the
 * hook cannot be handled: its children die on EPIPE at their next write (tsc runs to its natural end).
 */
function installSignalHandler(): void {
  if (groupSignalHandlerInstalled) return;
  groupSignalHandlerInstalled = true;
  const onSignal = (sig: NodeJS.Signals): void => {
    for (const pgid of liveGroups) killGroup(pgid, "SIGKILL");
    liveGroups.clear();
    for (const s of GROUP_KILL_SIGNALS) process.removeListener(s, onSignal);
    process.kill(process.pid, sig);
  };
  for (const s of GROUP_KILL_SIGNALS) process.on(s, onSignal);
}

/**
 * Spawn `cmd` as the leader of its own process group (`detached: true`) and resolve with a `SpawnSyncReturns<string>`-
 * shaped result once the child's `close` event fires (both pipes closed, so every grandchild holding them has exited
 * too: a killed tree is reaped before the lint continues). Replaces every lint `spawnSync` call (F18).
 *
 * @remarks
 * `opts` are `buildSpawnOpts` options: `cwd` and `env` go to `spawn`; `stdio` stays `["ignore", "pipe", "pipe"]`, so
 * the child's stdin is `/dev/null` exactly as under spawnSync; `timeout`, `maxBuffer` and `encoding` are applied here
 * (never passed to `spawn`); never `shell`. At `opts.timeout` ms `error` becomes an `Error` with `code` `"ETIMEDOUT"`
 * (as spawnSync) and the group gets SIGTERM, then SIGKILL after `KILL_GRACE_MS`; a child trapping SIGTERM exits
 * normally within the grace (`signal` null, `status` set, `error.code` ETIMEDOUT) or is SIGKILLed (`signal`
 * `"SIGKILL"`). When one stream's bytes exceed `opts.maxBuffer` (`MAX_BUFFER_BYTES`) further chunks of it are
 * discarded, `error.code` is `"ENOBUFS"` and the group is killed with the same SIGTERM/SIGKILL sequence (spawnSync
 * semantics: per stream, child killed). A spawn failure (`error` event before `close`: ENOENT, EACCES) resolves with
 * that error, `status` and `signal` null and empty output; `spawnBin` reads its `code`. Both timers are cleared only
 * on resolution (`close` or that pre-spawn `error`), never on `exit`, so a group kill still reaches pipe-holding
 * grandchildren after the leader exited; the SIGKILL timer is a plain timer (no `unref`) and is always cleared. The
 * group's pid is held in `liveGroups` from spawn to resolution so `installSignalHandler`'s handler (installed on the
 * first call) can SIGKILL it when this process is signalled. The promise never rejects: every exceptional outcome is
 * in `error`. Residuals: a grandchild that called `setsid` leaves the group and, holding a pipe, delays `close` until
 * the hook backstop (same as spawnSync); the pid-reuse window between the leader's reap and `close` is microseconds
 * and needs a pid wraparound. Exported for the tests (the timeout argument is the test seam; no env override).
 *
 * @param cmd - Command (bare name resolved on `opts.env.PATH` or `process.env.PATH`, or an absolute path).
 * @param argv - Arguments.
 * @param opts - `buildSpawnOpts` options (`cwd`, `env`, `timeout`, `maxBuffer`).
 * @returns The spawnSync-shaped result: `pid`, `output: [null, stdout, stderr]`, `stdout`, `stderr`, `status`,
 *   `signal`, `error` (undefined when none).
 */
export function spawnGroup(cmd: string, argv: readonly string[], opts: SpawnSyncOptionsWithStringEncoding): Promise<SpawnSyncReturns<string>> {
  installSignalHandler();
  const maxBuffer = opts.maxBuffer ?? MAX_BUFFER_BYTES;
  const timeout = opts.timeout ?? SPAWN_TIMEOUT_MS;
  return new Promise((resolve) => {
    let error: Error | undefined;
    let done = false;
    let killTimer: NodeJS.Timeout | undefined;
    let child: ChildProcess;
    try {
      child = spawn(cmd, [...argv], { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
      resolve({ pid: 0, output: [null, "", ""] as unknown as string[], stdout: "", stderr: "", status: null, signal: null, error });
      return;
    }
    const pid = child.pid; // undefined when the spawn failed: never signalled
    if (pid !== undefined) liveGroups.add(pid);
    const kill = (): void => {
      if (pid === undefined || killTimer) return;
      killGroup(pid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(pid, "SIGKILL"), KILL_GRACE_MS);
    };
    const fail = (code: string): void => {
      error ??= Object.assign(new Error(`spawnGroup ${cmd}: ${code}`), { code });
      kill();
    };
    const timer = setTimeout(() => fail("ETIMEDOUT"), timeout);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    /** Collect one stream's chunks up to `maxBuffer`; past it, ENOBUFS once and discard the rest. */
    const collect = (chunks: Buffer[]): (chunk: Buffer) => void => {
      let total = 0;
      return (chunk) => {
        if (total > maxBuffer) return;
        total += chunk.length;
        if (total > maxBuffer) fail("ENOBUFS");
        else chunks.push(chunk);
      };
    };
    child.stdout?.on("data", collect(out));
    child.stderr?.on("data", collect(err));
    const finish = (status: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (pid !== undefined) liveGroups.delete(pid);
      resolve({ pid: pid ?? 0, output: [null, stdout, stderr] as unknown as string[], stdout, stderr, status, signal, error });
    };
    child.on("error", (e) => {
      error = e;
      finish(null, null, "", "");
    });
    child.on("close", (status, signal) => finish(status, signal, Buffer.concat(out).toString("utf8"), Buffer.concat(err).toString("utf8")));
  });
}

/**
 * Spawn a bin by absolute path with its directory first on the child's PATH, as npx does: oxlint finds tsgolint only
 * on PATH or in the spawn cwd's `node_modules/.bin`. Shared by the project-local route (`runLintTool`) and the
 * npx-cache route (`runNpx`).
 *
 * @param bin - Absolute path of the bin to spawn.
 * @param argv - Full argv from buildArgv.
 * @param spawnOpts - Options for spawnGroup (cwd and timeout kept as given; env gets the bin's directory first on PATH).
 * @returns The spawn result, or null when the bin could not spawn (error code ENOENT/EACCES: missing, dangling or
 *   not executable), so the caller falls through to its next route; any other outcome, a timeout too, is returned.
 */
async function spawnBin(bin: string, argv: string[], spawnOpts: SpawnSyncOptionsWithStringEncoding): Promise<SpawnSyncReturns<string> | null> {
  // Bin dir first on PATH, as npx does: oxlint finds tsgolint only on PATH or in the spawn cwd's node_modules/.bin.
  const PATH = process.env.PATH ? path.dirname(bin) + path.delimiter + process.env.PATH : path.dirname(bin);
  const result = await spawnGroup(bin, argv, { ...spawnOpts, env: { ...process.env, PATH } });
  // Spawn failure (ENOENT/EACCES) lets the caller fall back; a timeout keeps its result (no second budget). The code is
  // checked, not `signal`: a child that traps SIGTERM exits normally, so ETIMEDOUT arrives with signal null.
  const code = result.error && "code" in result.error ? result.error.code : undefined;
  return code === "ENOENT" || code === "EACCES" ? null : result;
}

/**
 * Run an npm-distributed chain tool that is absent from PATH: npx's own cached bin directly when npx would run it,
 * else `npx --yes <npmSpec> ...argv` with its own, longer timeout (`NPX_SPAWN_TIMEOUT_MS`: a cold install can exceed
 * the chain budget).
 *
 * @remarks
 * The cached bin is `<cache>/_npx/<sha512(npmSpec) hex[0:16]>/node_modules/.bin/<name>` with `<cache>` =
 * `npm_config_cache || NPM_CONFIG_CACHE || ~/.npm` (npm 7+ `libnpmexec` layout, verified on npm 11.19.1), spawned
 * through `spawnBin` with `spawnOpts` unchanged (npx's cwd, npx's budget NPX_SPAWN_TIMEOUT_MS); ENOENT/EACCES falls through to npx, any
 * other result (a timeout too) is returned. The cache route is skipped and plain npx runs, as in 0.15.7, when (1) a
 * `node_modules/.bin/<name>` exists from the spawn cwd up to `/` (npx runs that one before its cache; F04 user
 * decision), (2) npx holds `<dir>/concurrency.lock` (an install is in progress), or (3) the refresh stamp
 * `${CLAUDE_PLUGIN_DATA || os.tmpdir()}/npx-refreshed-<key>` is missing, older than `NPX_REFRESH_MS` or dated in the future. Every npx run
 * that spawned (no `error`, any exit status) renews the stamp (errors swallowed), except in
 * case (1), whose npx run never touches the cache. The hook only reads the npm cache, never writes it.
 * Only the bare `npx --yes` spawn carries `npm_config_update_notifier`, `npm_config_fund` and `npm_config_audit` = `false`
 * (F24): npm's notice lines would otherwise land in the finding text. No `npm_config_loglevel` is set, so install
 * errors still reach stderr.
 *
 * @param name - Bin name of the chain entry (`LintTool.name`).
 * @param npmSpec - npm package of the chain entry (`LintTool.npmSpec`); also the cache key's input.
 * @param argv - Full argv from buildArgv.
 * @param spawnOpts - Options for spawnGroup; its cwd is npx's cwd and the cached bin's.
 * @returns The spawn result of the cached bin or of npx.
 */
async function runNpx(name: string, npmSpec: string, argv: string[], spawnOpts: SpawnSyncOptionsWithStringEncoding): Promise<SpawnSyncReturns<string>> {
  /**
   * Run `npx --yes <npmSpec> ...argv` with `spawnOpts`, the longer `NPX_SPAWN_TIMEOUT_MS` budget and npm's
   * update-notifier, fund and audit messages switched off through `npm_config_*` env vars (F24).
   *
   * @returns The spawn result of npx.
   */
  const npx = (): Promise<SpawnSyncReturns<string>> =>
    spawnGroup("npx", ["--yes", npmSpec, ...argv], {
      ...spawnOpts,
      timeout: NPX_SPAWN_TIMEOUT_MS,
      env: { ...(spawnOpts.env ?? process.env), npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" },
    });
  // npx runs a node_modules/.bin/<name> from its cwd up to / before its cache (npm 11.19.1 localFileExists): leave that to npx.
  const rel = path.join("node_modules", ".bin", name);
  if (walkToRoot(String(spawnOpts.cwd), (d) => configExists(d, rel))) return npx();
  // libnpmexec's cache key: sha512 hex of the sorted, newline-joined spec list, first 16 chars (one bare spec hashes as itself).
  const key = createHash("sha512").update(npmSpec).digest("hex").slice(0, 16);
  const dir = path.join(process.env.npm_config_cache || process.env.NPM_CONFIG_CACHE || path.join(homedir(), ".npm"), "_npx", key);
  const stamp = path.resolve(process.env.CLAUDE_PLUGIN_DATA || tmpdir(), `npx-refreshed-${key}`);
  let fresh = false;
  try {
    const age = Date.now() - lstatSync(stamp).mtimeMs;
    fresh = age >= 0 && age < NPX_REFRESH_MS; // a future mtime (clock jump, synced data dir) must not stay fresh
  } catch {
    /* no stamp yet: one npx run checks the registry first */
  }
  // An npx install in progress holds concurrency.lock; a half-replaced tree could crash with exit 1, a false finding.
  if (fresh && !existsSync(path.join(dir, "concurrency.lock"))) {
    const cached = await spawnBin(path.join(dir, rel), argv, { ...spawnOpts, timeout: NPX_SPAWN_TIMEOUT_MS });
    if (cached) return cached;
  }
  const result = await npx();
  if (!result.error) {
    try {
      mkdirSync(path.dirname(stamp), { recursive: true });
      writeFileSync(stamp, "");
    } catch {
      /* unwritable data dir: the next lint goes through npx again */
    }
  }
  return result;
}

/**
 * Run the resolved lint tool through the fall-through chain local bin -> npx-cache bin -> npx: the project-local bin
 * `local` when given (`spawnBin`; spawnOpts carries its package root as cwd, its directory goes first on the child's
 * PATH, chain budget), then, for an npm-distributed tool absent from PATH, `runNpx` (npx's cached bin directly when
 * npx would run it, else `npx --yes <npmSpec>` with its own, longer timeout, since a cold install can exceed the
 * local-binary budget), else spawn it directly (`spawnAs` when set). A bin that cannot spawn (error code
 * ENOENT/EACCES) falls through to the next route; any other outcome (including a timeout) is returned as is.
 *
 * @remarks
 * After a local-bin ENOENT/EACCES fall-through, `runNpx` runs without `selectLintTool`'s npx-on-PATH gate: a cached
 * bin still runs, and a miss then fails to spawn npx (ENOENT), which `runChainLint` treats as no finding (fail open).
 * No `onPath("npx")` guard on purpose.
 *
 * @param tool - The selected chain entry.
 * @param argv - Full argv from buildArgv.
 * @param spawnOpts - Options for spawnGroup.
 * @param local - Project-local bin from selectLintTool, or null.
 * @returns The spawn result of whichever route ran.
 */
async function runLintTool(tool: LintTool, argv: string[], spawnOpts: SpawnSyncOptionsWithStringEncoding, local: string | null): Promise<SpawnSyncReturns<string>> {
  const viaLocal = local ? await spawnBin(local, argv, spawnOpts) : null;
  if (viaLocal) return viaLocal;
  if (tool.npmSpec && !onPath(tool.name)) return runNpx(tool.name, tool.npmSpec, argv, spawnOpts);
  // spawnAs decouples "which binary name gates PATH-availability /
  // selectLintTool matching" (tool.name -- probed by onPath/selectLintTool)
  // from "which binary + args are actually spawned". Only the rust chain's
  // clippy entry sets it today: it probes the standalone cargo-clippy driver
  // binary (whose presence signals the clippy rustup component is installed)
  // but must actually run via the `cargo clippy` subcommand, since the bare
  // driver binary rejects buildArgv's --manifest-path.
  const spawnName = tool.spawnAs?.name ?? tool.name;
  const spawnArgv = tool.spawnAs ? [...tool.spawnAs.args, ...argv] : argv;
  return spawnGroup(spawnName, spawnArgv, spawnOpts);
}

/** Per-process memo for configExists: a prefiltered directory -> its entry names upper-cased, or null when readdirSync failed (each hook event is its own process; never invalidated). */
const dirEntries = new Map<string, Set<string> | null>();

/**
 * Whether `name` exists in `dir`, with existsSync's answer exactly. With `prefilter` (by default when the walked path
 * lexically starts with `/mnt/`, WSL 9P/drvfs, several ms per probe; never realpath) one readdirSync per directory
 * and process first rules out names whose upper-cased first path segment is not listed; a listed hit is still
 * confirmed by existsSync (case-insensitive mounts, dangling links), and an unreadable directory falls back to
 * existsSync. Without it this is plain existsSync (ext4 and every path outside `/mnt/`).
 *
 * @param dir - Directory being walked.
 * @param name - Candidate relative to `dir`: a file name or a `path.join` result such as `node_modules/.bin/eslint` (POSIX only, so `/`-separated).
 * @param prefilter - Use the readdir prefilter; defaults to the `/mnt/` gate (tests force it on ext4).
 * @returns True when existsSync(path.join(dir, name)) is true.
 */
export function configExists(dir: string, name: string, prefilter: boolean = dir.startsWith("/mnt/")): boolean {
  if (prefilter) {
    let names = dirEntries.get(dir);
    if (names === undefined) {
      try {
        names = new Set(readdirSync(dir).map((n) => n.toUpperCase()));
      } catch {
        names = null; // x without r, or gone: no prefilter, existsSync per name as before
      }
      dirEntries.set(dir, names);
    }
    if (names && !names.has(name.split("/", 1)[0].toUpperCase())) return false;
  }
  return existsSync(path.join(dir, name));
}

/**
 * Whether any of `names` exists in `dir`, probed through configExists.
 *
 * @param dir - Directory to probe.
 * @param names - Candidate config file names.
 * @returns True when at least one name exists.
 */
function anyConfigExists(dir: string, names: readonly string[]): boolean {
  return names.some((n) => configExists(dir, n));
}

/**
 * Walk from `fileDir` up to `cwd` (inclusive), calling `checkDir(dir)` at each
 * level; returns the first non-null result, or null if none found. Shared
 * walk/termination logic for resolveCheckstyleConfig and resolveTsconfig --
 * only what differs (a fixed set of candidate filenames vs. one file with
 * content validation) stays in each caller.
 *
 * @param fileDir - Directory to start from.
 * @param cwd - Project root; the walk stops there (inclusive).
 * @param checkDir - Probe called per directory, returning a hit or null.
 * @returns The first hit, or null.
 */
function walkUpToCwd(fileDir: string, cwd: string, checkDir: (dir: string) => string | null): string | null {
  let dir = fileDir;
  for (;;) {
    const found = checkDir(dir);
    if (found) return found;
    if (dir === cwd) break;
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root safety
    dir = parent;
  }
  return null;
}

/**
 * The nearest project-local `node_modules/.bin/<name>`, walking from the file's directory up to `cwd` inclusive
 * (`walkUpToCwd`). A directory outside `cwd` never counts (a lexical file path outside it, e.g. through a symlinked
 * dir, would otherwise walk to `/`), so the local route never runs a bin above the project.
 *
 * @param name - Bin name (`LintTool.name`, not `npmSpec`: markdownlint's package is markdownlint-cli).
 * @param fileDir - Directory of the linted file.
 * @param cwd - Project root.
 * @returns The bin's absolute path, or null.
 */
function localBin(name: string, fileDir: string, cwd: string): string | null {
  const rel = path.join("node_modules", ".bin", name);
  return walkUpToCwd(fileDir, cwd, (dir) => (!outside(path.relative(cwd, dir)) && configExists(dir, rel) ? path.join(dir, rel) : null));
}

/**
 * Walk from the file's dir up to cwd (inclusive); return the first existing
 * checkstyle config path, or null. Existence-only (no section parsing needed --
 * unlike a formatter, a linter doesn't need to reproduce exact style output, so
 * there is no "does this section apply to this file" question to answer).
 *
 * @param fileDir - Directory of the edited file.
 * @param cwd - Project root.
 * @returns Path of the nearest checkstyle config, or null.
 */
export function resolveCheckstyleConfig(fileDir: string, cwd: string): string | null {
  const candidates = ["checkstyle.xml", ".checkstyle.xml", path.join("config", "checkstyle", "checkstyle.xml")];
  return walkUpToCwd(fileDir, cwd, (dir) => {
    for (const rel of candidates) {
      if (configExists(dir, rel)) return path.join(dir, rel);
    }
    return null;
  });
}

/**
 * Walk from the file's dir up to cwd (inclusive); return the nearest
 * Cargo.toml path, or null. Existence-only (a linter never needs to parse
 * the manifest -- it only needs its path to pass to --manifest-path).
 * cargo clippy/check take no positional file/dir target, so this anchors
 * the run on the correct crate root even in a multi-crate workspace.
 *
 * @param fileDir - Directory of the edited file.
 * @param cwd - Project root.
 * @returns Path of the nearest Cargo.toml, or null.
 */
export function resolveCargoManifest(fileDir: string, cwd: string): string | null {
  return walkUpToCwd(fileDir, cwd, (dir) => {
    const p = path.join(dir, "Cargo.toml");
    return configExists(dir, "Cargo.toml") ? p : null;
  });
}

/**
 * Walk from the edited file's dir up to cwd (inclusive); return the first
 * tsconfig.json that isn't solution-style (see looksLikeSolutionStyleTsconfig),
 * or null. An unreadable tsconfig.json (permission-denied, or a directory
 * literally named tsconfig.json) is treated as absent -- the walk keeps
 * climbing past it rather than stopping there, so a genuinely valid tsconfig
 * further up is still found.
 *
 * @param fileDir - Directory of the edited file.
 * @param cwd - Project root.
 * @returns Path of the nearest non-solution-style tsconfig.json, or null.
 */
export function resolveTsconfig(fileDir: string, cwd: string): string | null {
  return walkUpToCwd(fileDir, cwd, (dir) => {
    const p = path.join(dir, "tsconfig.json");
    if (!configExists(dir, "tsconfig.json")) return null;
    let text: string;
    try {
      text = readFileSync(p, "utf8");
    } catch {
      return null; // unreadable -- treat as absent, keep climbing
    }
    return !looksLikeSolutionStyleTsconfig(text) ? p : null;
  });
}

/** Eslint config file names, checked after the oxlint names within one directory; also walked by `lintResolved` from the file dir up to `/` when no oxlint config selects oxlint. */
const ESLINT_CONFIG_FILENAMES = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yaml",
  ".eslintrc.yml",
];

/** Oxlint config file names, checked first within one directory (oxlint wins a same-dir tie). */
const OXLINT_CONFIG_FILENAMES = [".oxlintrc.json", ".oxlintrc.jsonc", "oxlint.config.ts"];

/**
 * Nearest lint config (file dir up to cwd, inclusive) picks the jsts chain.
 * Selection by file name only; in one dir oxlint names are checked first, so
 * oxlint wins a same-dir tie. null means no oxlint config; `lintResolved` then
 * runs eslint only when an eslint config name exists from the file's dir up to
 * the filesystem root, else no chain lint.
 *
 * @param fileDir - Directory of the edited file.
 * @param cwd - Project root.
 * @returns Path of the nearest config if it is an oxlint config, else null.
 */
export function resolveOxlintConfig(fileDir: string, cwd: string): string | null {
  const hit = walkUpToCwd(fileDir, cwd, (dir) => {
    for (const n of [...OXLINT_CONFIG_FILENAMES, ...ESLINT_CONFIG_FILENAMES]) {
      if (configExists(dir, n)) return path.join(dir, n);
    }
    return null;
  });
  return hit && OXLINT_CONFIG_FILENAMES.includes(path.basename(hit)) ? hit : null;
}

/**
 * True when an oxlint JSON(C) config sets options.typeCheck: oxlint
 * type-checks itself, so the separate tsc run is skipped. oxlint.config.ts
 * can't be read without executing it -> false.
 *
 * @param configPath - The oxlint config that selected oxlint.
 * @returns Whether its parsed `options.typeCheck` is literally `true`.
 */
export function oxlintConfigTypeChecks(configPath: string): boolean {
  if (!configPath.endsWith(".json") && !configPath.endsWith(".jsonc")) return false;
  try {
    const text = stripTrailingCommas(stripJsonComments(readFileSync(configPath, "utf8")));
    const cfg = JSON.parse(text) as { options?: { typeCheck?: unknown } } | null;
    return cfg?.options?.typeCheck === true;
  } catch {
    return false; // unreadable or malformed -> keep tsc
  }
}

/**
 * Strip // line comments and /* ... *\/ block comments from JSONC text, respecting
 * string literals (so a string containing "//" or "/\*" isn't misread as a
 * comment start). tsconfig.json is JSONC -- real projects routinely put a
 * comment like "// see project references" or "/\* references: ... *\/" next
 * to a key, which would otherwise false-positive-match the regex checks
 * below. Just enough parsing for that; not a full JSON/JSONC parser.
 *
 * @param text - JSONC text.
 * @returns The text without comments.
 */
function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      if (c === "\\") {
        out += c + (text[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (c === "\"") inString = false;
      out += c;
      i++;
      continue;
    }
    if (c === "\"") {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2; // skip past "*/"
      out += " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Drop JSONC trailing commas (a `,` followed only by whitespace before `}`/`]`),
 * string-aware so a value like `"a,}"` is left intact. Run after stripJsonComments.
 *
 * @param text - Comment-free JSONC text.
 * @returns The text without trailing commas.
 */
export function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") {
        out += c + (text[i + 1] ?? "");
        i++;
        continue;
      }
      if (c === "\"") inString = false;
    } else if (c === "\"") {
      inString = true;
    } else if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += c;
  }
  return out;
}

/**
 * A "solution-style" tsconfig (`references` present, `include` absent, and
 * `files` either absent or an empty array) compiles and checks nothing under
 * plain `-p` -- confirmed empirically: `tsc --noEmit` against this shape
 * exits 0 even with a real type error in the referenced project.
 * `"files": []` is the TS handbook's own documented way to author a
 * solution-style config (it's how you disable direct compilation), so an
 * empty `files` array must NOT disqualify -- only a real `include`, or a
 * `files` array with at least one entry, means this config actually compiles
 * something itself. Existence/pattern-only regex over comment-stripped text,
 * not a full JSON/JSONC parse (tsconfig permits comments/trailing commas) --
 * unanchored (no line-start requirement) so it matches equally in compact
 * single-line and pretty-printed JSON. A string VALUE that happens to contain
 * the exact literal substring `"references":` (quote-colon included) would
 * still false-match -- accepted residual risk, since tsconfig.json's own
 * fixed schema has no free-text fields where that's a realistic occurrence,
 * unlike comments, which real projects write routinely.
 *
 * @param text - Content of a tsconfig.json.
 * @returns True when the config compiles nothing itself.
 */
export function looksLikeSolutionStyleTsconfig(text: string): boolean {
  const stripped = stripJsonComments(text);
  const hasReferences = /"references"\s*:/.test(stripped);
  if (!hasReferences) return false;
  const hasInclude = /"include"\s*:/.test(stripped);
  if (hasInclude) return false;
  const filesMatch = stripped.match(/"files"\s*:\s*\[([^\]]*)\]/);
  const hasNonEmptyFiles = !!filesMatch && filesMatch[1].trim() !== "";
  return !hasNonEmptyFiles;
}

/**
 * Shared sha256-hex digest of a path string, used to derive both the tsc
 * buildinfo cache key below (tests reuse it too).
 *
 * @param p - Path string to hash.
 * @returns Lowercase sha256 hex digest.
 */
export function hashPath(p: string): string {
  return createHash("sha256").update(p).digest("hex");
}

/**
 * Stable cache-file path for tsc's --tsBuildInfoFile, keyed by the resolved
 * tsconfig's realpath so repeat edits within the same project reuse one cache.
 * Lives under ${CLAUDE_PLUGIN_DATA} (persistent, survives plugin updates,
 * exported to hook processes) -- never inside the project tree, so this
 * plugin's "never writes into the repo" property holds even though tsc itself
 * writes a small bookkeeping file. Mirrors memory-enhancement's flagPathFor
 * hash-suffix idiom, but falls back to the OS temp dir, not ".", when the env
 * var is unset (should not happen in a real hook process, but "." resolves
 * against this function's caller's cwd -- the project root -- which would
 * silently violate the very invariant this comment claims).
 *
 * @param tsconfigPath - Path of the resolved tsconfig.json.
 * @returns Absolute path of the tsc buildinfo cache file.
 */
export function tsBuildInfoPathFor(tsconfigPath: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(tsconfigPath);
  } catch {
    resolved = path.resolve(tsconfigPath);
  }
  const hash = hashPath(resolved).slice(0, 8);
  const dataDir = process.env.CLAUDE_PLUGIN_DATA || tmpdir();
  return path.resolve(dataDir, `tsc-buildinfo-${hash}.json`);
}

/**
 * yamllint's own project-config filenames (yamllint/cli.py's
 * find_project_config_filepath, verified against yamllint 1.38.0).
 */
const YAMLLINT_CONFIG_FILENAMES = [".yamllint", ".yamllint.yaml", ".yamllint.yml"];

/**
 * Faithful port of yamllint's own find_project_config_filepath: starts at the
 * CLI's cwd -- which is always this hook's spawnSync `cwd` (the project root),
 * regardless of which file is being linted, since yamllint has no per-file
 * config resolution -- then walks upward, stopping once the walked dir IS the
 * user's home directory (checked there too, not skipped first) or the
 * filesystem root. A real project config anywhere on that path is always
 * respected; only its total absence triggers the line-length guard below.
 *
 * @param cwd - Project root.
 * @returns True when a yamllint project config governs the run.
 */
export function hasProjectYamllintConfig(cwd: string): boolean {
  let dir = path.resolve(cwd);
  const home = path.resolve(homedir());
  for (;;) {
    if (anyConfigExists(dir, YAMLLINT_CONFIG_FILENAMES)) return true;
    if (dir === home) return false;
    const parent = path.dirname(dir);
    if (parent === dir) return false; // filesystem root
    dir = parent;
  }
}

/**
 * yamllint's line-length rule is "error" level in its own bundled default
 * ruleset (verified empirically against yamllint 1.38.0 -- NOT "warning", so
 * this hook's existing 0-clean/1-issues classifyExit contract already
 * surfaces it without --strict). -d overrides yamllint's own project-config
 * search entirely, so it is only ever passed when hasProjectYamllintConfig
 * found nothing. Single-line flow-style YAML (not the equivalent multi-line
 * block form), passed as one argv element.
 */
const YAMLLINT_NO_LINE_LENGTH_CONFIG_DATA = "{extends: default, rules: {line-length: disable}}";

/**
 * markdownlint-cli2's own documented config filenames (its --help's own
 * "Configuration via:" list, verified against markdownlint-cli2 0.23.2);
 * markdownlint (classic) shares the legacy `.markdownlint.*` half of this
 * list. Verified empirically that cli2 does NOT also read a
 * "markdownlint-cli2" key from package.json.
 */
const MARKDOWNLINT_CONFIG_FILENAMES = [
  ".markdownlint-cli2.jsonc",
  ".markdownlint-cli2.yaml",
  ".markdownlint-cli2.cjs",
  ".markdownlint-cli2.mjs",
  ".markdownlint.jsonc",
  ".markdownlint.json",
  ".markdownlint.yaml",
  ".markdownlint.yml",
  ".markdownlint.cjs",
  ".markdownlint.mjs",
];

/**
 * Walk from `dir` up to the filesystem root (inclusive), calling `checkDir` at
 * each level; true on the first hit. Unbounded, unlike walkUpToCwd above:
 * markdownlint-cli2's own per-file config resolution walks past its base
 * directory up through that directory's own ancestors too (verified against
 * markdownlint-cli2's source, enumerateParents) -- bounding this at `cwd`
 * risks misdetecting "absent" for a real config living above the project
 * root (a workspace/monorepo case). Eslint config detection (`lintResolved`)
 * uses it too: eslint looks up its config past the project root as well.
 *
 * @param dir - Directory to start from.
 * @param checkDir - Probe called per directory.
 * @returns True on the first directory the probe accepts.
 */
function walkToRoot(dir: string, checkDir: (dir: string) => boolean): boolean {
  for (;;) {
    if (checkDir(dir)) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * True if a markdownlint-cli2 or markdownlint (classic) project config
 * governs `fileDir` -- existence-only over MARKDOWNLINT_CONFIG_FILENAMES.
 *
 * @param fileDir - Directory of the edited file.
 * @returns True when a markdownlint config governs the file.
 */
export function hasProjectMarkdownlintConfig(fileDir: string): boolean {
  return walkToRoot(fileDir, (dir) => anyConfigExists(dir, MARKDOWNLINT_CONFIG_FILENAMES));
}

/**
 * stylelint's per-directory config file names: cosmiconfig 10's default search places for module "stylelint", which
 * stylelint 18.0.0 uses unchanged (verified in its source). `package.json` is the remaining search place and counts
 * only with a `stylelint` key (`hasStylelintConfig`). Update together with stylelint's search places.
 */
const STYLELINT_CONFIG_FILENAMES = [
  ".stylelintrc",
  ".stylelintrc.json",
  ".stylelintrc.yaml",
  ".stylelintrc.yml",
  ".stylelintrc.js",
  ".stylelintrc.ts",
  ".stylelintrc.cjs",
  ".stylelintrc.mjs",
  ".config/stylelintrc",
  ".config/stylelintrc.json",
  ".config/stylelintrc.yaml",
  ".config/stylelintrc.yml",
  ".config/stylelintrc.js",
  ".config/stylelintrc.ts",
  ".config/stylelintrc.cjs",
  ".config/stylelintrc.mjs",
  "stylelint.config.js",
  "stylelint.config.ts",
  "stylelint.config.cjs",
  "stylelint.config.mjs",
];

/**
 * True when stylelint could find a config for a file in `fileDir`, a superset of stylelint 18's own lookup: a
 * STYLELINT_CONFIG_FILENAMES name or a `package.json` with a non-null top-level `stylelint` key in any directory from
 * `fileDir` up to the filesystem root (stylelint itself stops at `$HOME`), and likewise from `cwd` (stylelint falls
 * back to searching its cwd, which a symlinked file path can leave off the `fileDir` walk), else an existing stylelint
 * global config dir (`$XDG_CONFIG_HOME/stylelint` or `~/.config/stylelint`, and macOS's `~/Library/Preferences/stylelint`,
 * both checked on every platform; the directory counts by existence, not by the `config*` files stylelint reads in it).
 * Without one stylelint only exits 78 (skip).
 *
 * @param fileDir - Directory of the edited file.
 * @param cwd - Payload cwd, the second search start.
 * @returns True when a stylelint config may govern the file; an unreadable or invalid `package.json` counts (fail open).
 */
function hasStylelintConfig(fileDir: string, cwd: string): boolean {
  /**
   * Whether `dir` has a `package.json` with a non-null top-level `stylelint` key.
   *
   * @param dir - Directory to probe.
   * @returns True with the key, or when the `package.json` is unreadable or invalid (fail open); false without one.
   */
  const hasKey = (dir: string): boolean => {
    if (!configExists(dir, "package.json")) return false;
    const pkg = path.join(dir, "package.json");
    try {
      return (JSON.parse(readFileSync(pkg, "utf8")) as { stylelint?: unknown } | null)?.stylelint != null;
    } catch {
      return true; // unreadable or invalid: run stylelint and let classifyExit decide
    }
  };
  /**
   * Whether `d` holds a stylelint config file name or a `package.json` with the key.
   *
   * @param d - Directory to probe.
   * @returns True when stylelint would find a config there.
   */
  const found = (d: string): boolean => anyConfigExists(d, STYLELINT_CONFIG_FILENAMES) || hasKey(d);
  if (walkToRoot(fileDir, found) || walkToRoot(cwd, found)) return true;
  const home = homedir();
  return [process.env.XDG_CONFIG_HOME || path.join(home, ".config"), path.join(home, "Library", "Preferences")].some((d) => existsSync(path.join(d, "stylelint")));
}

/** File name of the MD013-off config, written into `CLAUDE_PLUGIN_DATA` (OS temp dir when unset), never into the project tree. */
const MARKDOWNLINT_NO_LINE_LENGTH_CONFIG_NAME = "markdownlint-no-line-length.json";

/**
 * Constant config disabling only MD013 (line-length) -- both markdownlint-cli2 and markdownlint (classic) accept the
 * same --config flag and config schema, so one file serves both chain entries. markdownlint takes a file path only,
 * so `markdownlintNoLineLengthConfigPath` materializes this content on first use.
 */
const MARKDOWNLINT_NO_LINE_LENGTH_CONFIG = "{\n  \"MD013\": false\n}\n";

/**
 * Path of the MD013-off config file, written when absent or different (temp file + renameSync, so a concurrent
 * process never reads a torn file). Throws when the file cannot be written: `lintFileHandler` turns that into its
 * usual silent no-op, so a broken data dir never surfaces line-length noise.
 *
 * @returns Absolute path of the config file.
 */
function markdownlintNoLineLengthConfigPath(): string {
  const file = path.resolve(process.env.CLAUDE_PLUGIN_DATA || tmpdir(), MARKDOWNLINT_NO_LINE_LENGTH_CONFIG_NAME);
  try {
    if (readFileSync(file, "utf8") === MARKDOWNLINT_NO_LINE_LENGTH_CONFIG) return file;
  } catch {
    /* absent or unreadable: (re)write below */
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, MARKDOWNLINT_NO_LINE_LENGTH_CONFIG);
  renameSync(tmp, file);
  return file;
}

/**
 * Build the argv for a chain tool: fixed bare args, an optional -c <config> for
 * checkstyle or -d/--config line-length guards for yamllint/markdownlint, then
 * the target (the file, or its directory for targetsDir tools) last.
 * `manifest` is an optional precomputed resolveCargoManifest result -- passing
 * it lets a caller that already resolved the manifest (runChainLint's gate)
 * avoid a second directory walk; when omitted (e.g. direct unit-test calls)
 * it's resolved here as before.
 *
 * @param tool - Chain entry.
 * @param resolvedFile - Absolute path of the edited file.
 * @param cwd - Project root.
 * @param manifest - Precomputed resolveCargoManifest result, to skip a second walk.
 * @returns The tool's argv, target last (none for manifestPath tools).
 */
export function buildArgv(tool: LintTool, resolvedFile: string, cwd: string, manifest?: string | null): string[] {
  const dir = path.dirname(resolvedFile);
  const argv = tool.args.slice();
  if (tool.needsCheckstyleConfig) {
    argv.push("-c", resolveCheckstyleConfig(dir, cwd) ?? "/google_checks.xml");
  }
  if (tool.guardYamlLineLength && !hasProjectYamllintConfig(cwd)) {
    argv.push("-d", YAMLLINT_NO_LINE_LENGTH_CONFIG_DATA);
  }
  if (tool.guardMarkdownLineLength && !hasProjectMarkdownlintConfig(dir)) {
    argv.push("--config", markdownlintNoLineLengthConfigPath());
  }
  // cargo clippy/check take no positional target. Resolve the nearest
  // Cargo.toml and emit --manifest-path <path> as a cargo option -- inserted
  // BEFORE any `--` separator so it stays a cargo flag, never a post-`--`
  // rustc arg -- then return WITHOUT a trailing positional. A stray .rs file
  // outside any Cargo project (no manifest) leaves args untouched; the
  // runChainLint gate no-ops it before spawning.
  if (tool.manifestPath) {
    const resolved = manifest !== undefined ? manifest : resolveCargoManifest(dir, cwd);
    if (resolved) {
      const sep = argv.indexOf("--");
      argv.splice(sep === -1 ? argv.length : sep, 0, "--manifest-path", resolved);
    }
    return argv;
  }
  argv.push(tool.targetsDir ? dir : resolvedFile);
  return argv;
}

/**
 * Classify a lint-tool exit code into "clean" | "issues" | "skip" (crashed / usage
 * error / config problem -- not a real lint finding). Per-tool contracts verified
 * against each tool's official docs (see the design notes in `.claude/rules/hook-design.md`). Never
 * consulted for checkstyle -- see classifyCheckstyleOutput.
 *
 * @param toolName - Name of the lint tool.
 * @param status - Exit status, null when killed or not spawned.
 * @returns clean, issues, or skip.
 */
export function classifyExit(toolName: string, status: number | null): "clean" | "issues" | "skip" {
  if (status === null) return "skip"; // killed by signal (timeout) or spawn error
  switch (toolName) {
    case "shellcheck": // 0 clean, 1 issues, 2/3/4 file-not-found/bad-invocation/bad-options
    case "ktlint": // 0 clean, 1 issues (lint-only mode; --format's quirk doesn't apply here)
    case "eslint": // 0 clean, 1 issues, 2 config/internal error
    case "oxlint": // 0 clean (warnings don't fail), 1 lint errors / config load failure / type errors
    case "ruff": // 0 clean, 1 issues, 2 abnormal termination
    case "golangci-lint": // 0 clean, 1 issues, 2-7 warning-in-test/failure/timeout/no-go-files/no-config/error-logged
    case "yamllint": // 0 clean, 1 issues (run without --strict, matching eslint's warnings-don't-count precedent), 255 config/IO crash (POSIX-truncated from sys.exit(-1))
    case "markdownlint-cli2": // 0 clean, 1 issues, 2 tool problem/failure
    case "markdownlint": // 0 clean, 1 issues, 2/3/4 tool-side failures (bad -o/-r/malformed config)
      if (status === 0) return "clean";
      if (status === 1) return "issues";
      return "skip";
    case "go": // go vet: 0 clean, non-zero = "problem reported OR erroneous invocation" (Go's
      // own docs don't separate the two); accepted -- see `.claude/rules/hook-design.md`.
      return status === 0 ? "clean" : "issues";
    case "stylelint":
      // 0 clean, 2 real lint violation, else crash/misconfig (skip) --
      // verified against stylelint.io/user-guide/usage/cli.
      if (status === 0) return "clean";
      if (status === 2) return "issues";
      return "skip";
    case "tsc":
      // 0 clean, 1 OR 2 real problem, else skip -- verified EMPIRICALLY, not
      // from docs, and the contract has already flipped once across a tsc
      // major version: under tsc v6.0.3, a real type/syntax error under
      // --noEmit exited 2 and only an invalid project path (nonexistent
      // tsconfig) exited 1 -- the OPPOSITE of the compiler's documented
      // ExitStatus enum (Success=0, DiagnosticsPresent_OutputsSkipped=1,
      // _OutputsGenerated=2). Under TypeScript 7.0's native ("tsgo") tsc,
      // real diagnostics under --noEmit instead exit 1 (matching the
      // documented enum this time), but exit 1 is now ALSO used for genuine
      // project/config-loading failures (broken `extends` path, invalid
      // compiler-option value, nonexistent tsconfig path) -- verified
      // empirically against 7.0.2 (TS5083/TS6046/TS5058, all exit 1, none
      // referencing a real source-file location). This exit-code-only bucket
      // therefore only separates clean (0) from "worth a closer look" (1 or
      // 2); the caller (runTypeCheck) does a second, content-based pass on
      // status-1 results specifically (tscOutputHasSourceDiagnostic) to
      // distinguish an actual source-file diagnostic from a pure
      // config-loading failure before surfacing a finding. Trust the live
      // behavior, not the enum -- re-verify whenever the installed tsc major
      // version changes materially and findings stop surfacing.
      if (status === 0) return "clean";
      if (status === 1 || status === 2) return "issues";
      return "skip";
    case "phpstan":
      // 0 clean (phpstan.org/user-guide/command-line-usage, quoted: "Exit code 0
      // means there are no errors"). Other codes are not documented as a clean
      // split between "real findings" and "phpstan itself failed" -- accepted,
      // same ambiguity already accepted for `go` above.
      return status === 0 ? "clean" : "issues";
    case "psalm":
      // 0 clean, 1 problem running psalm itself (crash/misconfig), 2 completed
      // and found real issues -- verified verbatim against
      // psalm.dev/docs/running_psalm/command_line_usage, and the missing-config
      // path (exit 1, not 2) confirmed directly against Psalm's own source
      // (src/Psalm/Internal/CliUtils.php).
      if (status === 0) return "clean";
      if (status === 2) return "issues";
      return "skip";
    // "cargo-clippy" here is the identity used for PATH-probing/selection only
    // (see REGISTRY's rust chain) -- the selected entry is actually spawned as
    // `cargo clippy` via its `spawnAs`, so it shares cargo's own exit-code
    // contract below rather than needing a separate case body. VERIFIED
    // EMPIRICALLY (cargo 1.97.1 / clippy 0.1.97): `-- -D warnings` promotes a
    // real clippy finding (clippy::single_match) to exit 101, same as cargo
    // check's own compile-error exit code.
    case "cargo-clippy":
    case "cargo": // cargo check: 0 clean, 101 on compile error. Non-zero vs.
      // "cargo itself failed" is not cleanly separable by exit code -- accepted,
      // same coarse contract already accepted for `go`/`phpstan` above.
      return status === 0 ? "clean" : "issues";
    default:
      return "skip";
  }
}

/**
 * checkstyle prints exactly "Starting audit..." first and "Audit done." last,
 * regardless of violation count or severity -- confirmed against the Main CLI
 * docs. A run that didn't reach "Audit done." didn't complete normally (bad
 * config, exception, kill) -> skip. Otherwise strip both boilerplate lines; what
 * remains is the actual violation text (issues) or nothing (clean).
 *
 * @param stdout - checkstyle's stdout.
 * @returns The verdict and the violation text.
 */
export function classifyCheckstyleOutput(stdout: string): { status: "clean" | "issues" | "skip"; text: string } {
  const lines = String(stdout ?? "").split(/\r?\n/);
  let lastIdx = lines.length - 1;
  while (lastIdx >= 0 && lines[lastIdx].trim() === "") lastIdx--;
  if (lastIdx < 0 || lines[lastIdx].trim() !== "Audit done.") return { status: "skip", text: "" };
  let firstIdx = 0;
  while (firstIdx < lines.length && lines[firstIdx].trim() === "") firstIdx++;
  const skipFirst = firstIdx < lines.length && lines[firstIdx].trim() === "Starting audit...";
  const body = lines
    .slice(skipFirst ? firstIdx + 1 : firstIdx, lastIdx)
    .join("\n")
    .trim();
  return body ? { status: "issues", text: body } : { status: "clean", text: "" };
}

/**
 * Trim, collapse runs of 3+ blank lines to one, and cap at `max` (default MAX_CONTEXT_CHARS).
 *
 * @param text - Findings text.
 * @param max - Character cap; the skill driver passes MAX_CONTEXT_CHARS times the files of a batched run.
 * @returns The text trimmed, collapsed and capped.
 */
export function truncate(text: string, max = MAX_CONTEXT_CHARS): string {
  const collapsed = text.replace(/\n{3,}/g, "\n\n").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max) + "\n… (truncated)";
}

/**
 * Three-pass tool selection, PATH > project-local bin > npx (passes 1 and 3
 * mirror universal-format's selectFormatter). PATH first, like `tsc`'s lookup:
 * a tool the user has on PATH keeps running, only runs that used npx change.
 * Each pass scans the whole chain, so an installed chain tool (on PATH, then in
 * a local `node_modules/.bin`) always wins over one that's merely
 * npx-reachable, regardless of chain order. Without this, giving npmSpec to
 * more than one chain entry (e.g. markdownlint-cli2 before markdownlint) would
 * let the earlier entry's npx fallback shadow a later entry that's genuinely
 * installed -- npx ships with node, so it's essentially always "available."
 *
 * @param chain - A language's tool chain.
 * @param fileDir - Directory of the linted file (start of the local-bin walk).
 * @param cwd - Project root (end of the local-bin walk).
 * @returns The tool to run plus its project-local bin (null for the PATH and
 *   npx routes), or null when none is available.
 */
function selectLintTool(chain: LintTool[], fileDir: string, cwd: string): { tool: LintTool; local: string | null } | null {
  for (const tool of chain) {
    if (onPath(tool.name)) return { tool, local: null };
  }
  for (const tool of chain) {
    const local = tool.npmSpec ? localBin(tool.name, fileDir, cwd) : null;
    if (local) return { tool, local };
  }
  if (!onPath("npx")) return null;
  for (const tool of chain) {
    if (tool.npmSpec) return { tool, local: null };
  }
  return null;
}

/**
 * Shared options builder for `spawnGroup` (which applies `timeout` and `maxBuffer` itself) -- only `timeout` differs
 * between the chain-tool run (SPAWN_TIMEOUT_MS) and the tsc run (TSC_SPAWN_TIMEOUT_MS).
 *
 * @param cwd - Working directory of the child.
 * @param timeout - Timeout in milliseconds.
 * @returns The options (spawnSync's shape, reused as `spawnGroup`'s input).
 */
function buildSpawnOpts(cwd: string, timeout: number): SpawnSyncOptionsWithStringEncoding {
  return {
    cwd,
    timeout,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: MAX_BUFFER_BYTES,
  };
}

/** One planned chain-tool run for one file: the tool, how to spawn it, and the argv `buildArgv` built for the file. */
interface ChainPlan {
  /** The chain tool `selectLintTool` picked (PATH, else project-local bin, else npx). */
  tool: LintTool;
  /** The tool's project-local `node_modules/.bin` path, or null for the PATH and npx routes. */
  local: string | null;
  /** `buildArgv` result for the file: file target last for file-scoped tools, package dir for `targetsDir`, none for `manifestPath`. */
  argv: string[];
  /** Spawn cwd: the local bin's package root (the dir holding node_modules), else the project cwd. */
  spawnCwd: string;
  /** Spawn timeout: `CARGO_SPAWN_TIMEOUT_MS` for `manifestPath` tools, else `SPAWN_TIMEOUT_MS`. */
  timeout: number;
  /** Resolved Cargo.toml for `manifestPath` tools, else null. */
  manifest: string | null;
}

/** Whether the tool takes the file path as its target (neither a directory- nor a crate-scoped tool), so a batch may swap the target. */
function isFileScoped(tool: ChainPlan["tool"]): boolean {
  return !tool.targetsDir && !tool.manifestPath;
}

/** Report-header target of a chain run: the package dir, the crate dir, or the file itself. */
function chainTarget(tool: ChainPlan["tool"], manifest: string | null | undefined, cwd: string, fp: string): string {
  return tool.targetsDir ? path.relative(cwd, path.dirname(fp)) || "." : manifest ? path.relative(cwd, path.dirname(manifest)) || "." : path.relative(cwd, fp);
}

/**
 * Plan the chain tool run for one file (the first half of `runChainLint`, shared with `lintFilesHandler`): select the
 * tool, gate cargo on a resolvable manifest, build the argv and pick the timeout and spawn cwd. Spawns nothing.
 *
 * @param lang - Registry entry of the file's language (as returned by `chainEntryFor`).
 * @param resolved - Absolute path of the file.
 * @param cwd - Project root.
 * @returns The plan, or null when no tool is available or a cargo tool has no manifest.
 */
function planChainLint(lang: LangEntry, resolved: string, cwd: string): ChainPlan | null {
  const sel = selectLintTool(lang.chain, path.dirname(resolved), cwd);
  if (!sel) return null;
  const { tool } = sel;
  // Gate cargo runs on a resolvable manifest: a stray .rs outside any Cargo
  // project is a silent no-op, not a spurious "could not find Cargo.toml"
  // exit-101 finding. Resolved once here and threaded through buildArgv and
  // the target computation below -- resolveCargoManifest is a directory walk
  // doing an existsSync per level, so re-resolving it for the same
  // file/cwd pair would repeat that walk for no new answer.
  let manifest: string | null = null;
  if (tool.manifestPath) {
    manifest = resolveCargoManifest(path.dirname(resolved), cwd);
    if (!manifest) return null;
  }

  const argv = buildArgv(tool, resolved, cwd, manifest);
  // Compile-heavy cargo tools get their own budget (mirrors TSC_SPAWN_TIMEOUT_MS).
  const timeout = tool.manifestPath ? CARGO_SPAWN_TIMEOUT_MS : SPAWN_TIMEOUT_MS;
  // A local bin runs from its package root (the dir holding node_modules): eslint <= 9 resolves its flat config from the spawn cwd.
  const spawnCwd = sel.local ? path.join(sel.local, "../../..") : cwd;
  return { tool, local: sel.local, argv, spawnCwd, timeout, manifest };
}

/**
 * Classify one chain-tool spawn result (shared by `runChainLint` and `lintFilesHandler`): checkstyle by its stripped
 * stdout (`classifyCheckstyleOutput`), every other tool by exit code (`classifyExit`) with stdout and stderr joined.
 *
 * @param tool - The tool that ran.
 * @param result - Its spawn result, or null when `coalesceProjectCheck` skipped the run.
 * @returns Verdict and findings text, or null on a skipped run, spawn error or signal (timeout included).
 */
function chainOutcome(tool: LintTool, result: SpawnSyncReturns<string> | null): { verdict: "clean" | "issues" | "skip"; text: string } | null {
  if (!result || result.error || result.signal) return null;
  let verdict: "clean" | "issues" | "skip";
  let text: string;
  if (tool.classify === "output") {
    const out = classifyCheckstyleOutput(result.stdout);
    verdict = out.status;
    text = out.text;
  } else {
    verdict = classifyExit(tool.name, result.status);
    text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  }
  return { verdict, text };
}

/**
 * Run the language's chain-selected tool and return its finding, or null on any
 * guard failure / clean / skip verdict. `planChainLint` selects the tool (`selectLintTool`:
 * PATH, else a project-local `node_modules/.bin`, else npx) and builds argv, timeout and spawn cwd; the run goes
 * through `runLintTool`, which is handed the local bin when one was selected, and `chainOutcome` classifies it.
 * selectLintTool's own null path
 * already covers "nothing on PATH, no local bin and nothing npx-eligible" --
 * no separate pre-check needed (an earlier `isToolAvailable`-based short-circuit here was
 * logically redundant with it and has been removed).
 *
 * @param lang - Registry entry of the file's language.
 * @param resolved - Absolute path of the edited file.
 * @param cwd - Project root.
 * @param rel - Path of the file relative to cwd.
 * @param coalesce - FileChanged: run a directory- or crate-scoped tool (`go vet`, `golangci-lint`, `cargo`) through
 *   `coalesceProjectCheck`, once per burst and package/crate; file-scoped tools always run.
 *   Async since F18: the spawn goes through `spawnGroup` (group killed on timeout).
 * @returns `ran`: a tool ran to a clean or issues verdict (false on no tool, guard
 *   failure, spawn error/signal or skip verdict); `finding`: the issues, else null. `{ ran: false, finding: null }`
 *   also when `coalesceProjectCheck` skipped the run (a completed run already covers the file).
 */
async function runChainLint(lang: LangEntry, resolved: string, cwd: string, rel: string, coalesce = false): Promise<ChainResult> {
  const none = NO_CHAIN;
  const plan = planChainLint(lang, resolved, cwd);
  if (!plan) return none;
  const { tool, argv, timeout, spawnCwd, manifest } = plan;
  const spawnOpts = buildSpawnOpts(spawnCwd, timeout);
  const spawnTool = (): Promise<SpawnSyncReturns<string>> => runLintTool(tool, argv, spawnOpts, plan.local);
  // Directory- and crate-scoped tools check the whole package/crate: one run per FileChanged burst covers every file.
  const key = coalesce ? (tool.targetsDir ? hashPath(`${tool.name}:${path.dirname(resolved)}`) : manifest ? hashPath(`${tool.name}:${manifest}`) : null) : null;
  const result = key ? await coalesceProjectCheck(key, resolved, timeout, spawnTool) : await spawnTool();
  const outcome = chainOutcome(tool, result);
  if (!outcome) return none;

  // Cargo entries are neither file-scoped nor targetsDir: the natural target
  // is the crate directory (the dir containing the resolved Cargo.toml). The
  // gate above guarantees `manifest` is non-null here.
  const target = chainTarget(tool, manifest, cwd, resolved);
  const { verdict, text } = outcome;
  if (verdict === "skip") return none;
  // cargo prints paths relative to the crate (or workspace) root, go tools get the package dir, the rest run in cwd.
  const base = manifest ? path.dirname(manifest) : tool.targetsDir ? path.dirname(resolved) : spawnCwd;
  return { ran: true, finding: verdict === "issues" ? { tool: tool.name, target, text, base } : null };
}

/**
 * tsc's per-diagnostic location line always anchors to the checked file:
 * "<path>:<line>:<col> - error TS<code>: <message>" (verified against the
 * native 7.0.2 compiler's own output). A pure project/config-loading failure
 * (broken `extends`, invalid compiler-option value, nonexistent tsconfig
 * path -- verified empirically: TS5083/TS6046/TS5058) either carries no
 * location at all or anchors to tsconfig.json itself, never to a
 * .ts/.tsx/.mts/.cts source file -- so this regex only matches when tsc
 * actually reached and diagnosed real project source. A tsconfig-loading
 * failure alongside a genuine source diagnostic (e.g. a broken `extends`
 * PLUS a real type error in the checked file) still matches, since tsc
 * reports both and this only needs one true location to fire.
 */
const TSC_SOURCE_DIAGNOSTIC_RE = /\.(?:ts|tsx|mts|cts)[:(]\d+/;
/** ANSI SGR escape sequences (colour codes), stripped before matching tool output. */
// eslint-disable-next-line no-control-regex -- stripping ANSI SGR sequences from colorized tool output
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;
/**
 * Whether tsc's output holds a diagnostic anchored to a real source file (see TSC_SOURCE_DIAGNOSTIC_RE).
 *
 * @param text - Combined tsc output.
 * @returns True when a diagnostic is anchored to a real source file.
 */
export function tscOutputHasSourceDiagnostic(text: string): boolean {
  const plain = text.replace(ANSI_SGR_RE, "");
  return TSC_SOURCE_DIAGNOSTIC_RE.test(plain);
}

/**
 * Run tsc against the whole project governed by the nearest tsconfig.json
 * (tsc has no single-file mode with project context -- confirmed: "When
 * input files are specified on the command line, tsconfig.json files are
 * ignored"). Returns a finding (same {tool, target, text} shape as
 * runChainLint, so callers can treat both uniformly) only on a real "issues"
 * verdict; every other outcome (no tsconfig, no tsc binary, clean,
 * crashed/invalid-project run) returns null -- same silent-skip philosophy
 * as the rest of this file.
 * Async since F18: the sync preparation (`resolveTsconfig`, the cache dir, `onPath("tsc")`, the local bin) runs before
 * the spawn and is the only work done while a concurrent chain child already runs (a few ms, no spawn).
 *
 * @param resolved - Absolute path of the edited file.
 * @param cwd - Project root.
 * @param coalesce - FileChanged: run tsc through `coalesceProjectCheck`, once per burst and tsconfig.
 * @returns The finding, or null (also when `coalesceProjectCheck` skipped the run because a completed run covers the
 *   file).
 */
async function runTypeCheck(resolved: string, cwd: string, coalesce = false): Promise<Finding | null> {
  const tsconfigPath = resolveTsconfig(path.dirname(resolved), cwd);
  if (!tsconfigPath) return null;

  const cachePath = tsBuildInfoPathFor(tsconfigPath);
  try {
    mkdirSync(path.dirname(cachePath), { recursive: true });
  } catch {
    return null; // can't create the cache dir -- fail open, no cache-less fallback
  }

  // Most real TS projects only have `typescript` as a local devDependency
  // (node_modules/.bin usually isn't on a hook's PATH) -- no npx fallback
  // here (see `.claude/rules/typescript-check.md`: the two-bin `typescript` package makes the
  // existing npx idiom's correctness unverified for this specific tool).
  const localTsc = path.join(cwd, "node_modules", ".bin", "tsc");
  const bin = onPath("tsc") ? "tsc" : existsSync(localTsc) ? localTsc : null;
  if (!bin) return null;
  const spawnTsc = (): Promise<SpawnSyncReturns<string>> => spawnGroup(bin, ["--noEmit", "--incremental", "--tsBuildInfoFile", cachePath, "-p", tsconfigPath], buildSpawnOpts(cwd, TSC_SPAWN_TIMEOUT_MS));
  const result = coalesce ? await coalesceProjectCheck(hashPath(`tsc:${tsconfigPath}`), resolved, TSC_SPAWN_TIMEOUT_MS, spawnTsc) : await spawnTsc();
  if (!result || result.error || result.signal) return null;
  if (classifyExit("tsc", result.status) !== "issues") return null;

  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  // Exit 1 alone doesn't distinguish a real source diagnostic from a pure
  // project/config-loading failure under TS7's native compiler (see
  // classifyExit's "tsc" case) -- exit 2 always meant a real diagnostic
  // already, both before and after that change, so only exit 1 needs the
  // extra content check.
  if (result.status === 1 && !tscOutputHasSourceDiagnostic(text)) return null;

  return {
    tool: "tsc",
    target: path.relative(cwd, path.dirname(tsconfigPath)) || ".",
    text,
    base: cwd,
  };
}

/**
 * True when `rel` (already resolved inside cwd) is dependency/VCS state
 * (node_modules/vendor/.git, unchanged) or Claude-Code-owned session/worktree
 * machinery that happens to sit inside cwd -- a nested git worktree
 * (.claude/worktrees/…) or an agent's local runtime scratch state
 * (.claude/agent-memory/…, both gitignored in this repo's own .claude/.gitignore)
 * is never real project content, so it's skipped the same way node_modules is.
 * This repo's own tracked .claude/rules|agents|skills stay covered -- only
 * these two specific subtrees are Claude-Code-internal, not `.claude/` as a
 * whole. `*.local.*` (personal local-override files, e.g. settings.local.json)
 * is skipped regardless of location, matching the same naming convention.
 *
 * @param rel - Path relative to cwd.
 * @returns True when the path is excluded from linting.
 */
export function isExcludedPath(rel: string): boolean {
  const segments = rel.split(path.sep);
  if (segments.some((s) => s === "node_modules" || s === "vendor" || s === ".git")) return true;
  if (segments.some((s, i) => s === ".claude" && (segments[i + 1] === "worktrees" || segments[i + 1] === "agent-memory"))) return true;
  return segments[segments.length - 1].includes(".local.");
}

/**
 * realpath of `p`; for a missing path, the nearest existing ancestor's realpath joined with the missing rest (port of
 * dprint's `realish`).
 *
 * @param p - Absolute path.
 * @returns The real path.
 * @throws When `p` itself exists but cannot be resolved (a dangling symlink), or on any non-ENOENT error.
 */
function realish(p: string): string {
  try {
    return realpathSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    try {
      lstatSync(p);
    } catch {
      const dir = path.dirname(p);
      return dir === p ? p : path.join(realish(dir), path.basename(p));
    }
    throw e; // p itself exists: a dangling symlink
  }
}

/** The payload's `scratchpad_dir` when it is a string, else undefined. */
function scratchpadOf(args: PostToolUseHookInput): string | undefined {
  return typeof args.scratchpad_dir === "string" ? args.scratchpad_dir : undefined;
}

/**
 * Whether a `path.relative(root, p)` result leaves `root` (`..`, `../x`, or another root).
 *
 * @param rel - Relative path from the root.
 * @returns True when `p` lies outside the root.
 */
function outside(rel: string): boolean {
  return rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
}

/**
 * The real-path scope rule shared by every event (dprint's `inScope`): `file` resolved against `cwd` must have a
 * lintable extension (checked first, pure string work before any filesystem call), exist, its real path must lie
 * strictly inside realpath(cwd), not be excluded (`isExcludedPath` on the path relative to the real cwd), not lie inside
 * realpath(scratchpad) when given, and not be a dangling link.
 *
 * @param cwd - Payload cwd (the scope root; never `process.cwd()`).
 * @param file - Absolute or cwd-relative path.
 * @param scratchpad - The session's `scratchpad_dir`, when the payload has one.
 * @param roots - Pre-resolved `realish(cwd)` / `realish(scratchpad)`, so a caller scoping many files resolves them once.
 *   `dirs` (only `watchList` passes it, a fresh map per call) memoizes lexical dirname -> `realish(dirname)`: one lstat
 *   per file, a non-symlink leaf's real path is `realish(dirname)/basename`, a symlinked leaf takes the full `realish`,
 *   and a missing leaf is out of scope. Same results as without it.
 * @returns `{ fp, real }` (lexical absolute path, real path) or null when out of scope.
 */
export function scopedTarget(cwd: string, file: string, scratchpad?: string, roots?: { cwd: string; scratchpad?: string; dirs?: Map<string, string> }): { fp: string; real: string } | null {
  try {
    const fp = path.resolve(cwd, file);
    const ext = path.extname(fp).toLowerCase();
    if (!EXT_MAP[ext] && !TYPE_CHECK_EXTS.has(ext)) return null;
    let real: string;
    if (roots?.dirs) {
      // A non-symlink lstat hit proves existence and makes realish(dirname)/basename equal realish(fp).
      const st = lstatSync(fp, { throwIfNoEntry: false });
      if (!st) return null;
      if (st.isSymbolicLink()) {
        real = realish(fp);
      } else {
        const dir = path.dirname(fp);
        let dirReal = roots.dirs.get(dir);
        if (dirReal === undefined) {
          dirReal = realish(dir);
          roots.dirs.set(dir, dirReal);
        }
        real = path.join(dirReal, path.basename(fp));
      }
    } else {
      real = realish(fp);
    }
    const rel = path.relative(roots?.cwd ?? realish(cwd), real);
    if (rel === "" || outside(rel) || isExcludedPath(rel)) return null;
    if (scratchpad) {
      const rs = roots ? roots.scratchpad ?? realish(scratchpad) : realish(scratchpad);
      if (real === rs || real.startsWith(rs + path.sep)) return null;
    }
    if (!roots?.dirs && !existsSync(fp)) return null;
    return { fp, real };
  } catch {
    return null;
  }
}

/**
 * PostToolUse entry guards (success !== false, non-empty cwd and tool_input.file_path) then `scopedTarget`.
 *
 * @param args - The PostToolUse hook payload.
 * @returns `{ fp, real }` or null when a guard rejects or on any error.
 */
function postToolScope(args: PostToolUseHookInput): { fp: string; real: string } | null {
  try {
    if (args?.tool_response?.success === false) return null;
    const cwd = typeof args?.cwd === "string" ? args.cwd : "";
    const fp = args?.tool_input?.file_path;
    if (!cwd || typeof fp !== "string" || !fp) return null;
    return scopedTarget(cwd, fp, scratchpadOf(args));
  } catch {
    return null;
  }
}

/**
 * Run every cheap entry guard and return the resolved absolute lint target, or null when any guard rejects
 * (success===false, missing cwd/file_path, or `scopedTarget` rejects: outside the real cwd, excluded, inside
 * `scratchpad_dir`, dangling link, unsupported extension, file absent). Used by lintFileHandler; the skill driver's lintFilesHandler
 * scopes through `scopedTarget` directly and must be kept in step. Fails closed to null on any unexpected error, matching lintFileHandler's fail-open-to-{} philosophy.
 *
 * @param args - The PostToolUse hook payload.
 * @returns The lexical absolute path to lint, or null when a guard rejects.
 */
export function resolveLintTarget(args: PostToolUseHookInput): string | null {
  return postToolScope(args)?.fp ?? null;
}

/**
 * Inclusive 0-based line ranges an Edit changed, from the `structuredPatch` hunks of its tool_response: each run of
 * `+` lines, and for a run of only `-` lines (pure deletion) the two lines around the deletion point.
 *
 * @param args - The PostToolUse hook payload.
 * @returns The ranges, or null when the whole file counts as edited (Write, other tool, missing or malformed patch).
 */
export function editRanges(args: PostToolUseHookInput): Array<[number, number]> | null {
  const patch = args?.tool_response?.structuredPatch;
  if (args?.tool_name !== "Edit" || !Array.isArray(patch)) return null;
  const ranges: Array<[number, number]> = [];
  for (const h of patch as Array<{ newStart?: unknown; lines?: unknown }>) {
    if (typeof h?.newStart !== "number" || !Array.isArray(h.lines)) return null;
    let cur = h.newStart - 1;
    let start = -1;
    let deleted = false;
    const flush = (): void => {
      if (start !== -1) ranges.push([start, cur - 1]);
      else if (deleted) ranges.push([Math.max(cur - 1, 0), Math.max(cur, 0)]);
      start = -1;
      deleted = false;
    };
    for (const l of h.lines as unknown[]) {
      const c = typeof l === "string" ? l[0] : " ";
      if (c === "+") {
        if (start === -1) start = cur;
        cur++;
      } else if (c === "-") deleted = true;
      else if (c !== "\\") {
        // context line; `\ No newline at end of file` is not a line
        flush();
        cur++;
      }
    }
    flush();
  }
  return ranges;
}

/** Default length of the settle window (ms): findings are held this long before they are reported (F34). */
export const SETTLE_MS = 5000;

/**
 * Length of the hold for this process: `UNIVERSAL_LINT_SETTLE_MS` (a finite number >= 0; a test and perf-harness seam,
 * not a user setting) else `SETTLE_MS`, cut so the hold ends at least 1 s before the 90 s hook backstop.
 *
 * @param uptimeMs - Process uptime in ms (injectable for tests).
 * @returns Milliseconds to wait, never negative.
 */
export function settleWaitMs(uptimeMs: number = process.uptime() * 1000): number {
  const raw = process.env.UNIVERSAL_LINT_SETTLE_MS;
  const n = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  const base = Number.isFinite(n) && n >= 0 ? n : SETTLE_MS;
  return Math.max(0, Math.min(base, HOOK_TIMEOUT_MS - 1000 - uptimeMs));
}

/** One `structuredPatch` hunk with the old-line map the settle window's supersession needs. */
export interface EditHunk {
  /** 1-based first old line as in the patch (the line before the hunk when it has no old lines). */
  oldStart: number;
  /** Old-side lines walked (context and removed). */
  oldLines: number;
  /** 1-based first new line as in the patch. */
  newStart: number;
  /** New-side lines walked (context and added). */
  newLines: number;
  /** One entry per old-side line: its new 0-based line, or -1 when the edit removed it. */
  map: number[];
}

/**
 * The hunks of an Edit with the old-to-new line map of each (the data `editRanges` reads, kept per old line).
 *
 * @param args - The PostToolUse hook payload.
 * @returns The hunks, or null when the whole file counts as edited (Write, other tool, missing or malformed patch).
 */
export function editHunks(args: PostToolUseHookInput): EditHunk[] | null {
  const patch = args?.tool_response?.structuredPatch;
  if (args?.tool_name !== "Edit" || !Array.isArray(patch)) return null;
  const hunks: EditHunk[] = [];
  for (const h of patch as Array<{ oldStart?: unknown; newStart?: unknown; lines?: unknown }>) {
    if (typeof h?.oldStart !== "number" || typeof h.newStart !== "number" || !Array.isArray(h.lines)) return null;
    const map: number[] = [];
    let next = h.newStart - 1;
    for (const l of h.lines as unknown[]) {
      const c = typeof l === "string" ? l[0] : " ";
      if (c === "\\") continue; // `\ No newline at end of file` is not a line
      if (c === "-") map.push(-1);
      else if (c === "+") next++;
      else map.push(next++);
    }
    hunks.push({ oldStart: h.oldStart, oldLines: map.length, newStart: h.newStart, newLines: next - (h.newStart - 1), map });
  }
  return hunks;
}

/**
 * Where an old line sits after an edit.
 *
 * @param line - 0-based line before the edit.
 * @param hunks - The edit's hunks in file order.
 * @returns The 0-based line after the edit, or null when the edit removed or replaced it.
 */
export function carryLine(line: number, hunks: readonly EditHunk[]): number | null {
  let shift = 0;
  for (const h of hunks) {
    const start = h.oldLines === 0 ? h.oldStart : h.oldStart - 1; // a hunk without old lines names the line before it
    if (line < start) break;
    if (line < start + h.oldLines) {
      const n = h.map[line - start];
      return n < 0 ? null : n;
    }
    shift += h.newLines - h.oldLines;
  }
  return line + shift;
}

/**
 * Location regex A: `<path>.<ext>:<line>` or `<path>.<ext>(<line>` (ruff, ktlint, golangci-lint, go vet, checkstyle,
 * markdownlint, psalm, oxlint `,-[src/a.ts:3:7]`, cargo `--> src/a.rs:12:5`, tsc `a.ts(12,5)` / `a.ts:12:5`).
 * Anchored at a token start by the lookbehind: the unanchored form was quadratic on a long whitespace-free line (F27).
 */
const LOC_PATH_RE = /(?<![^\s:()[\]'"])(?<path>[^\s:()[\]'"]+\.[A-Za-z0-9]+)[:(](?<line>\d+)(?:[:,]\d+)?/;
/** Location regex B: path-less `  <line>:<col>  ` rows (eslint/stylelint stylish, yamllint standard). */
const LOC_ROW_RE = /^\s*(?<line>\d+):\d+\s/;
/** Location regex C: shellcheck's default tty header `In <file> line <line>:` (path-less: the edited file is its only target). */
const LOC_SHELLCHECK_RE = /^In .+ line (?<line>\d+):/;

/**
 * Parse/syntax error wording (plus tsc's TS1xxx and shellcheck's SC1xxx parser codes). An edit-caused parse error is
 * often reported away from the edit (unclosed brace -> EOF), so such a diagnostic is kept even outside the range.
 * shortcut: wording heuristic, a tool phrasing parse errors differently is still gated; extend the list when one shows up.
 */
const PARSE_ERROR_RE = /pars(?:e|ing) error|syntax ?error|unexpected (?:token|end|eof|character|indent)|unterminated|unclosed|end of (?:file|input)|\bexpected [`'"]|\b(?:TS1|SC1)\d{3}\b/i;

/**
 * Drop the diagnostics of `finding` located in `resolved` outside `ranges`. Text is split into blank-line paragraphs;
 * a paragraph's located lines start segments that carry the unlocated lines after them (lines before the first one
 * are the preamble). Own-file misses are dropped unless the segment or the preamble reads as a parse error
 * (`PARSE_ERROR_RE`); hits and foreign locations (a path not tied to `resolved`) are kept
 * and reportable. A paragraph whose segments are all dropped loses its preamble too; unlocated paragraphs are kept but
 * not reportable. existsSync results are memoized per call.
 *
 * @param finding - One tool's finding.
 * @param ranges - Inclusive 0-based edited line ranges, null when every line counts as edited, or a predicate on the
 *   0-based line that says whether a diagnostic located there is kept (the settle window's "line survives" test).
 * @param resolved - Absolute path of the edited file.
 * @param keepParseErrors - Keep an own-file parse error that misses `ranges` (default). The settle window turns it off:
 *   a parse error on a line a later edit rewrote must not survive.
 * @returns The finding with only the kept text, `finding` itself when no line is located (unknown format, fail open),
 *   or null when nothing reportable remains.
 */
export function gateFinding(finding: Finding, ranges: Array<[number, number]> | null | ((line0: number) => boolean), resolved: string, keepParseErrors = true): Finding | null {
  const seen = new Map<string, boolean>();
  /** Memoized `existsSync` for this call (the filesystem is stable within one call). */
  const exists = (abs: string): boolean => {
    let found = seen.get(abs);
    if (found === undefined) {
      found = existsSync(abs);
      seen.set(abs, found);
    }
    return found;
  };
  const hit = (line: number): "hit" | "miss" => (ranges === null || (typeof ranges === "function" ? ranges(line - 1) : ranges.some(([s, e]) => s <= line - 1 && line - 1 <= e)) ? "hit" : "miss");
  const classify = (raw: string): "hit" | "miss" | "foreign" | null => {
    const plain = raw.replace(ANSI_SGR_RE, "");
    const row = LOC_ROW_RE.exec(plain); // a stylish row first: its message text can look like `foo.bar(3)`
    if (row?.groups) return hit(Number(row.groups.line));
    const a = LOC_PATH_RE.exec(plain);
    if (a?.groups) {
      const p = path.normalize(a.groups.path);
      const abs = path.resolve(finding.base, p);
      // Suffix fallback only when the base-resolved path is not a real file, so a same-named other file stays foreign.
      // The pure endsWith test goes first so foreign paths never stat the filesystem.
      const own = abs === resolved || (!path.isAbsolute(p) && resolved.endsWith(path.sep + p) && !exists(abs));
      return own ? hit(Number(a.groups.line)) : "foreign";
    }
    const b = LOC_SHELLCHECK_RE.exec(plain);
    return b?.groups ? hit(Number(b.groups.line)) : null;
  };

  let located = false;
  let reportable = false;
  const kept: string[] = [];
  for (const para of finding.text.split(/\n\s*\n/)) {
    const lines = para.split("\n");
    const kinds = lines.map(classify);
    const starts = kinds.flatMap((k, i) => (k === null ? [] : [i]));
    if (starts.length === 0) {
      kept.push(para);
      continue;
    }
    located = true;
    const out = lines.slice(0, starts[0]);
    let any = false;
    const preambleParse = PARSE_ERROR_RE.test(out.join("\n"));
    starts.forEach((start, n) => {
      const seg = lines.slice(start, starts[n + 1] ?? lines.length);
      if (kinds[start] === "miss" && !(keepParseErrors && (preambleParse || PARSE_ERROR_RE.test(seg.join("\n"))))) return;
      out.push(...seg);
      any = true;
    });
    if (any) {
      kept.push(out.join("\n"));
      reportable = true;
    }
  }
  if (!located) return finding;
  return reportable ? { ...finding, text: kept.join("\n\n") } : null;
}

/**
 * File holding the SHA-256 (base64) of the content Write/Edit last left at `real`:
 * `CLAUDE_PLUGIN_DATA` (OS temp dir when unset)/written/<hashPath(real)>. Never inside the project tree.
 *
 * @param real - Real path of the written file.
 * @returns Absolute path of the digest file.
 */
function writtenDigestPath(real: string): string {
  return path.resolve(process.env.CLAUDE_PLUGIN_DATA || tmpdir(), "written", hashPath(real));
}

/**
 * SHA-256 base64 of a file's bytes.
 *
 * @param fp - File to hash.
 * @returns Base64 digest.
 */
function fileDigest(fp: string): string {
  return createHash("sha256").update(readFileSync(fp)).digest("base64");
}

/**
 * Record the on-disk content digest of a Write/Edit target, atomically (temp file + renameSync), so a FileChanged
 * process can skip the file while its content still matches. One file per real path: concurrent hook processes need
 * no locking. Fails open silently (cost: one duplicate lint, never a lost one).
 *
 * @param fp - Lexical path of the written file (read for the digest).
 * @param real - Real path of the written file (the digest key).
 */
export function recordWritten(fp: string, real: string): void {
  try {
    const file = writtenDigestPath(real);
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, fileDigest(fp));
    renameSync(tmp, file);
  } catch {
    // fail open: a missing digest costs one duplicate lint
  }
}

/**
 * PostToolUse digest step: `recordWritten` for the already-scoped target. Runs before the lint so the digest lands
 * within milliseconds. Never throws.
 *
 * @param s - The `postToolScope` result, or null.
 */
function recordWrittenFor(s: { fp: string; real: string } | null): void {
  if (s) recordWritten(s.fp, s.real);
}

/**
 * SHA-256 base64 of a file, or null when it cannot be read.
 *
 * @param fp - File to hash.
 * @returns The digest, or null.
 */
function digestOrNull(fp: string): string | null {
  try {
    return fileDigest(fp);
  } catch {
    return null;
  }
}

/** Handle of the journal record a lint wrote for its own edit (F34). */
export interface EditRecord {
  /** `hashPath` of the file's real path: the record files of one file share this prefix. */
  key: string;
  /** File name of the record inside the journal directory. */
  name: string;
}

/**
 * Settle-window journal directory: `CLAUDE_PLUGIN_DATA` (OS temp dir when unset)/settle. Never inside the project tree.
 *
 * @returns Absolute path of the directory.
 */
function settleDir(): string {
  return path.resolve(process.env.CLAUDE_PLUGIN_DATA || tmpdir(), "settle");
}

/**
 * Journal one edit of a file for the settle window: `<hashPath(real)>-<ms>-<pid>.json` holding the edit's hunks (null =
 * whole file) and the digest of the file after it, written atomically (temp file + `renameSync`). Older entries
 * (name timestamp more than `HOOK_TIMEOUT_MS` ago, temp leftovers too) are pruned first, so a live reader still
 * finds everything a hook run can need. Fails open to null (the lint then reports at once).
 *
 * @param fp - Lexical path of the edited file (read for the digest).
 * @param real - Real path of the file (the key).
 * @param hunks - The edit's hunks, null when the whole file counts as edited.
 * @returns The record handle, or null on any error.
 */
export function recordEdit(fp: string, real: string, hunks: EditHunk[] | null): EditRecord | null {
  try {
    const dir = settleDir();
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    for (const n of readdirSync(dir)) if (now - Number(n.split("-")[1]) > HOOK_TIMEOUT_MS) rmSync(path.join(dir, n), { force: true });
    const key = hashPath(real);
    const name = `${key}-${String(now).padStart(15, "0")}-${process.pid}.json`;
    const tmp = path.join(dir, `${name}.tmp`);
    writeFileSync(tmp, JSON.stringify({ hunks, digest: fileDigest(fp) }));
    renameSync(tmp, path.join(dir, name));
    return { key, name };
  } catch {
    return null;
  }
}

/**
 * The settle window (F34): hold the findings of a finished lint for `settleWaitMs()`, then drop every diagnostic
 * located in `resolved` on a line a later edit of the file removed or replaced (that edit's own lint reports what
 * persists there). Diagnostics in other files and findings without a located line are never dropped.
 *
 * @remarks
 * Coordinates: the finding's lines are those of the file as the linter read it, whose digest is `d0`. The reference
 * is the last journal record with `digest === d0`; only the records after it are later edits. A file that changed
 * during the lint (`d0 !== d1`), no matching record, no later record, a missing or unreadable journal or record
 * all mean "cannot tell": the findings are returned as they are (fail open, reported). Nothing is held when there is
 * nothing to report or no own record.
 *
 * @param findings - The gated findings of the lint.
 * @param resolved - Lexical absolute path of the linted file.
 * @param rec - The lint's own journal record, or null.
 * @param d0 - Digest of the file right before the lint started, or null.
 * @param d1 - Digest of the file right after the lint ended, or null.
 * @returns The findings that survive (possibly fewer diagnostics per finding).
 */
export async function settleFindings(findings: Finding[], resolved: string, rec: EditRecord | null, d0: string | null, d1: string | null): Promise<Finding[]> {
  if (findings.length === 0 || !rec || d0 === null || d0 !== d1) return findings;
  const wait = settleWaitMs();
  if (wait > 0) await sleep(wait);
  let later: Array<EditHunk[] | null>;
  try {
    const dir = settleDir();
    const recs = readdirSync(dir)
      .filter((n) => n.startsWith(`${rec.key}-`) && n.endsWith(".json"))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((n) => JSON.parse(readFileSync(path.join(dir, n), "utf8")) as { hunks: EditHunk[] | null; digest: string });
    if (recs.some((r) => r.hunks !== null && !Array.isArray(r.hunks))) return findings;
    let at = -1;
    recs.forEach((r, i) => {
      if (r.digest === d0) at = i;
    });
    if (at === -1 || at === recs.length - 1) return findings;
    later = recs.slice(at + 1).map((r) => r.hunks);
  } catch {
    return findings;
  }
  const survives = (line0: number): boolean => {
    let l = line0;
    for (const h of later) {
      if (h === null) return false;
      const n = carryLine(l, h);
      if (n === null) return false;
      l = n;
    }
    return true;
  };
  return findings.flatMap((f) => {
    const g = gateFinding(f, survives, resolved, false);
    return g ? [g] : [];
  });
}

/**
 * The chain entry for one file (shared by `lintResolved` and `lintFilesHandler`): the language from `EXT_MAP`, the
 * no-config gates for JS/TS (no oxlint and no eslint config) and CSS/SCSS (no stylelint config), and for JS/TS with an
 * oxlint config the `REGISTRY.oxlint` chain with `-c <config>` appended.
 *
 * @param resolved - Absolute path of the file.
 * @param cwd - Project root (config search root).
 * @returns `entry`: the chain to run, null when the file has no language or a no-config gate applies;
 *   `oxlintConfig`: the selecting oxlint config (JS/TS only), else null.
 */
function chainEntryFor(resolved: string, cwd: string): { entry: LangEntry | null; oxlintConfig: string | null } {
  const ext = path.extname(resolved).toLowerCase();
  const lang = EXT_MAP[ext];
  const oxlintConfig = lang === "jsts" ? resolveOxlintConfig(path.dirname(resolved), cwd) : null;
  // No oxlint config and no eslint name up to / (eslint's own lookup): eslint would only exit 2 (skip), so no chain lint.
  const noJstsConfig = lang === "jsts" && !oxlintConfig && !walkToRoot(path.dirname(resolved), (d) => anyConfigExists(d, ESLINT_CONFIG_FILENAMES));
  // No stylelint config (stylelint's own search places, see hasStylelintConfig): stylelint would only exit 78 (skip), so no chain lint.
  const noCssConfig = lang === "css" && !hasStylelintConfig(path.dirname(resolved), cwd);
  if (!lang || noJstsConfig || noCssConfig) return { entry: null, oxlintConfig };
  // -c makes the detected config oxlint's root: oxlint ignores a nested
  // oxlint.config.ts and rejects options.typeAware in a nested config otherwise.
  const entry = oxlintConfig ? { chain: REGISTRY.oxlint.chain.map((t) => ({ ...t, args: [...t.args, "-c", oxlintConfig] })) } : REGISTRY[lang];
  return { entry, oxlintConfig };
}

/** Outcome of `runChainLint`; see there. */
type ChainResult = { ran: boolean; finding: Finding | null };
const NO_CHAIN: ChainResult = { ran: false, finding: null };

/**
 * Whether tsc must run for a file: it is type-check eligible and no oxlint run with a `typeCheck: true` config
 * covered it (`chainRan`: the chain tool reached a clean or issues verdict). The one skip rule, shared by `lintResolved`
 * and `lintFilesHandler`.
 */
function tscNeeded(typeCheckEligible: boolean, oxlintConfig: string | null, chainRan: boolean): boolean {
  return typeCheckEligible && !(oxlintConfig !== null && chainRan && oxlintConfigTypeChecks(oxlintConfig));
}

/**
 * Lint `resolved` (chain tool from `chainEntryFor` unless JS/TS or CSS/SCSS has no lint config, run by `runChainLint`,
 * + tsc) and gate the findings against `ranges` (null = whole file). The caller settles them (`settleFindings`) and
 * formats them (`formatFindings`); no lock or slot is needed past this point.
 *
 * @remarks
 * tsc is decided up front (F18): for a type-check-eligible file whose oxlint config does not type-check (or that has
 * no oxlint config) the chain and tsc run at once with `Promise.all` (findings order chain then tsc). With an oxlint
 * `typeCheck: true` config the chain runs first and tsc only when oxlint did not run (`!chain.ran`), never
 * speculatively. This is the same predicate as the sequential rule: tsc iff `typeCheckEligible &&
 * !(oxlintConfig && chain.ran && oxlintConfigTypeChecks(oxlintConfig))`. Neither branch rejects except on a throw in a
 * sync preamble (`planChainLint`, `resolveTsconfig`, `onPath`), which lands in the handler's catch (`{}`) as before;
 * `Promise.all` then discards the other side's result and that child runs to its own end or timeout (bounded by its
 * `*_SPAWN_TIMEOUT_MS` + `KILL_GRACE_MS`) before the event loop drains and the process exits (exit code 0, no output).
 * `Promise.allSettled` was rejected at spec approval as a fail-open change.
 *
 * @param resolved - Lexical absolute path of the in-scope file.
 * @param cwd - Payload cwd (spawn cwd and config search root).
 * @param ranges - Edited line ranges, or null when the whole file counts.
 * @param hookEventName - The event name; `"FileChanged"` also enables `coalesceProjectCheck` for the whole-project check.
 * @returns The gated findings (empty when clean, skipped or all outside the edit).
 */
async function lintResolved(resolved: string, cwd: string, ranges: Array<[number, number]> | null, hookEventName: string): Promise<Finding[]> {
  const rel = path.relative(cwd, resolved);
  const coalesce = hookEventName === "FileChanged";
  const ext = path.extname(resolved).toLowerCase();
  const typeCheckEligible = TYPE_CHECK_EXTS.has(ext);
  const { entry, oxlintConfig } = chainEntryFor(resolved, cwd);

  const chainP: Promise<ChainResult> = entry ? runChainLint(entry, resolved, cwd, rel, coalesce) : Promise.resolve(NO_CHAIN);
  let chain: ChainResult;
  let tsResult: Finding | null = null;
  // tsc needed even when the chain runs fine (no oxlint typeCheck config): start it at once.
  if (tscNeeded(typeCheckEligible, oxlintConfig, true)) {
    // tsc does not depend on the chain outcome: run both at once (each keeps its own timeout).
    [chain, tsResult] = await Promise.all([chainP, runTypeCheck(resolved, cwd, coalesce)]);
  } else {
    chain = await chainP;
    if (tscNeeded(typeCheckEligible, oxlintConfig, chain.ran)) tsResult = await runTypeCheck(resolved, cwd, coalesce);
  }
  const findings: Finding[] = [];
  if (chain.finding) findings.push(chain.finding);
  if (tsResult) findings.push(tsResult);
  // Gate before truncate() so the context budget is spent on in-range text.
  const kept = findings.flatMap((f) => {
    const g = gateFinding(f, ranges, resolved);
    return g ? [g] : [];
  });
  return kept;
}

/**
 * The hook result for the findings that survived the settle window.
 *
 * @param kept - The findings to report (possibly empty).
 * @param hookEventName - `hookSpecificOutput.hookEventName` of the result.
 * @param label - Prefix of the findings text (`<label>: <findings>`).
 * @returns The hook result: findings as additionalContext, or an empty object.
 */
function formatFindings(kept: Finding[], hookEventName: string, label: string): HookResult {
  if (kept.length === 0) return {};
  // truncate() is applied per-finding first (so a single finding's own text
  // is capped exactly as before this change), then AGAIN over the joined
  // whole -- two per-finding-capped blocks can still together exceed
  // MAX_CONTEXT_CHARS when both are near the cap; the outer pass restores a
  // hard whole-message ceiling. Idempotent/no-op for the single-finding
  // case (already <= MAX_CONTEXT_CHARS from its own inner truncate()), so
  // single-finding output is unchanged from before this change.
  const blocks = kept.map((f) => `${f.tool} found issues in ${f.target}:\n${truncate(f.text)}`);
  return {
    hookSpecificOutput: {
      hookEventName,
      additionalContext: `${label}: ${truncate(blocks.join("\n\n"))}`,
    },
  };
}

/**
 * The lint_file tool handler (PostToolUse Write|Edit). Resolves to {} on every guard failure / clean / skip or rejection (fail open); async since F18.
 *
 * @remarks
 * Settle window (F34): the edit is journaled (`recordEdit`, also when the lint is clean), the lint runs between two
 * digests of the file (`d0`, `d1`), and its findings are held and filtered by `settleFindings` before they are
 * formatted. Takes no slot or lock.
 *
 * @param args - The PostToolUse hook payload.
 * @returns The hook result: findings as additionalContext, or an empty object.
 */
export async function lintFileHandler(args: PostToolUseHookInput, scoped: { fp: string; real: string } | null = postToolScope(args)): Promise<HookResult> {
  try {
    const resolved = scoped?.fp;
    if (!scoped || !resolved) return {};
    const ranges = editRanges(args);
    if (ranges?.length === 0) return {}; // the Edit changed nothing
    const rec = recordEdit(resolved, scoped.real, editHunks(args));
    const d0 = digestOrNull(resolved);
    // `await` inside the try is load-bearing: a rejected promise must land in the catch (fail open).
    const kept = await lintResolved(resolved, args.cwd, ranges, "PostToolUse");
    const d1 = kept.length > 0 ? digestOrNull(resolved) : null; // only a held finding needs the second digest
    return formatFindings(await settleFindings(kept, resolved, rec, d0, d1), "PostToolUse", "universal-lint");
  } catch {
    return {};
  }
}

/**
 * Batch entry of the universal-lint skill driver: lint `files` with the hook's own resolution, one chain-tool run per
 * group of files and one tsc run per tsconfig, and return one findings block per run.
 *
 * @remarks
 * Read-only and whole-file: no edit-range gate (`gateFinding` is not called), no `coalesceProjectCheck`. Every file is
 * scoped once with `scopedTarget` against one pre-resolved `realish(cwd)` (no scratchpad exclusion, as the driver
 * never had one); a path listed twice is linted once. Each in-scope file is planned with `chainEntryFor` and
 * `planChainLint` and grouped by tool name, local bin, spawn cwd and argv: file-scoped tools by the argv minus its
 * trailing file target, so files with different config-derived argv (markdownlint/yamllint guards, oxlint `-c`)
 * never share a run; go (`targetsDir`) and cargo (`manifestPath`) by the full argv, one run per package dir or crate
 * without extra targets. A file-scoped group spawns once per chunk of at most `BATCH_MAX_FILES` files with all chunk
 * files appended as targets, through `runLintTool` and the unchanged per-spawn timeout; `chainOutcome` classifies it.
 * An `issues` run becomes the block `universal-lint: <tool> found issues in <targets>:\n<truncate(text)>` (cap MAX_CONTEXT_CHARS times the files of the run; the tsc block keeps MAX_CONTEXT_CHARS), where
 * `<targets>` joins the run's unique per-file targets with `", "` (the file, the package dir, or the crate dir,
 * relative to `cwd`) and names every file of the run, including those the tool found clean.
 * Fail-open per file: a multi-file chunk whose run is a skip verdict, spawn error, signal or timeout is rerun one file at a
 * time with each file's own argv (at most `BATCH_MAX_FILES` single spawns per chunk, each under the unchanged per-spawn
 * timeout); a file whose single run is also a skip contributes nothing. A multi-file chunk whose run ends in a spawn
 * error, signal or timeout is rerun the same way (one batch plus at most BATCH_MAX_FILES single spawns per chunk, so a
 * pathological file costs its own timeout a second time and is then the only file dropped). tsc runs through `runTypeCheck` once per distinct `resolveTsconfig` result, with
 * the group's first file; a file is left out, as in `lintResolved`, when its oxlint run (its chunk or its single
 * rerun) reached a clean or issues verdict with a config whose `options.typeCheck` is true. The tsc block carries the
 * ungated whole-project output once per tsconfig. Any throw drops only the file, chunk or tsconfig group it happened
 * in. Async since F18 (the driver awaits it): still one spawn at a time, each a detached process group killed as a whole on timeout.
 *
 * @param cwd - Project root: scope root, config search root and default spawn cwd.
 * @param files - Absolute or cwd-relative paths to lint, in report order.
 * @returns The findings blocks, chain runs in first-appearance group order followed by tsc runs in tsconfig order;
 *   `[]` when nothing was found or `cwd` cannot be resolved.
 */
export async function lintFilesHandler(cwd: string, files: readonly string[]): Promise<string[]> {
  let roots: { cwd: string };
  try {
    roots = { cwd: realish(cwd) };
  } catch {
    return []; // unresolvable cwd: nothing is in scope
  }
  const scoped = new Set<string>();
  for (const file of files) {
    const s = scopedTarget(cwd, file, undefined, roots);
    if (s) scoped.add(s.fp);
  }

  // Plan every file; group key = tool, local bin, spawn cwd and argv (minus the file target for file-scoped tools).
  const oxlintConfigs = new Map<string, string | null>();
  const groups = new Map<string, Array<{ fp: string; plan: ChainPlan }>>();
  for (const fp of scoped) {
    try {
      const { entry, oxlintConfig } = chainEntryFor(fp, cwd);
      const plan = entry ? planChainLint(entry, fp, cwd) : null;
      oxlintConfigs.set(fp, oxlintConfig);
      if (!plan) continue;
      const fileScoped = isFileScoped(plan.tool);
      const key = [plan.tool.name, plan.local ?? "", plan.spawnCwd, ...(fileScoped ? plan.argv.slice(0, -1) : plan.argv)].join("\0");
      const group = groups.get(key);
      if (group) group.push({ fp, plan });
      else groups.set(key, [{ fp, plan }]);
    } catch {
      // fail open: drop this file only
    }
  }

  const ran = new Set<string>();
  const chainBlocks: string[] = [];
  const spawnPlan = async (plan: ChainPlan, argv: string[]): Promise<ReturnType<typeof chainOutcome>> => chainOutcome(plan.tool, await runLintTool(plan.tool, argv, buildSpawnOpts(plan.spawnCwd, plan.timeout), plan.local));
  const record = (members: Array<{ fp: string; plan: ChainPlan }>, out: ReturnType<typeof chainOutcome>): void => {
    if (!out || out.verdict === "skip") return;
    for (const m of members) ran.add(m.fp);
    if (out.verdict !== "issues") return;
    const { tool, manifest } = members[0].plan;
    const targets = new Set(members.map(({ fp }) => chainTarget(tool, manifest, cwd, fp)));
    // One block now carries up to BATCH_MAX_FILES files: keep the old per-file budget so later files' findings are not cut.
    chainBlocks.push(`universal-lint: ${tool.name} found issues in ${[...targets].join(", ")}:\n${truncate(out.text, MAX_CONTEXT_CHARS * members.length)}`);
  };
  for (const group of groups.values()) {
    const { plan } = group[0];
    const fileScoped = isFileScoped(plan.tool);
    const step = fileScoped ? BATCH_MAX_FILES : group.length;
    for (let i = 0; i < group.length; i += step) {
      const chunk = group.slice(i, i + step);
      try {
        const argv = fileScoped ? [...plan.argv.slice(0, -1), ...chunk.map((m) => m.fp)] : plan.argv;
        const out = await spawnPlan(plan, argv);
        // Per-file fail-open: one unparsable or pathological file, a tool crash, kill or timeout must not drop the other files' findings.
        if ((!out || out.verdict === "skip") && fileScoped && chunk.length > 1) {
          for (const m of chunk) {
            try {
              record([m], await spawnPlan(m.plan, m.plan.argv));
            } catch {
              // fail open: drop this file only
            }
          }
        } else {
          record(chunk, out);
        }
      } catch {
        // fail open: drop this chunk only
      }
    }
  }

  // tsc once per tsconfig, with the first listed file it governs.
  const tsFirst = new Map<string, string>();
  for (const [fp, oxlintConfig] of oxlintConfigs) {
    try {
      if (!tscNeeded(TYPE_CHECK_EXTS.has(path.extname(fp).toLowerCase()), oxlintConfig, ran.has(fp))) continue;
      const tsconfig = resolveTsconfig(path.dirname(fp), cwd);
      if (tsconfig && !tsFirst.has(tsconfig)) tsFirst.set(tsconfig, fp);
    } catch {
      // fail open: drop this file only
    }
  }
  const tscBlocks: string[] = [];
  for (const fp of tsFirst.values()) {
    try {
      const f = await runTypeCheck(fp, cwd);
      if (f) tscBlocks.push(`universal-lint: ${f.tool} found issues in ${f.target}:\n${truncate(f.text)}`);
    } catch {
      // fail open: drop this tsconfig's block only
    }
  }
  return [...chainBlocks, ...tscBlocks];
}

/**
 * Whether a FileChanged slot file (also used for `fc-locks/<key>.lock`, see `coalesceProjectCheck`) may be removed:
 * stale when its mtime is `HOOK_TIMEOUT_MS` (90 s) or more ago, or
 * `HOOK_TIMEOUT_MS` or more in the future (clock jumped back, synced data dir), or its pid no longer exists
 * (`process.kill(pid, 0)` throws ESRCH). Held: pid alive, EPERM (alive, another user's process), or an empty or
 * unparsable pid (a holder between its `wx` create and its write, or a garbage file; the mtime decides). A missing or
 * unreadable slot is not stale (the following `wx` create decides).
 *
 * @param slot - Slot file path.
 * @returns True when the slot may be removed; false when held, missing or unreadable.
 */
function slotStale(slot: string): boolean {
  try {
    // Both directions: a fresh slot's sub-ms mtime can be ahead of integer Date.now(); the pid check covers small clock jumps.
    if (Math.abs(Date.now() - lstatSync(slot).mtimeMs) >= HOOK_TIMEOUT_MS) return true;
    const pid = Number(readFileSync(slot, "utf8"));
    if (Number.isInteger(pid) && pid > 0) process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Claim `file` exclusively (`wx`, holding this pid), first removing it when `slotStale` says so.
 *
 * @param file - Slot or lock file path.
 * @returns True when claimed; false when held (EEXIST).
 * @throws On any other error.
 */
function claimFile(file: string): boolean {
  // A waiter racing this removal can delete a file just re-created: one extra run for a moment (accepted).
  if (slotStale(file)) rmSync(file, { force: true });
  try {
    writeFileSync(file, String(process.pid), { flag: "wx" });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return false;
  }
}

/** Sleep 100 ms without a busy loop. */
function sleep100(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
}

/**
 * Claim one of `FILE_CHANGED_SLOTS` cross-process FileChanged slots: `${CLAUDE_PLUGIN_DATA || tmpdir()}/fc-slots/<i>`,
 * created exclusively (`wx`) holding this pid, after removing the slot when `slotStale` says so. While every slot is
 * held, sleeps 100 ms (`Atomics.wait`, no busy loop) between rounds until `process.uptime()` reaches `untilMs`; one
 * full round over all slots is always tried first, so `acquireSlot(0)` tries once without waiting.
 *
 * @param untilMs - Process uptime (ms) after which waiting gives up.
 * @returns The held slot file (the caller removes it), or null when none came free in time.
 * @throws On any slot error other than a held slot (EEXIST); the caller then lints without a slot (fail open).
 */
export function acquireSlot(untilMs: number): string | null {
  const dir = path.resolve(process.env.CLAUDE_PLUGIN_DATA || tmpdir(), "fc-slots");
  mkdirSync(dir, { recursive: true });
  for (;;) {
    for (let i = 0; i < FILE_CHANGED_SLOTS; i++) {
      const slot = path.join(dir, String(i));
      if (claimFile(slot)) return slot;
    }
    if (process.uptime() * 1000 >= untilMs) return null;
    sleep100();
  }
}

/**
 * Run a whole-project check (`tsc -p`, `go vet <dir>`, `cargo ... --manifest-path`) once per FileChanged burst and
 * project. State under `${CLAUDE_PLUGIN_DATA || tmpdir()}/fc-locks/`: `<key>.lock` (exclusive `wx` create holding
 * this pid, reclaimed per `slotStale`) and `<key>.last` (`Date.now()` taken before the spawn of the last run that
 * completed without error or signal). Skips (returns null) when `.last` is newer than `file`'s ctime and not in the
 * future: a completed run started after the file's last change, so its process reported this file's findings.
 * Otherwise claims the lock, re-checking `.last` every 100 ms (async `setTimeout` from `node:timers/promises`, so a
 * concurrent chain child keeps being read; under `lintResolved`'s concurrent branch this wait overlaps that child) while a live holder runs, until process
 * uptime reaches `FILE_CHANGED_BUDGET_MS - reserveMs`, after which it runs unlocked; after a claim it re-checks `.last`
 * once more, then awaits `run` inside the `try/finally`, so the lock release follows the child's `close`; writes `.last` on completion. Any stat, mkdir, claim or `.last`
 * error runs unlocked (fail open, as before F13). FileChanged only: `lintResolved` enables it from `hookEventName`.
 *
 * @param key - Project key (`hashPath` of `<tool name>:<tsconfig path | package dir | Cargo.toml path>`).
 * @param file - The changed file (its ctime decides whether the last completed run covers it).
 * @param reserveMs - The check's spawn timeout; the lock wait stops this long before `FILE_CHANGED_BUDGET_MS`.
 * @param run - Spawns the check (async, a `spawnGroup` result).
 * @returns `run`'s result, or null when a completed run already covers `file`.
 */
export async function coalesceProjectCheck(key: string, file: string, reserveMs: number, run: () => Promise<SpawnSyncReturns<string>>): Promise<SpawnSyncReturns<string> | null> {
  const dir = path.resolve(process.env.CLAUDE_PLUGIN_DATA || tmpdir(), "fc-locks");
  const lock = path.join(dir, `${key}.lock`);
  const last = path.join(dir, `${key}.last`);
  let changed: number;
  try {
    // statSync: a symlinked file's target is what the check reads; ctime: copies can preserve an old mtime.
    changed = statSync(file).ctimeMs;
  } catch {
    return await run();
  }
  // A missing, empty or partial stamp gives NaN or a smaller number (not covered); a future-dated stamp never covers.
  const covered = (): boolean => {
    try {
      const t = Number(readFileSync(last, "utf8"));
      return t > changed && t <= Date.now();
    } catch {
      return false;
    }
  };
  for (;;) {
    if (covered()) return null;
    try {
      mkdirSync(dir, { recursive: true }); // only once the cheap `.last` check did not cover the file
      if (claimFile(lock)) break;
    } catch {
      return await run();
    }
    if (process.uptime() * 1000 >= FILE_CHANGED_BUDGET_MS - reserveMs) return await run();
    await sleep(100);
  }
  try {
    // The previous holder may have finished between the last check and this claim.
    if (covered()) return null;
    const start = Date.now();
    const r = await run();
    if (!r.error && !r.signal) {
      try {
        writeFileSync(last, String(start));
      } catch {
        // no stamp: the next process runs the check again
      }
    }
    return r;
  } finally {
    try {
      rmSync(lock, { force: true });
    } catch {
      // slotStale reclaims it once this pid is gone
    }
  }
}

/**
 * FileChanged: lint a watched file changed outside Write/Edit, whole file (no edit-range gate). Skips, first match
 * wins: `unlink` event; out of scope (`scopedTarget`); content still equal to the digest Write/Edit recorded; git says
 * ignored (`!!`) or unchanged (empty status). A git failure (no git, not a repo, timeout) lints. Then waits for one of
 * `FILE_CHANGED_SLOTS` cross-process slots (`acquireSlot`) until `FILE_CHANGED_BUDGET_MS` minus the file's lint
 * budget; no slot in time skips with a stderr note; a slot error lints without a slot. Inside `lintResolved` the
 * whole-project check (tsc, go vet/golangci-lint, cargo) runs through `coalesceProjectCheck`: once per burst and project
 * (F13). Settle window (F34): once the digest check says the content changed, a whole-file edit is journaled
 * (`recordEdit`), and the findings are held and filtered by `settleFindings` after the slot is released. Returns {}
 * for every skip and on any error (fail open).
 * Async since F18 (the git call and `acquireSlot` stay sync: no child of this process exists yet).
 *
 * @param args - The FileChanged hook payload.
 * @returns The hook result: findings as additionalContext, or an empty object.
 */
export async function fileChangedHandler(args: PostToolUseHookInput): Promise<HookResult> {
  try {
    if (args?.event === "unlink") return {};
    const cwd = args?.cwd;
    const file = args?.file_path;
    if (typeof cwd !== "string" || !cwd || typeof file !== "string" || !file) return {};
    const s = scopedTarget(cwd, file, scratchpadOf(args));
    if (!s) return {};
    let recorded: string | null = null;
    try {
      recorded = readFileSync(writtenDigestPath(s.real), "utf8");
    } catch {
      // no digest: the file was not just written by Write/Edit
    }
    if (recorded !== null) {
      if (recorded === fileDigest(s.fp)) return {};
      rmSync(writtenDigestPath(s.real), { force: true }); // stale: a later restore of the old bytes must lint
    }
    // The content changed outside Write/Edit (never for the digest-matched echo above): a whole-file edit for the
    // settle window, also when the git gate then skips the lint (a restore to committed content leaves no stale finding).
    const rec = recordEdit(s.fp, s.real, null);
    try {
      const status = execFileSync("git", ["--no-optional-locks", "status", "--porcelain", "--untracked-files=normal", "--ignored=matching", "--", s.fp], {
        cwd: path.dirname(s.fp),
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (status === "" || status.startsWith("!!")) return {};
    } catch {
      // no git, not a repo, timeout or non-zero exit: lint
    }
    const ext = path.extname(s.fp).toLowerCase();
    // The wait gets what git left of FILE_CHANGED_BUDGET_MS once this file's nominal lint budget is reserved: chain + tsc, kept as the sum for the sequential oxlint-typeCheck fallback (see FILE_CHANGED_BUDGET_MS).
    const lintMs = (EXT_MAP[ext] === "rust" ? CARGO_SPAWN_TIMEOUT_MS : SPAWN_TIMEOUT_MS) + (TYPE_CHECK_EXTS.has(ext) ? TSC_SPAWN_TIMEOUT_MS : 0);
    let slot: string | null | undefined; // undefined: slot error, lint without a slot (fail open, as before F10)
    try {
      slot = acquireSlot(FILE_CHANGED_BUDGET_MS - lintMs);
    } catch {
      // unusable slot dir or slot file: slot stays undefined
    }
    if (slot === null) {
      process.stderr.write(`universal-lint: FileChanged: no lint slot free in time, ${s.fp} not linted\n`);
      return {};
    }
    let kept: Finding[] = [];
    let d0: string | null = null;
    let d1: string | null = null;
    try {
      d0 = digestOrNull(s.fp);
      kept = await lintResolved(s.fp, cwd, null, "FileChanged");
      if (kept.length > 0) d1 = digestOrNull(s.fp); // only a held finding needs the second digest
    } finally {
      try {
        if (slot) rmSync(slot, { force: true });
      } catch {
        // left for slotStale: this pid is gone once the process exits
      }
    }
    // The hold comes after the slot release: a held finding must not keep one of the K slots busy.
    return formatFindings(await settleFindings(kept, s.fp, rec, d0, d1), "FileChanged", "universal-lint (changed outside Write/Edit)");
  } catch {
    return {};
  }
}

/**
 * Lintable, in-scope files of `cwd` per `git ls-files -co --exclude-standard` (tracked + untracked-not-ignored; in a
 * subdirectory git lists only paths below it, relative to it), each filtered through `scopedTarget` with a per-call
 * directory realpath memo (`roots.dirs`) (drops excluded paths, scratchpad files, dangling links and index entries
 * deleted from disk). The scan stops as soon as more than
 * WATCH_LIMIT files are in scope, so files after that point are never scoped.
 *
 * @param cwd - Payload cwd (`new_cwd` for CwdChanged).
 * @param scratchpad - The session's `scratchpad_dir`, when the payload has one.
 * @returns Lexical absolute paths; [] on git failure or when more than WATCH_LIMIT remain (stderr note).
 */
export function watchList(cwd: string, scratchpad?: string): string[] {
  let out: string;
  try {
    out = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  let roots: { cwd: string; scratchpad?: string; dirs: Map<string, string> };
  try {
    roots = { cwd: realish(cwd), scratchpad: scratchpad ? realish(scratchpad) : undefined, dirs: new Map() };
  } catch {
    return [];
  }
  // Set: unmerged index entries are listed once per stage. Returns as soon as WATCH_LIMIT is exceeded: the rest is not scoped.
  const list = new Set<string>();
  for (const rel of out.split("\0")) {
    if (!rel) continue;
    const fp = scopedTarget(cwd, rel, scratchpad, roots)?.fp;
    if (fp) list.add(fp);
    if (list.size > WATCH_LIMIT) {
      process.stderr.write(`universal-lint: watch list: more than ${WATCH_LIMIT} files, FileChanged linting off for this cwd\n`);
      return [];
    }
  }
  return [...list];
}

/**
 * SessionStart/CwdChanged: the watch list as `hookSpecificOutput.watchPaths` (Claude Code then fires FileChanged for
 * those files). Fails open to {}.
 *
 * @param args - The SessionStart/CwdChanged hook payload.
 * @returns The watch-paths output, or {} when the list is empty or for any other event.
 */
export function watchPathsHandler(args: PostToolUseHookInput): { hookSpecificOutput?: { hookEventName: string; watchPaths: string[] } } {
  try {
    const ev = typeof args?.hook_event_name === "string" ? args.hook_event_name : "";
    if (ev !== "SessionStart" && ev !== "CwdChanged") return {};
    const cwd = typeof args.new_cwd === "string" && args.new_cwd ? args.new_cwd : args.cwd;
    if (typeof cwd !== "string" || !cwd) return {};
    const list = watchList(cwd, scratchpadOf(args));
    return list.length > 0 ? { hookSpecificOutput: { hookEventName: ev, watchPaths: list } } : {};
  } catch {
    return {};
  }
}

/**
 * True only when this file is the process entry point (MCP spawn / `node server.mjs`),
 * false when imported by a unit test -- so importing never starts the stdin loop.
 */
function isMainModule(): boolean {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/**
 * Read the hook's stdin JSON and dispatch on `hook_event_name`: SessionStart/CwdChanged print the watch-paths JSON on
 * stdout (exit 0); FileChanged runs fileChangedHandler; anything else (PostToolUse, or a payload without the field)
 * records the Write/Edit digest and runs lintFileHandler. Findings: their text on stderr and exit 2 (asyncRewake wakes
 * Claude with it). Fails open on any error — no output, exit 0.
 *
 * @remarks
 * Reads stdin asynchronously to EOF, never `readFileSync(0)`: fd 0 is non-blocking, so a sync read throws EAGAIN on a late writer or a payload above the pipe buffer (hook-design.md "stdin", F05). Never rejects (the whole body is in the try/catch), so the bottom `void main()` is safe. Never calls `process.exit`: the process ends when the event loop drains after stdin EOF and every child's `close`, carrying `process.exitCode` 2 for findings, so the exit-code contract is unchanged.
 */
async function main(): Promise<void> {
  try {
    const input = (await json(process.stdin)) as PostToolUseHookInput;
    const ev = input?.hook_event_name;
    if (ev === "SessionStart" || ev === "CwdChanged") {
      const r = watchPathsHandler(input);
      if (r.hookSpecificOutput) process.stdout.write(JSON.stringify(r));
      return;
    }
    let ctx: string | undefined;
    if (ev === "FileChanged") ctx = (await fileChangedHandler(input)).hookSpecificOutput?.additionalContext;
    else {
      const scoped = postToolScope(input);
      recordWrittenFor(scoped);
      ctx = (await lintFileHandler(input, scoped)).hookSpecificOutput?.additionalContext;
    }
    if (ctx) {
      process.stderr.write(ctx + "\n");
      process.exitCode = 2;
    }
  } catch {
    // fail open — no output, exit 0
  }
}

if (isMainModule()) void main();
