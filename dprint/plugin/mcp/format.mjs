// format.mts — the format_pre hook handler plus its pure helpers: applyEdit (copied from
// universal-format), lineDiff (line LCS) and trimToEdit (keep only the diff hunks that touch the edit).
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DprintLsp } from "./lsp.mjs";
/** Claude Code's Edit semantics: null when oldStr is empty, not found, or (without replaceAll) non-unique. */
export function applyEdit(current, oldStr, newStr, replaceAll) {
    if (oldStr === "")
        return null;
    if (replaceAll)
        return current.includes(oldStr) ? current.split(oldStr).join(newStr) : null;
    const idx = current.indexOf(oldStr);
    if (idx === -1)
        return null;
    if (current.indexOf(oldStr, idx + oldStr.length) !== -1)
        return null; // non-unique
    return current.slice(0, idx) + newStr + current.slice(idx + oldStr.length);
}
/** LCS line diff: ordered, non-overlapping hunks separated by at least one common line. */
export function lineDiff(a, b) {
    // the table only needs the changed middle: strip the common prefix and suffix first
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre])
        pre++;
    let suf = 0;
    while (suf < a.length - pre &&
        suf < b.length - pre &&
        a[a.length - 1 - suf] === b[b.length - 1 - suf])
        suf++;
    if (pre > 0 || suf > 0)
        return lineDiff(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf)).map((h) => ({
            aStart: h.aStart + pre,
            aEnd: h.aEnd + pre,
            bStart: h.bStart + pre,
            bEnd: h.bEnd + pre,
        }));
    // too big for the table: throw, formatPre fails open ({}) instead of returning a near whole-file edit
    if (a.length * b.length > 25_000_000)
        throw new Error("diff too large");
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
    const hunks = [];
    let cur = null;
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
        if (i < n && j < m && a[i] === b[j]) {
            if (cur)
                hunks.push(cur);
            cur = null;
            i++;
            j++;
            continue;
        }
        cur ??= { aStart: i, aEnd: i, bStart: j, bEnd: j };
        if (j < m && (i === n || L[i][j + 1] >= L[i + 1][j]))
            cur.bEnd = ++j;
        else
            cur.aEnd = ++i;
    }
    if (cur)
        hunks.push(cur);
    return hunks;
}
/**
 * Keep only the hunks of diff(original, formatted) that intersect or touch an edited line range
 * (inclusive [start, end] line indices in original) and return them as one Edit whose oldString is
 * verbatim original text occurring exactly once; null when nothing is kept or no unique oldString exists.
 */
export function trimToEdit(original, formatted, editLines) {
    // lines keep their terminator, so removing a final unterminated line also removes the "\n" before it
    const split = (t) => t.match(/[^\n]*\n|[^\n]+/g) ?? [];
    const a = split(original);
    const b = split(formatted);
    const render = (lines, x, y) => lines.slice(x, y).join("");
    const hunks = lineDiff(a, b);
    const kept = [];
    hunks.forEach((h, k) => {
        if (editLines.some(([s, e]) => h.aStart <= e + 1 && h.aEnd >= s))
            kept.push(k);
    });
    if (kept.length === 0)
        return null;
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
        if (oldString !== "" &&
            i !== -1 &&
            original.indexOf(oldString, i + 1) === -1) {
            const newString = render(b, bA, bB);
            return oldString === newString ? null : { oldString, newString };
        }
        // widen by one common line, alternating directions starting upward
        if (up && aA > lo) {
            aA--;
            bA--;
        }
        else if (aB < hi) {
            aB++;
            bB++;
        }
        else if (aA > lo) {
            aA--;
            bA--;
        }
        else
            return null;
    }
}
// One `dprint lsp` per working directory (rootUri decides which dprint.json applies), created lazily.
const clients = new Map();
const client = (cwd) => {
    let c = clients.get(cwd);
    if (!c)
        clients.set(cwd, (c = new DprintLsp({ cwd })));
    return c;
};
// EnterWorktree / CwdChanged move a session's or subagent's cwd without the hook payload's `cwd` following.
const cwdOverrides = new Map();
const overrideKey = (args) => typeof args?.agent_id === "string" && args.agent_id
    ? args.agent_id
    : typeof args?.session_id === "string"
        ? args.session_id
        : "";
