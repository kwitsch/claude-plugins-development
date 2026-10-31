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
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { findConfig } from "../skills/dprint/find-config.mjs";
import type { CwdChangedInput, FileChangedInput, FileWrittenInput, FormatPreInput, WorktreeEnteredInput, WorktreeExitedInput } from "./hook-inputs.mjs";
import { DprintLsp, type LspRange } from "./lsp.mjs";

/** Hook output: empty (`{}`) to let the tool call through unchanged, else the rewritten tool input. */
export type HookResult = {
  /** PreToolUse output; absent when the hook leaves the tool call alone. */
  hookSpecificOutput?: {
    /** Always `PreToolUse`. */
    hookEventName: "PreToolUse";
    /** Replacement for the whole `Write`/`Edit` tool input. */
    updatedInput: Record<string, unknown>;
    /** Notice to the model that the file was reformatted on purpose. */
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
 * once in `original`.
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
  for (let up = true;; up = !up) {
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
      old.dispose();
      clients.delete(k);
    }
  }
  clients.set(key, c);
  return c;
};

/** Most `dprint lsp` children kept alive; the least recently used one is disposed beyond it. */
const MAX_CLIENTS = 8;

/** FileChanged events formatted at once; later ones are dropped, so a burst cannot grow an unbounded backlog. */
const MAX_PENDING_CHANGES = 50;

/** FileChanged events currently inside {@link fileChanged}. */
let pendingChanges = 0;

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
  for (const c of clients.values()) c.dispose();
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

/** Strict UTF-8 decoder: throws on invalid bytes. */
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** `execFile` returning a promise of `{ stdout, stderr }`. */
const execFileAsync = promisify(execFile);

/**
 * Whether git ignores a file (`git check-ignore`); tracked files never count as ignored.
 *
 * @remarks
 * Runs in the nearest existing ancestor directory of the file, so a nested repository or submodule applies its own
 * ignore rules and a Write to a new directory still resolves. No git, no repository or a timeout mean "not ignored".
 *
 * @param fp - Absolute file path.
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
      `[dprint-hooks] file_written failed open: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
  return {};
}

/**
 * FileChanged hook: format a watched file inside the cwd on disk after a change not made by Edit/Write.
 *
 * @remarks
 * Skips `unlink` events, files out of {@link inScope}, cwds without a dprint config, files with a lone `\r`,
 * content equal to the {@link written} digest, and (user decision) gitignored files and tracked files unchanged
 * against the git index (`git status --porcelain` empty, e.g. after checkout/pull/reset/stash); when git fails or
 * is absent the file is formatted. CRLF files are formatted
 * on their LF view and written back with CRLF. At most {@link MAX_PENDING_CHANGES} events run at once (the rest
 * are dropped) on a `dprint lsp` of their own.
 * The whole file is formatted via `textDocument/formatting` and written in place only when dprint changed it and
 * the file did not change meanwhile. Never returns `watchPaths`, so Claude Code keeps its watch list.
 *
 * @param args - Hook input: `cwd`, `agent_id`, `session_id`, `scratchpad_dir`, `file_path` and `event`.
 * @returns `{}` (fail open on every error).
 */
