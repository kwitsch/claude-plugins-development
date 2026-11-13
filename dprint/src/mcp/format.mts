/**
 * The `format_pre`, `file_written`, `file_changed`, `cwd_changed`, `worktree_entered` and `worktree_exited` hook
 * handlers plus the pure helpers behind them.
 *
 * @remarks
 * Helpers: {@link applyEdit} (Claude Code's Edit semantics, copied from universal-format), {@link lineDiff}
 * (line LCS) and {@link trimToEdit} (keep only the diff hunks that touch the edit).
 *
 * @packageDocumentation
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { findConfig } from "../skills/dprint/find-config.mjs";
import type { BashFinishedInput, BashStartedInput, CwdChangedInput, DrainNoticesInput, FileChangedInput, FileWrittenInput, FormatPreInput, WorktreeEnteredInput, WorktreeExitedInput } from "./hook-inputs.mjs";
import { DprintLsp } from "./lsp.mjs";
import { dprintFilePaths } from "./watch-list.mjs";

/** Hook output: empty (`{}`) to let the event through unchanged, else a notice and, for `format_pre`, the rewritten tool input. */
export type HookResult = {
  /** Output for the hook's event; absent when the hook has nothing to say. */
  hookSpecificOutput?: {
    /** The event the output belongs to (`PreToolUse`, `PostToolUse` or `UserPromptSubmit`). */
    hookEventName: string;
    /** Replacement for the whole `Write`/`Edit` tool input (`format_pre` only). */
    updatedInput?: Record<string, unknown>;
    /** Notice to the model: a reformat it did not make itself. */
    additionalContext: string;
  };
};

/** One diff hunk: `a[aStart, aEnd)` was replaced by `b[bStart, bEnd)`; half-open line indices. */
type Hunk = {
  /** First replaced line in `a`. */
  aStart: number;
  /** First line in `a` after the replaced lines. */
  aEnd: number;
  /** First inserted line in `b`. */
  bStart: number;
  /** First line in `b` after the inserted lines. */
  bEnd: number;
};

/**
 * Apply an Edit exactly as Claude Code's Edit tool would.
 *
 * @param current - File content before the edit.
 * @param oldStr - `old_string`.
 * @param newStr - `new_string`.
 * @param replaceAll - `replace_all`.
 * @returns The edited content, or `null` when `oldStr` is empty, not found, or (without `replaceAll`) not
 * unique.
 */
export function applyEdit(
  current: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean,
): string | null {
  if (oldStr === "") return null;
  if (replaceAll) {
    return current.includes(oldStr) ? current.split(oldStr).join(newStr) : null;
  }
  const idx = current.indexOf(oldStr);
  if (idx === -1) return null;
  if (current.indexOf(oldStr, idx + oldStr.length) !== -1) return null; // non-unique
  return current.slice(0, idx) + newStr + current.slice(idx + oldStr.length);
}

/**
 * LCS line diff.
 *
 * @remarks
 * shortcut: O(n·m) memory on the lines between the common prefix and suffix; fine for source files, upgrade
 * to Myers if a \>20k-line file shows up.
 *
 * @param a - Original lines.
 * @param b - New lines.
 * @returns Ordered, non-overlapping hunks separated by at least one common line. Throws when the changed
 * middle exceeds 25M line pairs (the caller fails open instead of producing a near whole-file edit).
 */
export function lineDiff(a: string[], b: string[]): Hunk[] {
  // the table only needs the changed middle: strip the common prefix and suffix first
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre
    && suf < b.length - pre
    && a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }
  if (pre > 0 || suf > 0) {
    return lineDiff(
      a.slice(pre, a.length - suf),
      b.slice(pre, b.length - suf),
    ).map((h) => ({
      aStart: h.aStart + pre,
      aEnd: h.aEnd + pre,
      bStart: h.bStart + pre,
      bEnd: h.bEnd + pre,
    }));
  }
  if (a.length * b.length > 25_000_000) throw new Error("diff too large");
  const n = a.length;
  const m = b.length;
  // L[i][j] = LCS length of a[i..] and b[j..]; min(n, m) <= 5000 under the guard, so 16 bits suffice
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = a[i] === b[j]
        ? L[i + 1][j + 1] + 1
        : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      if (cur) hunks.push(cur);
      cur = null;
      i++;
      j++;
      continue;
    }
    cur ??= { aStart: i, aEnd: i, bStart: j, bEnd: j };
    if (j < m && (i === n || L[i][j + 1] >= L[i + 1][j])) cur.bEnd = ++j;
    else cur.aEnd = ++i;
  }
  if (cur) hunks.push(cur);
  return hunks;
}

/**
 * Reduce a whole-file reformat to the part that touches the edit.
 *
 * @remarks
 * Keeps only the hunks of `diff(original, formatted)` that intersect or touch an edited line range, then
 * widens the kept span by common lines (alternating, upward first) until its original text occurs exactly
 * once in `original`. After 1000 single-line widening steps it jumps to the widest span available at once.
 *
 * @param original - File content before the edit (on disk).
 * @param formatted - Edited and formatted content.
 * @param editLines - Inclusive `[start, end]` line indices in `original` covered by the edit.
 * @returns One Edit whose `oldString` is verbatim, unique `original` text, or `null` when nothing is kept or
 * no unique `oldString` exists.
 */
