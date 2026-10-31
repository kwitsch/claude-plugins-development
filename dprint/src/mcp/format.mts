/**
 * The `format_pre`, `cwd_changed` and `worktree_entered` hook handlers plus the pure helpers behind them.
 *
 * @remarks
 * Helpers: {@link applyEdit} (Claude Code's Edit semantics, copied from universal-format), {@link lineDiff}
 * (line LCS) and {@link trimToEdit} (keep only the diff hunks that touch the edit).
 *
 * @packageDocumentation
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CONFIG_NAMES } from "../skills/init-dprint/config-names.mjs";
import type { CwdChangedInput, FormatPreInput, WorktreeEnteredInput, WorktreeExitedInput } from "./hook-inputs.mjs";
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
 * @returns The cached or new client.
 */
const client = (cwd: string): DprintLsp => {
  let c = clients.get(cwd);
  if (!c) clients.set(cwd, c = new DprintLsp({ cwd }));
  return c;
};

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
 * @param cwd - New working directory; ignored when empty.
 * @returns `{}`: these hooks never change the tool call.
 */
function setCwd(
  args: { agent_id?: string; session_id?: string },
  cwd: string | undefined,
): HookResult {
  const key = overrideKey(args);
  if (key && cwd) cwdOverrides.set(key, cwd);
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
 * only when the trimmed result formats (whole document) exactly like the intended edit. Files outside the
 * working directory and {@link isExcludedPath} paths are skipped. Nothing is formatted (and no `dprint lsp`
 * spawned) unless the effective cwd itself holds one of `CONFIG_NAMES`. Edits on CRLF files are trimmed on the
 * LF-normalized text Claude Code's Edit matches against.
 *
 * @param args - Hook input: `cwd`, `session_id`, `agent_id`, `tool_name` and `tool_input`.
 * @returns The rewritten tool input, or `{}` on every guard and error (fail open).
 */
export async function formatPre(
  args: FormatPreInput = {},
): Promise<HookResult> {
  try {
    const ti = args.tool_input ?? {};
    let fp = ti.file_path ?? "";
    if (!fp) return {};
    const key = overrideKey(args);
    const cwd = (key && cwdOverrides.get(key)) || args.cwd || "";
    if (!path.isAbsolute(fp)) {
      if (!cwd) return {};
      fp = path.resolve(cwd, fp);
    }
    const root = cwd || process.cwd();
    const rel = path.relative(root, fp);
    // outside the lsp's root no dprint.json applies; excluded paths are never ours to format
    if (
      rel === ".."
      || rel.startsWith(".." + path.sep)
      || path.isAbsolute(rel)
      || isExcludedPath(rel)
    ) {
      return {};
    }
    // formatting is opt-in: only when the effective cwd holds a dprint config (cwd only, no ancestors)
    if (!CONFIG_NAMES.some((n) => existsSync(path.join(root, n)))) return {};
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