export async function fileChanged(
  args: FileChangedInput = {},
): Promise<HookResult> {
  // a burst (codegen, formatter run) must not build an unbounded backlog: later events are dropped
  if (pendingChanges >= MAX_PENDING_CHANGES) return {};
  pendingChanges++;
  try {
    if (args.event === "unlink") return {};
    const sc = scopeOf(args);
    const s = sc && inScope(sc, args.file_path ?? "");
    if (!sc || !s || findConfig(sc.root) === null) return {};
    // fatal decoder: a non-UTF-8 file throws (fails open) instead of being rewritten with U+FFFD
    const text = utf8.decode(readFileSync(s.fp));
    if (written.get(s.real) === digest(text)) return {};
    // CRLF files are formatted on their LF view (as formatPre's Edit does) and written back with CRLF; a lone "\r" fails open
    const lf = text.replaceAll("\r\n", "\n");
    if (lf.includes("\r")) return {};
    // user decision: gitignored files are never formatted
    if (await isGitIgnored(s.fp)) return {};
    // user decision: a tracked file equal to the git index (git restored it) is left alone; --no-optional-locks
    // keeps .git/index.lock free for the user's git, cwd = dirname picks the nearest repository (nested repos, submodules)
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["--no-optional-locks", "status", "--porcelain", "--", s.fp],
        { cwd: path.dirname(s.fp), encoding: "utf8", timeout: 10_000 },
      );
      if (stdout === "") return {};
    } catch {
      // no git, not a repository or timeout: format
    }
    // own client: whole-file formats here never queue in front of a Write/Edit format_pre call
    const out = changed(
      await client(sc.root, sc.root + "\0file_changed").format(pathToFileURL(s.fp).href, lf),
      lf,
    );
    if (out === null) return {};
    const final = text === lf ? out : out.replaceAll("\n", "\r\n");
    // a write that landed while dprint was formatting wins
    if (utf8.decode(readFileSync(s.fp)) !== text) return {};
    // an Edit/Write record that landed during the awaits wins (keeps trimToEdit's minimal diff)
    if (written.get(s.real) === digest(text)) return {};
    writeFileSync(s.fp, final);
    written.set(s.real, digest(final)); // after the write: a failed write records nothing
    return {};
  } catch (e) {
    process.stderr.write(
      `[dprint-hooks] file_changed failed open: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return {};
  } finally {
    pendingChanges--;
  }
}

/**
 * Zero-based line of a character offset, without copying the prefix.
 *
 * @param text - Document.
 * @param idx - Character offset in `text`.
 * @returns Number of `\n` before `idx`.
 */
const lineOf = (text: string, idx: number): number => {
  let n = 0;
  for (
    let i = text.indexOf("\n");
    i !== -1 && i < idx;
    i = text.indexOf("\n", i + 1)
  ) {
    n++;
  }
  return n;
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
 * Write: whole-file `formatting` of `content`. Edit: apply the edit in memory, `rangeFormatting` over the
 * edited lines, then {@link trimToEdit} keeps the result a minimal `old_string`/`new_string` pair, accepted
 * only when the trimmed result formats (whole document) exactly like the intended edit. Only files
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
    // user decision: gitignored files are never formatted
    if (await isGitIgnored(fp)) return {};
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
      const oldStr = ti.old_string ?? "";
      const newStr = ti.new_string ?? "";
      const replaceAll = ti.replace_all === "true"; // template-substituted, so always a string
      const M = applyEdit(O, oldStr, newStr, replaceAll);
      if (M === null) return {};

      // occurrences of old_string in O, non-overlapping left to right (as applyEdit/split replace them)
      const occ: number[] = [];
      for (
        let i = O.indexOf(oldStr);
        i !== -1;
        i = replaceAll ? O.indexOf(oldStr, i + oldStr.length) : -1
      ) {
        occ.push(i);
      }
      const editLines = occ.map((i): [number, number] => [
        lineOf(O, i),
        lineOf(O, i + oldStr.length - 1),
      ]);

      // full lines of M from the first replacement to the last inserted char (insertion offset if new is empty)
      const lastStart = occ[occ.length - 1]
        + (occ.length - 1) * (newStr.length - oldStr.length);
      const endLine = lineOf(
        M,
        newStr ? lastStart + newStr.length - 1 : lastStart,
      );
      const mLines = M.split("\n");
      const range: LspRange = {
        start: { line: lineOf(M, occ[0]), character: 0 },
        end: endLine + 1 < mLines.length
          ? { line: endLine + 1, character: 0 }
          : { line: endLine, character: mLines[endLine].length },
      };

      const lsp = client(root);
      const F = await lsp.format(uri, M, range);
      const out = changed(F, M);
      if (out === null) return {};
      const r = trimToEdit(O, out, editLines);
      if (!r) return {};
      // the line diff may align part of the edit (or a moved line) into a dropped hunk; a faithful trim formats
      // exactly like the intended edit, anything else would lose or duplicate content
      const R = O.replace(r.oldString, () => r.newString);
      if (
        ((await lsp.format(uri, M)) ?? M) !== ((await lsp.format(uri, R)) ?? R)
      ) {
        return {};
      }
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
      `[dprint-hooks] format_pre failed open: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return {};
  }
}