export function trimToEdit(
  original: string,
  formatted: string,
  editLines: Array<[number, number]>,
): { oldString: string; newString: string } | null {
  // lines keep their terminator, so removing a final unterminated line also removes the "\n" before it
  const split = (t: string) => t.match(/[^\n]*\n|[^\n]+/g) ?? [];
  const a = split(original);
  const b = split(formatted);
  const render = (lines: string[], x: number, y: number) => lines.slice(x, y).join("");
  const hunks = lineDiff(a, b);
  const kept: number[] = [];
  hunks.forEach((h, k) => {
    if (editLines.some(([s, e]) => h.aStart <= e + 1 && h.aEnd >= s)) {
      kept.push(k);
    }
  });
  if (kept.length === 0) return null;
  const first = kept[0];
  const last = kept[kept.length - 1];
  let aA = hunks[first].aStart;
  let bA = hunks[first].bStart;
  let aB = hunks[last].aEnd;
  let bB = hunks[last].bEnd;
  // common (LCS-matched) context available on each side, bounded by the neighbouring non-kept hunks
  const lo = hunks[first - 1]?.aEnd ?? 0;
  const hi = hunks[last + 1]?.aStart ?? a.length;
  let steps = 0;
  for (let up = true;; up = !up) {
    // shortcut: at most 1000 single-line widening steps (realistic files need < 50), then one jump to the widest
    // span so a highly repetitive file still formats (as a large Edit) instead of costing a search per line
    if (++steps === 1001) {
      bA -= aA - lo;
      aA = lo;
      bB += hi - aB;
      aB = hi;
    }
    const oldString = render(a, aA, aB);
    const i = original.indexOf(oldString);
    if (
      oldString !== ""
      && i !== -1
      && original.indexOf(oldString, i + 1) === -1
    ) {
      const newString = render(b, bA, bB);
      return oldString === newString ? null : { oldString, newString };
    }
    // widen by one common line, alternating directions starting upward
    if (up && aA > lo) {
      aA--;
      bA--;
    } else if (aB < hi) {
      aB++;
      bB++;
    } else if (aA > lo) {
      aA--;
      bA--;
    } else return null;
  }
}

/** One `dprint lsp` per working directory (its `rootUri` decides which dprint config applies), created lazily. */
const clients = new Map<string, DprintLsp>();

/**
 * Get the lsp client for a working directory, creating it on first use.
 *
 * @param cwd - Working directory (LSP root).
 * @param key - Cache key; {@link fileChanged} passes its own so its whole-file formats never queue in front of
 * a `format_pre` call.
 * @returns The cached or new client.
 */
const client = (cwd: string, key = cwd): DprintLsp => {
  let c = clients.get(key);
  if (c) clients.delete(key); // re-insert below: Map order = least recently used first
  else {
    c = new DprintLsp({ cwd });
    // evict the idle children of cwds the session left long ago
    for (const [k, old] of clients) {
      if (clients.size < MAX_CLIENTS) break;
      old.close();
      clients.delete(k);
    }
  }
  clients.set(key, c);
  return c;
};

/** Most `dprint lsp` children kept alive; the least recently used one is disposed beyond it. */
const MAX_CLIENTS = 8;

/** FileChanged events running git and dprint at once; later ones wait in arrival order. */
const MAX_ACTIVE_CHANGES = 8;

/** Most FileChanged events waiting for a slot; beyond it events are dropped with one stderr line each. */
const MAX_WAITING_CHANGES = 1000;

/** FileChanged events currently holding a slot. */
let activeChanges = 0;

/** Wake-ups of the waiting FileChanged events, oldest first. */
const waitingChanges: Array<() => void> = [];

/** Largest document any hook formats; bigger ones are generated data, and formatting them parks GBs in the lsp child. */
const MAX_CHANGED_BYTES = 1024 * 1024;

/**
 * Whether a document is too big to format; logs the skip.
 *
 * @param bytes - Size of the document.
 * @param fp - Its path, for the log line.
 * @returns `true` when `bytes` exceeds {@link MAX_CHANGED_BYTES}.
 */
function overCap(bytes: number, fp: string): boolean {
  if (bytes <= MAX_CHANGED_BYTES) return false;
  process.stderr.write(`[dprint-hooks] format skipped (over ${MAX_CHANGED_BYTES} bytes): ${fp}\n`);
  return true;
}

/**
 * Working directory per session or subagent, set by `cwd_changed`/`worktree_entered`: EnterWorktree and
 * CwdChanged move a cwd without the hook payload's `cwd` following.
 */
const cwdOverrides = new Map<string, string>();

/**
 * Key of {@link cwdOverrides} for a hook payload.
 *
 * @param args - Hook input.
 * @returns `agent_id` inside a subagent (empty in the main session), else `session_id`, else `""` (no
 * override possible).
 */
const overrideKey = (args: {
  agent_id?: string;
  session_id?: string;
}): string => args.agent_id || args.session_id || "";

/**
 * Files {@link fileChanged} reformatted that the model does not know about yet, per {@link overrideKey}; drained by
 * {@link drainNotices}. Absolute paths.
 */
const notices = new Map<string, Set<string>>();

/**
 * Queue a reformatted file for the next {@link drainNotices}.
 *
 * @param k - {@link overrideKey} of the session or subagent.
 * @param fp - Absolute path.
 */
const queueNotice = (k: string, fp: string): void => {
  notices.set(k, (notices.get(k) ?? new Set()).add(fp));
};

/**
 * Take (and forget) the queued files of a session or subagent.
 *
 * @param k - {@link overrideKey} of the session or subagent.
 * @returns The queued absolute paths; empty when none.
 */
const takeNotices = (k: string): Set<string> => {
  const files = notices.get(k) ?? new Set<string>();
  notices.delete(k);
  return files;
};

/** Start time (ms) of the running Bash call per {@link bashKey}, set by {@link bashStarted}. */
const bashStart = new Map<string, number>();

/** How long a {@link bashStart} entry of a Bash call that never reported back is kept. */
const BASH_START_TTL_MS = 60 * 60 * 1000;

/**
 * In-scope watch list per effective cwd, read lazily by {@link cachedWatchList}.
 *
 * @remarks
 * shortcut: files created after the first read are missing until a cwd change clears the cache (the same
 * limit as the FileChanged watch list; `DPRINT_WATCH_DIRECTORIES=1` fixes the watch list, not this cache).
 */