function setCwd(args, cwd) {
    const key = overrideKey(args);
    if (key && typeof cwd === "string" && cwd)
        cwdOverrides.set(key, cwd);
    return {};
}
/** CwdChanged: use `new_cwd` for this session/agent's later format_pre calls. */
export const cwdChanged = (args) => Promise.resolve(setCwd(args, args?.new_cwd));
/** PostToolUse EnterWorktree: CwdChanged does not fire for it, so take the worktree path from the tool response. */
export const worktreeEntered = (args) => Promise.resolve(setCwd(args, args?.tool_response?.worktreePath));
/** Kill every dprint lsp child (MCP stdin closed). */
export function disposeLsp() {
    for (const c of clients.values())
        c.dispose();
    clients.clear();
}
// Same exclusions as universal-format: dependency/VCS dirs, other agents' worktrees, personal *.local.* files.
const isExcludedPath = (rel) => {
    const segs = rel.split(path.sep);
    return (segs.some((s) => s === "node_modules" || s === "vendor" || s === ".git") ||
        segs.some((s, i) => s === ".claude" &&
            (segs[i + 1] === "worktrees" || segs[i + 1] === "agent-memory")) ||
        segs[segs.length - 1].includes(".local."));
};
const lineOf = (text, idx) => text.slice(0, idx).split("\n").length - 1;
function done(updatedInput, fp) {
    return {
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            updatedInput,
            additionalContext: `dprint: reformatted ${fp}; re-read it before further string-based edits. This reformat is intentional and exempt from "surgical/minimal-diff" change-scope rules — do not revert or redo it by hand to shrink the diff.`,
        },
    };
}
/** PreToolUse Write|Edit: format via dprint lsp and return updatedInput. {} on every guard/error (fail open). */
export async function formatPre(args) {
    try {
        const ti = args?.tool_input ?? {};
        let fp = typeof ti.file_path === "string" ? ti.file_path : "";
        if (!fp)
            return {};
        const key = overrideKey(args);
        const hookCwd = typeof args.cwd === "string" ? args.cwd : "";
        const cwd = (key && cwdOverrides.get(key)) || hookCwd;
        if (!path.isAbsolute(fp)) {
            if (!cwd)
                return {};
            fp = path.resolve(cwd, fp);
        }
        const root = cwd || process.cwd();
        const rel = path.relative(root, fp);
        // outside the lsp's root no dprint.json applies; excluded paths are never ours to format
        if (rel === ".." ||
            rel.startsWith(".." + path.sep) ||
            path.isAbsolute(rel) ||
            isExcludedPath(rel))
            return {};
        const uri = pathToFileURL(fp).href;
        if (args.tool_name === "Write") {
            const content = typeof ti.content === "string" ? ti.content : "";
            const F = await client(root).format(uri, content);
            if (F === null || F === content || (F === "" && content !== ""))
                return {};
            return done({ file_path: fp, content: F }, fp);
        }
        if (args.tool_name === "Edit") {
            const O = readFileSync(fp, "utf8"); // ENOENT -> catch -> {}
            const oldStr = typeof ti.old_string === "string" ? ti.old_string : "";
            const newStr = typeof ti.new_string === "string" ? ti.new_string : "";
            const replaceAll = ti.replace_all === true || ti.replace_all === "true";
            const M = applyEdit(O, oldStr, newStr, replaceAll);
            if (M === null)
                return {};
            // occurrences of old_string in O, non-overlapping left to right (as applyEdit/split replace them)
            const occ = [];
            for (let i = O.indexOf(oldStr); i !== -1; i = replaceAll ? O.indexOf(oldStr, i + oldStr.length) : -1)
                occ.push(i);
            const editLines = occ.map((i) => [
                lineOf(O, i),
                lineOf(O, i + oldStr.length - 1),
            ]);
            // full lines of M from the first replacement to the last inserted char (insertion offset if new is empty)
            const lastStart = occ[occ.length - 1] +
                (occ.length - 1) * (newStr.length - oldStr.length);
            const endLine = lineOf(M, newStr ? lastStart + newStr.length - 1 : lastStart);
            const mLines = M.split("\n");
            const range = {
                start: { line: lineOf(M, occ[0]), character: 0 },
                end: endLine + 1 < mLines.length
                    ? { line: endLine + 1, character: 0 }
                    : { line: endLine, character: mLines[endLine].length },
            };
            const F = await client(root).format(uri, M, range);
            if (F === null || F === M || (F === "" && M !== ""))
                return {};
            const r = trimToEdit(O, F, editLines);
            if (!r)
                return {};
            return done({
                file_path: fp,
                old_string: r.oldString,
                new_string: r.newString,
                replace_all: false,
            }, fp);
        }
        return {};
    }
    catch (e) {
        process.stderr.write(`[dprint-hooks] format_pre failed open: ${e?.message ?? e}\n`);
        return {};
    }
}
