// Rows of the pure formatter in src/hooks/line.ts. Expected strings are written from the printf formats of the user's
// statusline-command.sh (ANSI codes, glyph bytes, thresholds, '%.0f' rounding), not from the source.
import { expect, test } from "vitest";
import { gitBranch, type GitFs, type LineInput, statusLine } from "../src/hooks/line.ts";

/** Red, `\033[0;31m`. */
const R = "\x1b[0;31m";
/** Green, `\033[0;32m`. */
const G = "\x1b[0;32m";
/** Yellow, `\033[0;33m`. */
const Y = "\x1b[0;33m";
/** Reset, `\033[0m`. */
const X = "\x1b[0m";
/** Folder glyph, U+1F4C2. */
const DIR = "\u{1F4C2}";
/** Branch glyph, U+2387. */
const BR = "\u{2387}";
/** Context glyph with VS16, U+1F5C3 U+FE0F. */
const CTX = "\u{1F5C3}\u{FE0F}";
/** 5-hour glyph, U+1F554 (no VS16). */
const H5 = "\u{1F554}";
/** 7-day glyph with VS16, U+1F5D3 U+FE0F. */
const D7 = "\u{1F5D3}\u{FE0F}";
/** A git repo on branch main. */
const BASE: LineInput = { cwd: "/work/proj", isGit: true, branch: "main" };
/** Folder and branch segments of {@link BASE}. */
const HEAD = `${DIR} proj | ${BR} main`;

/** Context rows: label, value, expected segment. */
const contextRows: [string, number | undefined, string][] = [
  ["undefined", undefined, `${CTX} 0%`],
  ["0", 0, `${G}${CTX} 0%${X}`],
  ["-0", -0, `${G}${CTX} 0%${X}`],
  ["60", 60, `${G}${CTX} 60%${X}`],
  ["60.5", 60.5, `${G}${CTX} 60%${X}`],
  ["61", 61, `${Y}${CTX} 61%${X}`],
  ["61.5", 61.5, `${Y}${CTX} 62%${X}`],
  ["80", 80, `${Y}${CTX} 80%${X}`],
  ["80.5", 80.5, `${Y}${CTX} 80%${X}`],
  ["81", 81, `${R}${CTX} 81%${X}`],
  ["NaN", Number.NaN, `${CTX} 0%`],
];
for (const [label, context, seg] of contextRows) {
  test(`context ${label}`, () => {
    expect(statusLine({ ...BASE, context })).toBe(`${HEAD} | ${seg} | ${H5} 0%`);
  });
}

/** 5-hour rows: label, value, expected segment. */
const fiveRows: [string, number | undefined, string][] = [
  ["undefined", undefined, `${H5} 0%`],
  ["79", 79, `${G}${H5} 79%${X}`],
  ["79.5", 79.5, `${Y}${H5} 80%${X}`],
  ["80", 80, `${Y}${H5} 80%${X}`],
  ["89", 89, `${Y}${H5} 89%${X}`],
  ["90", 90, `${R}${H5} 90%${X}`],
  ["Infinity", Number.POSITIVE_INFINITY, `${H5} 0%`],
];
for (const [label, fiveHour, seg] of fiveRows) {
  test(`5h ${label}`, () => {
    expect(statusLine({ ...BASE, fiveHour })).toBe(`${HEAD} | ${CTX} 0% | ${seg}`);
  });
}

/** 7-day rows: label, value, expected segment ("" = omitted). */
const sevenRows: [string, number | undefined, string][] = [
  ["undefined", undefined, ""],
  ["79", 79, ""],
  ["79.4", 79.4, ""],
  ["80", 80, `${Y}${D7} 80%${X}`],
  ["89", 89, `${Y}${D7} 89%${X}`],
  ["90", 90, `${R}${D7} 90%${X}`],
];
for (const [label, sevenDay, seg] of sevenRows) {
  test(`7d ${label}`, () => {
    expect(statusLine({ ...BASE, sevenDay })).toBe(`${HEAD} | ${CTX} 0% | ${H5} 0%${seg ? ` | ${seg}` : ""}`);
  });
}