const watchCache = new Map<string, { list: Promise<Array<{ fp: string; real: string }>>; at: number; failed: boolean }>();

/** A failed watch-list read (dprint failing or timing out) is retried after this long. */
const WATCH_RETRY_MS = 60_000;

/**
 * Record a cwd override for the payload's session or subagent.
 *
 * @param args - Hook input (supplies the key).
 * @param cwd - New working directory; empty (a tool response without the field) drops the override, so the
 * payload's `cwd` applies again instead of a stale worktree root.
 * @returns `{}`: these hooks never change the tool call.
 */
function setCwd(
  args: { agent_id?: string; session_id?: string },
  cwd: string | undefined,
): HookResult {
  const key = overrideKey(args);
  if (key) {
    if (cwd) cwdOverrides.set(key, cwd);
    else cwdOverrides.delete(key);
  }
  if (cwd) watchCache.delete(cwd); // entering a directory re-reads its list on the next bash_finished
  return {};
}

/**
 * CwdChanged hook: use `new_cwd` for this session's or subagent's later `format_pre` calls.
 *
 * @param args - Hook input with `new_cwd`, `session_id` and `agent_id`.
 * @returns `{}`.
 */
export const cwdChanged = (args: CwdChangedInput = {}): HookResult => setCwd(args, args.new_cwd);

/**
 * PostToolUse EnterWorktree hook: CwdChanged does not fire for it, so take the worktree path from the tool
 * response.
 *
 * @param args - Hook input with `tool_response.worktreePath`, `session_id` and `agent_id`.
 * @returns `{}`.
 */
export const worktreeEntered = (args: WorktreeEnteredInput = {}): HookResult => setCwd(args, args.tool_response?.worktreePath);

/**
 * PostToolUse ExitWorktree hook: switch to the cwd the session is restored to (`restoredCwd`; the cwd from
 * before EnterWorktree, or Claude Code's fallback when that no longer exists), else the stale worktree root
 * would skip every file outside it.
 *
 * @param args - Hook input with `tool_response.restoredCwd`, `session_id` and `agent_id`.
 * @returns `{}`.
 */
export const worktreeExited = (args: WorktreeExitedInput = {}): HookResult => setCwd(args, args.tool_response?.restoredCwd);

/**
 * Kill every `dprint lsp` child (called when MCP stdin closes).
 */
export function disposeLsp(): void {
  for (const c of clients.values()) c.close();
  clients.clear();
}

/**
 * Paths never formatted, same as universal-format: dependency and VCS dirs, other agents' worktrees and
 * memory, personal `*.local.*` files.
 *
 * @param rel - Path relative to the working directory.
 * @returns `true` when the path must be left alone.
 */
const isExcludedPath = (rel: string): boolean => {
  const segs = rel.split(path.sep);
  return (
    segs.some((s) => s === "node_modules" || s === "vendor" || s === ".git")
    || segs.some(
      (s, i) =>
        s === ".claude"
        && (segs[i + 1] === "worktrees" || segs[i + 1] === "agent-memory"),
    )
    || segs[segs.length - 1].includes(".local.")
  );
};

/**
 * Real path of `p`, also for a path that does not exist yet (the new file of a Write).
 *
 * @remarks
 * A missing path resolves through its nearest existing ancestor. A dangling symlink, or a link that cannot be
 * resolved (`ELOOP`, `EACCES`), throws: falling back to the lexical path of a dangling link would let a Write
 * follow it out of the cwd.
 *
 * @param p - Path to resolve.
 * @returns The real path of `p`, or of its nearest existing ancestor joined with the missing rest.
 */
const realish = (p: string): string => {
  try {
    return realpathSync.native(p);
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
};

/** Effective working directory of one hook call, resolved once for many {@link inScope} checks. */
type Scope = {
  /** Lexical effective cwd: the `dprint lsp` root and the `findConfig` start. */
  root: string;
  /** Real path of `root`. */
  realRoot: string;
  /** Real path of the session's `scratchpad_dir`, or `null` when the payload has none. */
  realScratch: string | null;
};

/**
 * Resolve the effective cwd of a hook payload.
 *
 * @remarks
 * The cwd override of the session/subagent ({@link cwdOverrides}), else the payload's `cwd`; never the MCP
 * server's own `process.cwd()`.
 *
 * @param args - Hook input: `cwd`, `agent_id`, `session_id`, `scratchpad_dir`.
 * @returns The scope, or `null` when no cwd is known or a path cannot be resolved (callers skip).
 */
export function scopeOf(
  args: {
    cwd?: string;
    agent_id?: string;
    session_id?: string;
    scratchpad_dir?: string;
  } = {},
): Scope | null {
  const key = overrideKey(args);
  const root = (key && cwdOverrides.get(key)) || args.cwd || "";
  if (!root) return null;
  try {
    return {
      root,
      realRoot: realish(root),
      realScratch: args.scratchpad_dir ? realish(args.scratchpad_dir) : null,
    };
  } catch {
    return null;
  }
}

/**
 * Decide whether a file belongs to the scope and may be formatted.
 *
 * @param sc - Scope from {@link scopeOf}.
 * @param file - File path, absolute or relative to `sc.root`.
 * @returns `fp` (the path as Claude used it, resolved against `sc.root`) and `real` (its real path) when the
 * real path is strictly inside `sc.realRoot`, not an {@link isExcludedPath} path and not inside the scratchpad;
 * else `null` (also for an empty path, the cwd itself, or a dangling/unresolvable link).
 */
export function inScope(
  sc: Scope,
  file: string,
): { fp: string; real: string } | null {
  if (!file) return null;
  const fp = path.resolve(sc.root, file);
  let real: string;
  try {
    real = realish(fp);
  } catch {
    return null;
  }
  const outside = (rel: string) => rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
  const rel = path.relative(sc.realRoot, real);
  if (rel === "" || outside(rel) || isExcludedPath(rel)) return null;
  if (sc.realScratch !== null) {
    const sp = path.relative(sc.realScratch, real);
    if (sp === "" || !outside(sp)) return null;
  }
  return { fp, real };
}

/**
 * Content last written per real path, by Edit/Write (recorded by {@link fileWritten}) or by {@link fileChanged}.
 *
 * @remarks
 * FileChanged must not re-format Edit/Write results or its own writes, so {@link fileChanged} skips a file whose
 * content equals the entry. Entries are kept on a match, so duplicate and add-then-change events are skipped too.
 * shortcut: entries stay until the server exits; prune if memory ever matters.
 */
const written = new Map<string, string>();

/**
 * Digest of a file's text, what {@link written} stores instead of the text itself.
 *
 * @param text - File content.
 * @returns Base64 SHA-256 of `text`.
 */
const digest = (text: string): string => createHash("sha256").update(text).digest("base64");

/**
 * Message of a caught value.
 *
 * @param e - Anything thrown.
 * @returns `e.message` for an `Error`, else `String(e)`.
 */
const errText = (e: unknown): string => e instanceof Error ? e.message : String(e);

/** Strict UTF-8 decoder: throws on invalid bytes. */
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }); // keep a BOM, like readFileSync (the digests must agree)

