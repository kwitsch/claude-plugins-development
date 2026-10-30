// format.mts — the format_pre hook handler (added later) plus its pure helpers: applyEdit (copied from
// universal-format), lineDiff (line LCS) and trimToEdit (keep only the diff hunks that touch the edit).
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
    if (a.length * b.length > 25_000_000) {
        // too big for the table: one hunk over the middle that differs (same shape, never fails)
        let p = 0;
        while (p < a.length && p < b.length && a[p] === b[p])
            p++;
        let s = 0;
        while (s < a.length - p &&
            s < b.length - p &&
            a[a.length - 1 - s] === b[b.length - 1 - s])
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
    const a = original.split("\n");
    const b = formatted.split("\n");
    // byte-exact text of lines[x, y): the last element is the trailing partial line, an empty slice is ""
    const render = (lines, x, y) => lines.slice(x, y).join("\n") + (x < y && y < lines.length ? "\n" : "");
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