/** Folder rows: label, input, expected line. */
const folderRows: [string, LineInput, string][] = [
  ["git repo with branch", BASE, `${HEAD} | ${CTX} 0% | ${H5} 0%`],
  ["not a git repo: red folder, no branch", { ...BASE, isGit: false }, `${R}${DIR} proj${X} | ${CTX} 0% | ${H5} 0%`],
  ["git with empty branch: no branch segment", { ...BASE, branch: "" }, `${DIR} proj | ${CTX} 0% | ${H5} 0%`],
  ["folder with a space", { ...BASE, cwd: "/work/my proj" }, `${DIR} my proj | ${BR} main | ${CTX} 0% | ${H5} 0%`],
  ["cwd /", { ...BASE, cwd: "/" }, `${DIR} / | ${BR} main | ${CTX} 0% | ${H5} 0%`],
  ["cwd /a/b/", { ...BASE, cwd: "/a/b/" }, `${DIR} b | ${BR} main | ${CTX} 0% | ${H5} 0%`],
  ["POSIX folder with a literal backslash", { ...BASE, cwd: "/work/my\\proj" }, `${DIR} my\\proj | ${BR} main | ${CTX} 0% | ${H5} 0%`],
  ["Windows path", { ...BASE, cwd: "C:\\work\\proj\\" }, `${DIR} proj | ${BR} main | ${CTX} 0% | ${H5} 0%`],
  [
    "all segments",
    { ...BASE, context: 42, fiveHour: 85, sevenDay: 95 },
    `${HEAD} | ${G}${CTX} 42%${X} | ${Y}${H5} 85%${X} | ${R}${D7} 95%${X}`,
  ],
];
for (const [label, input, line] of folderRows) {
  test(`line: ${label}`, () => {
    expect(statusLine(input)).toBe(line);
  });
}

/**
 * An in-memory `GitFs`: a path exists when it is a key or a directory above a key.
 *
 * @param files - Path to content.
 * @param failRead - A path whose read rejects although it exists.
 * @returns The fake.
 */
function memFs(files: Map<string, string>, failRead?: string): GitFs {
  return {
    exists: async (path) => files.has(path) || [...files.keys()].some((k) => k.startsWith(`${path}/`)),
    read: async (path) => {
      const text = files.get(path);
      if (path === failRead || text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
  };
}

/** A 40-hex object name. */
const SHA = "0123456789abcdef0123456789abcdef01234567";

/** Git rows: label, cwd, files, failing read, expected result. */
const gitRows: [string, string, [string, string][], string | undefined, { isGit: boolean; branch: string }][] = [
  ["repo root", "/r", [["/r/.git/HEAD", "ref: refs/heads/main\n"]], undefined, { isGit: true, branch: "main" }],
  ["subdirectory", "/r/a/b", [["/r/.git/HEAD", "ref: refs/heads/main\n"]], undefined, { isGit: true, branch: "main" }],
  ["trailing separator on cwd", "/r/a/", [["/r/.git/HEAD", "ref: refs/heads/main\n"]], undefined, { isGit: true, branch: "main" }],
  ["slash branch", "/r", [["/r/.git/HEAD", "ref: refs/heads/feature/x\n"]], undefined, { isGit: true, branch: "feature/x" }],
  ["detached HEAD", "/r", [["/r/.git/HEAD", `${SHA}\n`]], undefined, { isGit: true, branch: "0123456" }],
  ["detached HEAD, sha256", "/r", [["/r/.git/HEAD", `${SHA}${SHA.slice(0, 24)}\n`]], undefined, { isGit: true, branch: "0123456" }],
  ["linked worktree", "/w/sub", [["/w/.git", "gitdir: /r/.git/worktrees/w\n"], ["/r/.git/worktrees/w/HEAD", "ref: refs/heads/wt\n"]], undefined, { isGit: true, branch: "wt" }],
  ["relative gitdir", "/m", [["/m/.git", "gitdir: modules/m\n"], ["/m/modules/m/HEAD", "ref: refs/heads/dev\n"]], undefined, { isGit: true, branch: "dev" }],
  ["no .git up to /", "/x/y", [["/r/.git/HEAD", "ref: refs/heads/main\n"]], undefined, { isGit: false, branch: "" }],
  [".git file without gitdir", "/w", [["/w/.git", "something else\n"]], undefined, { isGit: false, branch: "" }],
  ["HEAD read rejects", "/r", [["/r/.git/HEAD", "ref: refs/heads/main\n"]], "/r/.git/HEAD", { isGit: true, branch: "" }],
  ["garbage HEAD", "/r", [["/r/.git/HEAD", "garbage\n"]], undefined, { isGit: true, branch: "" }],
  ["ref outside refs/heads", "/r", [["/r/.git/HEAD", "ref: refs/remotes/origin/main\n"]], undefined, { isGit: true, branch: "" }],
  ["POSIX backslash is no separator", "/w/a\\b", [["/w/a/.git/HEAD", "ref: refs/heads/main\n"]], undefined, { isGit: false, branch: "" }],
  [".git at the root", "/a", [["/.git/HEAD", "ref: refs/heads/root\n"]], undefined, { isGit: true, branch: "root" }],
];
for (const [label, cwd, files, failRead, expected] of gitRows) {
  test(`gitBranch: ${label}`, async () => {
    expect(await gitBranch(cwd, memFs(new Map(files), failRead))).toEqual(expected);
  });
}

test("gitBranch: a rejected .git file read propagates", async () => {
  await expect(gitBranch("/w", memFs(new Map([["/w/.git", "gitdir: /r\n"]]), "/w/.git"))).rejects.toThrow("ENOENT");
});