/** `execFile` returning a promise of `{ stdout, stderr }`. */
const execFileAsync = promisify(execFile);

/**
 * Whether git ignores a file (`git check-ignore`); tracked files never count as ignored.
 *
 * @remarks
 * Runs in the nearest existing ancestor directory of the file, so a nested repository or submodule applies its own
 * ignore rules and a Write to a new directory still resolves. No git, no repository or a timeout mean "not ignored".
 *
 * @param fp - Absolute real path (symlinks resolved: git refuses a pathspec beyond a symbolic link and would answer
 * "not ignored").
 * @returns `true` only when git reports the file as ignored (exit 0).
 */
async function isGitIgnored(fp: string): Promise<boolean> {
  let cwd = path.dirname(fp);
  while (!existsSync(cwd) && cwd !== path.dirname(cwd)) cwd = path.dirname(cwd);
  try {
    await execFileAsync("git", ["--no-optional-locks", "check-ignore", "-q", "--", fp], { cwd, timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * PostToolUse `Write|Edit` hook: remember the content Edit/Write wrote, so {@link fileChanged} leaves it alone.
 *
 * @param args - Hook input: `cwd`, `agent_id`, `session_id`, `scratchpad_dir` and `tool_input.file_path`.
 * @returns `{}` (fail open on every error).
 */
export function fileWritten(args: FileWrittenInput = {}): HookResult {
  try {
    const sc = scopeOf(args);
    const s = sc && inScope(sc, args.tool_input?.file_path ?? "");
    // without a dprint config file_changed never formats here, so there is nothing to remember
    if (sc && s && findConfig(sc.root) !== null) {
      written.set(s.real, digest(readFileSync(s.fp, "utf8")));
    }
  } catch (e) {
    process.stderr.write(
      `[dprint-hooks] file_written failed open: ${errText(e)}\n`,
    );
  }
  return {};
}

/**
 * Take a FileChanged slot: a burst (codegen, formatter run) waits in arrival order; only a backlog beyond
 * {@link MAX_WAITING_CHANGES} is dropped.
 *
 * @param fp - File path, for the drop message.
 * @returns `true` when a slot is held (pair with {@link releaseChangeSlot}), `false` when the event was dropped.
 */
async function acquireChangeSlot(fp: string): Promise<boolean> {
  if (activeChanges < MAX_ACTIVE_CHANGES) activeChanges++;
  else if (waitingChanges.length >= MAX_WAITING_CHANGES) {
    process.stderr.write(`[dprint-hooks] file_changed dropped (${MAX_WAITING_CHANGES} waiting): ${fp}\n`);
    return false;
  } else await new Promise<void>((wake) => waitingChanges.push(wake)); // the slot is handed over, not re-counted
  return true;
}

/** Give back a FileChanged slot: hand it to the oldest waiting event, else free it. */
function releaseChangeSlot(): void {
  const next = waitingChanges.shift();
  if (next) next();
  else activeChanges--;
}

/**
 * Format one file on disk after a change not made by Edit/Write.
 *
 * @remarks
 * Skips files above {@link MAX_CHANGED_BYTES}, files with a lone `\r`, content equal to the {@link written} digest, and
 * (user decision) gitignored files and tracked files unchanged against the git index (one
 * `git status --porcelain --untracked-files=normal --ignored=matching`: `!!` or empty output, e.g. after
 * checkout/pull/reset/stash); when git fails or is absent the file is formatted. CRLF files are formatted on their LF
 * view and written back with CRLF. At most {@link MAX_ACTIVE_CHANGES} calls run git and dprint at once, the rest wait
 * in order (beyond {@link MAX_WAITING_CHANGES} waiting they are dropped with a stderr line), on a `dprint lsp` of
 * their own. The whole file is formatted via `textDocument/formatting` and written in place only when dprint changed
 * it and the file did not change meanwhile.
 *
 * @param sc - Scope of the hook call.
 * @param s - The file, from {@link inScope}.
 * @param signal - Aborts when the client cancels the call: nothing is read, spawned or written after it fires.
 * @returns `true` when the file was rewritten, `false` on every skip, cancel and error (fail open).
 */
async function formatOnDisk(sc: Scope, s: { fp: string; real: string }, signal?: AbortSignal): Promise<boolean> {
  try {
    if (signal?.aborted) return false;
    if (overCap(statSync(s.fp).size, s.fp)) return false;
    if (!(await acquireChangeSlot(s.fp))) return false;
    try {
      // cancelled while waiting for the slot: give it back without reading or spawning anything
      if (signal?.aborted) return false;
      // read after the slot is held: waiting events must not each keep up to 1 MiB of text alive
      // fatal decoder: a non-UTF-8 file throws (fails open) instead of being rewritten with U+FFFD
      const text = utf8.decode(readFileSync(s.fp));
      if (written.get(s.real) === digest(text)) return false;
      // CRLF files are formatted on their LF view (as formatPre's Edit does) and written back with CRLF; a lone "\r" fails open
      const lf = text.replaceAll("\r\n", "\n");
      if (lf.includes("\r")) return false;
      if (text !== lf && /(?<!\r)\n/.test(text)) return false; // mixed line endings: writing all CRLF would change every line
      // user decision: gitignored files (`!!`) and tracked files equal to the index (empty output) are left alone;
      // one spawn answers both. --untracked-files=normal is required: under status.showUntrackedFiles=no git
      // rejects --ignored otherwise. --no-optional-locks keeps .git/index.lock free for the user's git,
      // cwd = dirname picks the nearest repository (nested repos, submodules)
      try {
        const { stdout } = await execFileAsync(
          "git",
          ["--literal-pathspecs", "--no-optional-locks", "status", "--porcelain", "--untracked-files=normal", "--ignored=matching", "--", s.real],
          { cwd: path.dirname(s.real), encoding: "utf8", timeout: 10_000 },
        );
        if (stdout === "" || stdout.startsWith("!!")) return false;
      } catch {
        // no git, not a repository or timeout: format
      }
      if (signal?.aborted) return false;
      // own client: whole-file formats here never queue in front of a Write/Edit format_pre call
      const out = changed(
        await client(sc.root, sc.root + "\0file_changed").format(pathToFileURL(s.fp).href, lf),
        lf,
      );
      // a cancelled call writes nothing
      if (out === null || signal?.aborted) return false;
      const final = text === lf ? out : out.replaceAll("\n", "\r\n");
      // the path was validated before the slot wait and the format: a file (or a directory above it) swapped for a
      // symlink since then must not be written through (to a file outside the cwd, under node_modules, ...)
      if (realish(s.fp) !== s.real) return false;
      // a write that landed while dprint was formatting (or while the event waited) wins
      if (utf8.decode(readFileSync(s.fp)) !== text) return false;
      // an Edit/Write record that landed during the awaits wins (keeps trimToEdit's minimal diff)
      if (written.get(s.real) === digest(text)) return false;
      writeFileSync(s.fp, final);
      written.set(s.real, digest(final)); // after the write: a failed write records nothing
      return true;
    } finally {
      releaseChangeSlot();
    }
  } catch (e) {
    process.stderr.write(
      `[dprint-hooks] format_on_disk failed open: ${errText(e)}\n`,
    );
    return false;
  }
}

/**
 * Build the notice for files dprint reformatted outside Edit/Write.
 *
 * @param args - Hook input: `hook_event_name` (or the fixed event), `cwd` and the session keys.
 * @param event - Event the output belongs to.
 * @param files - Absolute paths.
 * @returns A PostToolUse/PreToolUse/UserPromptSubmit output with plain facts (no instructions to the system).
 */
function notice(args: { cwd?: string; agent_id?: string; session_id?: string }, event: string, files: string[]): HookResult {
  const sc = scopeOf(args);
  // relative to the real root: dprint prints physical paths, so under a symlinked cwd the lexical root would give "../.."
  // quoted: a file name may hold newlines or text that reads like an instruction
  const name = (p: string): string => {
    if (!sc) return p;
    const under = path.relative(sc.realRoot, p);
    return under !== "" && !under.startsWith("..") && !path.isAbsolute(under) ? under : path.relative(sc.root, p);
  };
  const rel = files.map((p) => JSON.stringify(name(p))).join(", ");
  return {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: `dprint reformatted after a change outside Edit/Write: ${rel}. Tool output from before this notice (cat, line lengths, diffs) shows the state BEFORE the formatting. Re-read the file before stating anything about its content and before further string-based edits.`,
    },
  };
}

/**
 * FileChanged hook: format a watched file inside the cwd on disk after a change not made by Edit/Write.
 *
 * @remarks
 * Skips `unlink` events, files out of {@link inScope} and cwds without a dprint config; the rest is
 * {@link formatOnDisk}. A rewrite is queued for {@link drainNotices}, since FileChanged has no channel to the model.
 * Never returns `watchPaths`, so Claude Code keeps its watch list.
 *
 * @param args - Hook input: `cwd`, `agent_id`, `session_id`, `scratchpad_dir`, `file_path` and `event`.
 * @returns `{}` (fail open on every error).
 */
export async function fileChanged(
  args: FileChangedInput = {},
  signal?: AbortSignal,
): Promise<HookResult> {
  try {
    if (args.event === "unlink") return {};
    const sc = scopeOf(args);
    const s = sc && inScope(sc, args.file_path ?? "");
    if (!sc || !s || findConfig(sc.root) === null) return {};
    if (await formatOnDisk(sc, s, signal)) {
      const k = overrideKey(args);
      queueNotice(k, s.fp);
    }
  } catch (e) {
    process.stderr.write(
      `[dprint-hooks] file_changed failed open: ${errText(e)}\n`,
    );
  }
  return {};
}

/**
 * Key of one Bash call in {@link bashStart}: the session/agent key plus the call's `tool_use_id`, so overlapping Bash
 * calls of one session keep their own start times (without an id, one call per session/agent is assumed).
 *
 * @param args - Hook input of `bash_started` or `bash_finished`.
 * @returns The map key.
 */
function bashKey(args: BashStartedInput & BashFinishedInput): string {
  return overrideKey(args) + "\0" + (args.tool_use_id ?? "");
}

/**
 * PreToolUse `Bash` hook: remember when the Bash call started.
 *
 * @param args - Hook input: `cwd`, `session_id`, `agent_id` and `tool_use_id`.
 * @returns `{}`.
 */
export function bashStarted(args: BashStartedInput = {}): HookResult {
  const now = Date.now();
  // start reading the watch list now, so the first listing (11 s for 1500 files on a 9P mount) runs during the Bash
  // call and not inside bash_finished
  try {
    const sc = scopeOf(args);
    if (sc && findConfig(sc.root) !== null) void cachedWatchList(sc);
  } catch {
    // fail open
  }
  // a call that never finished (interrupted, killed) leaves its entry behind: drop entries older than an hour
  for (const [key, at] of bashStart) if (now - at > BASH_START_TTL_MS) bashStart.delete(key);
  bashStart.set(bashKey(args), now);
  return {};
}

/**
 * The in-scope files dprint formats in a cwd, cached per root.
 *
 * @param sc - Scope of the hook call.
 * @returns The files; `[]` on a dprint failure or when there are none (cached for {@link WATCH_RETRY_MS}, so a
 * failing or missing dprint cannot stall every Bash call, and one installed later is picked up). The read is shared: a call while it runs gets the same promise.
 */
async function cachedWatchList(sc: Scope): Promise<Array<{ fp: string; real: string }>> {
  const hit = watchCache.get(sc.root);
  if (hit && !(hit.failed && Date.now() - hit.at > WATCH_RETRY_MS)) return hit.list;
  const entry = { at: Date.now(), failed: false, list: Promise.resolve<Array<{ fp: string; real: string }>>([]) };
  entry.list = (async () => {
    const list: Array<{ fp: string; real: string }> = [];
    try {
      for (const p of await dprintFilePaths(sc.root)) {
        const s = inScope(sc, p);
        if (s) list.push(s);
      }
      if (list.length === 0) entry.failed = true; // dprint missing, no files or above the limit: look again in a minute
    } catch (e) {
      entry.failed = true; // an empty list for a minute, so a failing dprint cannot stall every Bash call
      process.stderr.write(`[dprint-hooks] watch list failed: ${errText(e)}\n`);
    }
    return list;
  })();
  watchCache.set(sc.root, entry);
  return entry.list;
}

/**
 * Mean cost (ms) of one `stat` above which a file system counts as slow (9P mounts of Windows drives: 0.7-1.6 ms;
 * ext4: 0.003-0.005 ms). `DPRINT_HOOKS_SLOW_STAT_MS` overrides it (tests); a negative value forces the slow path.
 */
const SLOW_STAT_MS = Number(process.env.DPRINT_HOOKS_SLOW_STAT_MS ?? "0.2");

/** Files sampled to judge the stat cost, and the smallest list for which the judgement is made. */
const STAT_SAMPLE = 16;

/**
 * Slack (ms) when comparing a file's mtime with the start of the Bash call: coarse timestamps on ordinary file
 * systems, and on slow ones (9P mounts of Windows drives, mtimes lag `Date.now()` by about 1.5 s: measured on
 * `/mnt/c` in WSL2) the clock offset. A file that changed a little before the call and is formatted by it too is
 * harmless: FileChanged would format it anyway.
 */
const MTIME_SLACK_MS = { fast: 1000, slow: 5000 };

/**
 * Whether a stat per file of this list is slow enough that asking git for the changed files is cheaper.
 *
 * @remarks
 * git costs about 8 ms of spawns on a fast file system (68 ms measured with 5000 untracked files), so it is only used
 * when a sample of evenly spread files shows slow stats; a list shorter than the sample is always stat-ed (it is
 * cheap even on 9P) but still judged, so the mtime slack follows the file system.
 *
 * @param list - The watch list of the cwd.
 * @returns `true` when the mean stat time of the sample exceeds {@link SLOW_STAT_MS}.
 */
function statsAreSlow(list: Array<{ fp: string }>): boolean {
  if (SLOW_STAT_MS < 0) return true;
  const n = Math.min(STAT_SAMPLE, list.length);
  if (n === 0) return false;
  const step = Math.floor(list.length / n);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    try {
      statSync(list[i * step].fp);
    } catch {
      // deleted meanwhile: still a measured round trip
    }
  }
  return (performance.now() - t0) / n > SLOW_STAT_MS;
}

/**
 * The files git sees as changed in a cwd: a predicate over real file paths, so `bash_finished` stats only those
 * instead of every file of a big watch list (a stat is slow on 9P mounts, see {@link statsAreSlow}).
 *
 * @remarks
 * One `git status --porcelain -z --no-renames --untracked-files=normal` plus `git rev-parse --show-toplevel`
 * (paths of the status are relative to the toplevel). Modified, added, deleted and untracked entries count; an
 * untracked directory (entry ending in `/`) and a changed submodule (entry without it) match every file below
 * them. Clean files are left out on purpose: a file the Bash call rewrote back to its index content needs no format.
 *
 * @param root - Effective cwd.
 * @returns The predicate, or `null` without git, outside a repository or on any error (the caller then checks every
 * file).
 */
async function gitChanged(root: string): Promise<((real: string) => boolean) | null> {
  try {
    const opts = { cwd: root, encoding: "utf8" as const, timeout: 10_000, maxBuffer: 64 * 1024 * 1024 };
    const [top, status] = await Promise.all([
      execFileAsync("git", ["--no-optional-locks", "rev-parse", "--show-toplevel"], opts),
      execFileAsync("git", ["--no-optional-locks", "status", "--porcelain", "-z", "--no-renames", "--ignore-submodules=none", "--untracked-files=normal"], opts),
    ]);
    const base = top.stdout.trim();
    if (!base) return null;
    // compared case-insensitively: on a Windows drive mounted by 9P git's toplevel keeps the casing of the cwd as
    // entered and the status the casing of the index, while the file system itself ignores case (measured on /mnt/c);
    // on a case-sensitive file system a file differing only in case is a harmless extra candidate
    const entries = new Set<string>();
    for (const entry of status.stdout.split("\0")) {
      if (entry.length < 4) continue; // "XY path"
      entries.add(path.join(base, entry.slice(3)).replace(/\/+$/, "").toLowerCase()); // an untracked directory ends in a slash
    }
    // the file itself, or a directory or submodule above it (up to the toplevel) is listed
    return (real) => {
      for (let p = real; p.length > base.length; p = path.dirname(p)) if (entries.has(p.toLowerCase())) return true;
      return false;
    };
  } catch {
    return null;
  }
}

/**
 * PostToolUse `Bash` hook: format the watched files the Bash call changed, right now, and tell the model.
 *
 * @remarks
 * FileChanged fires only after the Bash call ended, so its tool output shows the unformatted state. Every file of
 * the (cached) watch list with an mtime after the {@link bashStarted} time (minus 1 s for coarse file systems, 5 s on
 * file systems with slow stats, whose mtimes lag the clock) goes through {@link formatOnDisk}; on such a file system
 * ({@link statsAreSlow}) only the files git reports as changed ({@link gitChanged}) are stat-ed. False positives end
 * at its digest and git checks. {@link fileChanged} later sees the
 * recorded digest and stays silent, so nothing is formatted or reported twice. Does nothing without a preceding
 * `bash_started`, a dprint config or a watch list.
 *
 * @param args - Hook input: `cwd`, `agent_id`, `session_id`, `scratchpad_dir`, `tool_use_id` and `hook_event_name`
 * (`PostToolUse`, or `PostToolUseFailure` for a Bash call that exited non-zero).
 * @returns A PostToolUse (or PostToolUseFailure) notice naming the reformatted files, else `{}` (fail open).
 */
export async function bashFinished(args: BashFinishedInput = {}, signal?: AbortSignal): Promise<HookResult> {
  try {
    const k = overrideKey(args);
    const since = bashStart.get(bashKey(args));
    bashStart.delete(bashKey(args));
    const sc = scopeOf(args);
    if (since === undefined || !sc || findConfig(sc.root) === null) return {};
    // the list is cached per root and may have been read by a call with another (or no) scratchpad: apply this call's
    const scratch = sc.realScratch;
    const list = (await cachedWatchList(sc)).filter(
      (f) => scratch === null || !(f.real === scratch || f.real.startsWith(scratch + path.sep)),
    );
    // on a slow file system stat only what git reports as changed; otherwise (and without git) every file is checked
    const slow = statsAreSlow(list);
    // git only pays off for a long list (a short one is cheap to stat even on 9P); a negative override forces it
    const changed = slow && (list.length >= STAT_SAMPLE || SLOW_STAT_MS < 0) ? await gitChanged(sc.root) : null;
    const slack = slow ? MTIME_SLACK_MS.slow : MTIME_SLACK_MS.fast;
    const touched = (changed ? list.filter((f) => changed(f.real)) : list).filter((f) => {
      try {
        return statSync(f.fp).mtimeMs > since - slack;
      } catch {
        return false; // deleted meanwhile
      }
    });
    const formatted = new Set<string>();
    await Promise.all(touched.map(async (f) => {
      // scoped again: the cached real path is stale if the Bash call swapped the file for a symlink (to a file outside
      // the cwd, or under node_modules, vendor, ...), and formatOnDisk reads and writes through the path
      const s = inScope(sc, f.fp);
      if (s && (await formatOnDisk(sc, s, signal))) formatted.add(s.fp);
    }));
    // a FileChanged that fired mid-Bash may have formatted a file first (then formatOnDisk above saw nothing to do)
    // and queued its notice: report it here, after the formats
    for (const f of takeNotices(k)) formatted.add(f);
    // PostToolUseFailure too: a Bash call that exits non-zero fires that event, not PostToolUse
    return formatted.size ? notice(args, args.hook_event_name === "PostToolUseFailure" ? "PostToolUseFailure" : "PostToolUse", [...formatted].sort()) : {};
  } catch (e) {
    process.stderr.write(
      `[dprint-hooks] bash_finished failed open: ${errText(e)}\n`,
    );
    return {};
  }
}

/**
 * PreToolUse and UserPromptSubmit hook: hand the model the reformats {@link fileChanged} queued since the last drain.
 *
 * @param args - Hook input: `hook_event_name`, `cwd`, `agent_id` and `session_id`.
 * @returns A notice naming the files, else `{}`; each file is reported once, and only to the session/agent it was queued for.
 */
export function drainNotices(args: DrainNoticesInput = {}): HookResult {
  const k = overrideKey(args);
  if (!args.hook_event_name) return {};
  const files = takeNotices(k);
  return files.size ? notice(args, args.hook_event_name, [...files].sort()) : {};
}

/**
 * Line counter for ascending offsets: one forward scan over the document for all calls.
 *
 * @param text - Document.
 * @returns Function mapping a character offset to its zero-based line (number of `\n` before it); offsets must
 * not decrease between calls.
 */
const lineCursor = (text: string): (idx: number) => number => {
  let n = 0;
  let nl = text.indexOf("\n");
  return (idx) => {
    while (nl !== -1 && nl < idx) {
      n++;
      nl = text.indexOf("\n", nl + 1);
    }
    return n;
  };
};

/**
 * Filter dprint's answer down to a real change.
 *
 * @param F - dprint's result (`null` for no edits).
 * @param input - Text that was formatted.
 * @returns The formatted text, or `null` when dprint changed nothing or answered an empty file for non-empty
 * input (treated as a failure).
 */
const changed = (F: string | null, input: string): string | null => F === null || F === input || (F === "" && input !== "") ? null : F;

/**
 * Build the hook output that replaces the tool input.
 *
 * @param updatedInput - New `Write`/`Edit` tool input.
 * @param fp - Absolute file path, named in the notice.
 * @returns The PreToolUse output with the reformat notice.
 */
function done(updatedInput: Record<string, unknown>, fp: string): HookResult {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput,
      additionalContext: `dprint: reformatted ${fp}; re-read it before further string-based edits. This reformat is intentional and exempt from "surgical/minimal-diff" change-scope rules — do not revert or redo it by hand to shrink the diff.`,
    },
  };
}

