// format.mts — the format_pre hook handler plus its pure helpers: applyEdit (copied from
// universal-format), lineDiff (line LCS) and trimToEdit (keep only the diff hunks that touch the edit).
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DprintLsp, type LspRange } from "./lsp.mjs";

export type HookResult = {
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    updatedInput: Record<string, unknown>;
    additionalContext: string;
  };
};

/** a[aStart, aEnd) was replaced by b[bStart, bEnd); half-open line indices. */
export type Hunk = {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
};

/** Claude Code's Edit semantics: null when oldStr is empty, not found, or (without replaceAll) non-unique. */
export function applyEdit(
  current: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean,
): string | null {
  if (oldStr === "") return null;
  if (replaceAll)
    return current.includes(oldStr) ? current.split(oldStr).join(newStr) : null;
  const idx = current.indexOf(oldStr);
  if (idx === -1) return null;
  if (current.indexOf(oldStr, idx + oldStr.length) !== -1) return null; // non-unique
  return current.slice(0, idx) + newStr + current.slice(idx + oldStr.length);
}

/** LCS line diff: ordered, non-overlapping hunks separated by at least one common line. */
export function lineDiff(a: string[], b: string[]): Hunk[] {
  if (a.length * b.length > 25_000_000) {
    // too big for the table: one hunk over the middle that differs (same shape, never fails)
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0;
    while (
      s < a.length - p &&
      s < b.length - p &&
      a[a.length - 1 - s] === b[b.length - 1 - s]
    )
      s++;
    return p === a.length && p === b.length
      ? []
      : [{ aStart: p, aEnd: a.length - s, bStart: p, bEnd: b.length - s }];
  }
  // shortcut: O(n·m) memory on lines; fine for source files, upgrade to Myers if a >20k-line file shows up
  const n = a.length;
  const m = b.length;
  // L[i][j] = LCS length of a[i..] and b[j..]; min(n, m) <= 5000 under the guard, so 16 bits suffice
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] =
        a[i] === b[j]
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
 * Keep only the hunks of diff(original, formatted) that intersect or touch an edited line range
 * (inclusive [start, end] line indices in original) and return them as one Edit whose oldString is
 * verbatim original text occurring exactly once; null when nothing is kept or no unique oldString exists.
 */
export function trimToEdit(
  original: string,
  formatted: string,
  editLines: Array<[number, number]>,
): { oldString: string; newString: string } | null {
  const a = original.split("\n");
  const b = formatted.split("\n");
  // byte-exact text of lines[x, y): the last element is the trailing partial line, an empty slice is ""
  const render = (lines: string[], x: number, y: number) =>
    lines.slice(x, y).join("\n") + (x < y && y < lines.length ? "\n" : "");
  const hunks = lineDiff(a, b);
  const kept: number[] = [];
  hunks.forEach((h, k) => {
    if (editLines.some(([s, e]) => h.aStart <= e + 1 && h.aEnd >= s))
      kept.push(k);
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
  for (let up = true; ; up = !up) {
    const oldString = render(a, aA, aB);
    const i = original.indexOf(oldString);
    if (
      oldString !== "" &&
      i !== -1 &&
      original.indexOf(oldString, i + 1) === -1
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

// One `dprint lsp` for the server's lifetime; its cwd/rootUri come from the first hook call.
let lsp: DprintLsp | null = null;
const client = (cwd: unknown) =>
  (lsp ??= new DprintLsp({
    cwd: typeof cwd === "string" && cwd ? cwd : process.cwd(),
  }));

/** Kill the dprint lsp child, if any (MCP stdin closed). */
export function disposeLsp(): void {
  lsp?.dispose();
  lsp = null;
}

const lineOf = (text: string, idx: number) =>
  text.slice(0, idx).split("\n").length - 1;

function done(updatedInput: Record<string, unknown>, fp: string): HookResult {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput,
      additionalContext: `dprint: reformatted ${fp}; re-read it before further string-based edits. This reformat is intentional and exempt from "surgical/minimal-diff" change-scope rules — do not revert or redo it by hand to shrink the diff.`,
    },
  };
}

/** PreToolUse Write|Edit: format via dprint lsp and return updatedInput. {} on every guard/error (fail open). */
export async function formatPre(args: any): Promise<HookResult> {
  try {
    const ti = args?.tool_input ?? {};
    let fp: string = typeof ti.file_path === "string" ? ti.file_path : "";
    if (!fp) return {};
    if (!path.isAbsolute(fp)) {
      if (!args.cwd) return {};
      fp = path.resolve(args.cwd, fp);
    }
    const uri = pathToFileURL(fp).href;

    if (args.tool_name === "Write") {
      const content: string = typeof ti.content === "string" ? ti.content : "";
      const F = await client(args.cwd).format(uri, content);
      if (F === null || F === content || (F === "" && content !== ""))
        return {};
      return done({ file_path: fp, content: F }, fp);
    }

    if (args.tool_name === "Edit") {
      const O = readFileSync(fp, "utf8"); // ENOENT -> catch -> {}
      const oldStr: string =
        typeof ti.old_string === "string" ? ti.old_string : "";
      const newStr: string =
        typeof ti.new_string === "string" ? ti.new_string : "";
      const replaceAll = ti.replace_all === true || ti.replace_all === "true";
      const M = applyEdit(O, oldStr, newStr, replaceAll);
      if (M === null) return {};

      // occurrences of old_string in O, non-overlapping left to right (as applyEdit/split replace them)
      const occ: number[] = [];
      for (
        let i = O.indexOf(oldStr);
        i !== -1;
        i = replaceAll ? O.indexOf(oldStr, i + oldStr.length) : -1
      )
        occ.push(i);
      const editLines = occ.map((i): [number, number] => [
        lineOf(O, i),
        lineOf(O, i + oldStr.length - 1),
      ]);

      // full lines of M from the first replacement to the last inserted char (insertion offset if new is empty)
      const lastStart =
        occ[occ.length - 1] +
        (occ.length - 1) * (newStr.length - oldStr.length);
      const endLine = lineOf(
        M,
        newStr ? lastStart + newStr.length - 1 : lastStart,
      );
      const mLines = M.split("\n");
      const range: LspRange = {
        start: { line: lineOf(M, occ[0]), character: 0 },
        end:
          endLine + 1 < mLines.length
            ? { line: endLine + 1, character: 0 }
            : { line: endLine, character: mLines[endLine].length },
      };

      const F = await client(args.cwd).format(uri, M, range);
      if (F === null || F === M || (F === "" && M !== "")) return {};
      const r = trimToEdit(O, F, editLines);
      if (!r) return {};
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
  } catch (e: any) {
    process.stderr.write(
      `[dprint-hooks] format_pre failed open: ${e?.message ?? e}\n`,
    );
    return {};
  }
}