/**
 * PreToolUse `Write|Edit` hook: format the write or edit via `dprint lsp` before it lands.
 *
 * @remarks
 * Write: whole-file `formatting` of `content`. Edit: apply the edit in memory, whole-document `formatting` of
 * the edited text, then {@link trimToEdit} keeps the result a minimal `old_string`/`new_string` pair, accepted
 * when it reproduces dprint's output, or else formats exactly like it (one extra whole-document format). Only files
 * {@link inScope} of {@link scopeOf} are formatted: real path (symlinks resolved, dangling links rejected)
 * inside the effective cwd, not an {@link isExcludedPath} path, not gitignored ({@link isGitIgnored}) and not
 * inside the session scratchpad; without
 * a known cwd nothing is formatted. Nothing is formatted (and no `dprint lsp`
 * spawned) unless the effective cwd or an ancestor holds one of `CONFIG_NAMES` (`findConfig`, never above the git repository or worktree root). Edits on CRLF files are trimmed on the
 * LF-normalized text Claude Code's Edit matches against.
 *
 * @param args - Hook input: `cwd`, `session_id`, `agent_id`, `scratchpad_dir`, `tool_name` and `tool_input`.
 * @returns The rewritten tool input, or `{}` on every guard and error (fail open).
 */
export async function formatPre(
  args: FormatPreInput = {},
  signal?: AbortSignal,
): Promise<HookResult> {
  try {
    const ti = args.tool_input ?? {};
    // only files whose real path is inside the effective cwd and outside the scratchpad; no known cwd: skip
    const sc = scopeOf(args);
    const s = sc && inScope(sc, ti.file_path ?? "");
    if (!sc || !s) return {};
    const root = sc.root;
    const fp = s.fp;
    // formatting is opt-in: only when the effective cwd, or an ancestor up to the git repo/worktree root, holds a dprint config
    if (findConfig(root) === null) return {};
    // oversized documents pass through unformatted (upper bound for an Edit: file plus new_string); no git spawn
    if (args.tool_name === "Write" && overCap(Buffer.byteLength(ti.content ?? ""), fp)) return {};
    if (args.tool_name === "Edit" && overCap(statSync(fp).size + Buffer.byteLength(ti.new_string ?? ""), fp)) return {}; // ENOENT -> catch -> {}
    // user decision: gitignored files are never formatted
    if (await isGitIgnored(s.real)) return {};
    // cancelled meanwhile: spawn and format nothing (checked again before the second Edit format)
    if (signal?.aborted) return {};
    const uri = pathToFileURL(fp).href;

    if (args.tool_name === "Write") {
      const content = ti.content ?? "";
      const F = await client(root).format(uri, content);
      const out = changed(F, content);
      if (out === null) return {};
      return done({ file_path: fp, content: out }, fp);
    }

    if (args.tool_name === "Edit") {
      // Claude Code's Edit matches old_string against the file with CRLF normalized to LF and writes the file's
      // own line endings back (verified in a real session), so trim on that LF view: an old_string carrying
      // "\r\n" would be refused as not found. A lone "\r" left after normalizing is not handled: fail open.
      const O = readFileSync(fp, "utf8").replaceAll("\r\n", "\n"); // ENOENT -> catch -> {}
      if (O.includes("\r")) return {};
      let oldStr = ti.old_string ?? "";
      const newStr = ti.new_string ?? "";
      const replaceAll = ti.replace_all === "true"; // template-substituted, so always a string
      let M = applyEdit(O, oldStr, newStr, replaceAll);
      if (M === null) return {};
      // Claude Code's Edit with an empty new_string also deletes the line break after old_string (replace_all: only
      // where one follows), so the intended result is that of the widened old_string (uniqueness was checked above)
      if (newStr === "" && !oldStr.endsWith("\n") && O.includes(oldStr + "\n")) {
        oldStr += "\n";
        M = applyEdit(O, oldStr, newStr, replaceAll);
        if (M === null) return {};
      }

      // occurrences of old_string in O, non-overlapping left to right (as applyEdit/split replace them)
      const occ: number[] = [];
      for (
        let i = O.indexOf(oldStr);
        i !== -1;
        i = replaceAll ? O.indexOf(oldStr, i + oldStr.length) : -1
      ) {
        occ.push(i);
      }
      // occ is ascending and non-overlapping and oldStr is non-empty, so the cursor offsets never decrease
      const lineAt = lineCursor(O);
      const editLines = occ.map((i): [number, number] => [lineAt(i), lineAt(i + oldStr.length - 1)]);

      const lsp = client(root);
      const F = await lsp.format(uri, M);
      const out = changed(F, M);
      if (out === null) return {};
      const r = trimToEdit(O, out, editLines);
      if (!r) return {};
      // the line diff may align part of the edit (or a moved line) into a dropped hunk; a faithful trim formats
      // exactly like the intended edit, anything else would lose or duplicate content
      const R = O.replace(r.oldString, () => r.newString);
      // out is format(M) (non-null here); R === out is a lossless trim and needs no extra formats
      if (signal?.aborted) return {};
      if (R !== out && out !== ((await lsp.format(uri, R)) ?? R)) return {};
      return done(
        {
          file_path: fp,
          old_string: r.oldString,
          new_string: r.newString,
          replace_all: false,
        },
        fp,
      );
    }

    return {};
  } catch (e) {
    process.stderr.write(
      `[dprint-hooks] format_pre failed open: ${errText(e)}\n`,
    );
    return {};
  }
}
