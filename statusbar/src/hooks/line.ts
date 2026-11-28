/**
 * The pure part of statusbar: the formatter that prints the line of the user's `statusline-command.sh`. It holds no
 * `$` (only `register.ts` may use it); the build bundles this module into the hook's plugin output.
 *
 * @packageDocumentation
 */

/** What the line is built from; a percentage is undefined when Claude Code has none yet. */
export type LineInput = {
  /** The session's working directory. */
  cwd: string;
  /** Whether `cwd` lies in a git repository. */
  isGit: boolean;
  /** The branch, the short hash of a detached HEAD, or `""`. */
  branch: string;
  /** Context fill, 0-100. */
  context?: number;
  /** Used share of the 5-hour quota, 0-100. */
  fiveHour?: number;
  /** Used share of the 7-day quota, 0-100. */
  sevenDay?: number;
};

/** Red, `\033[0;31m`. */
const RED = "\x1b[0;31m";
/** Green, `\033[0;32m`. */
const GREEN = "\x1b[0;32m";
/** Yellow, `\033[0;33m`. */
const YELLOW = "\x1b[0;33m";
/** Reset, `\033[0m`. */
const RESET = "\x1b[0m";
/** Folder glyph, U+1F4C2. */
const FOLDER = "\u{1F4C2}";
/** Branch glyph, U+2387. */
const BRANCH = "\u{2387}";
/** Context glyph with VS16, U+1F5C3 U+FE0F. */
const CONTEXT = "\u{1F5C3}\u{FE0F}";
/** 5-hour glyph, U+1F554 (no VS16). */
const FIVE_HOUR = "\u{1F554}";
/** 7-day glyph with VS16, U+1F5D3 U+FE0F. */
const SEVEN_DAY = "\u{1F5D3}\u{FE0F}";

/**
 * Rounds half to even, as glibc `printf '%.0f'` does.
 *
 * @param x - A finite number.
 * @returns The nearest integer, ties to the even one; never `-0`.
 */
function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  const r = d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
  return r === 0 ? 0 : r;
}

/**
 * Wraps text in a colour and the reset code, as the script's `printf "${COLOR}...${RESET}"`.
 *
 * @param color - The ANSI code, or undefined for no colour.
 * @param text - The segment text.
 * @returns The segment.
 */
function paint(color: string | undefined, text: string): string {
  return color === undefined ? text : `${color}${text}${RESET}`;
}

/**
 * A percentage that counts as present.
 *
 * @param v - The value.
 * @returns `v` when finite, else undefined.
 */
function finite(v: number | undefined): number | undefined {
  return v !== undefined && Number.isFinite(v) ? v : undefined;
}

/**
 * Strips trailing `/` and `\` separators.
 *
 * @param path - A path.
 * @returns The path without trailing separators (`""` for a root).
 */
function stripSep(path: string): string {
  return path.replace(/[/\\]+$/, "");
}

/**
 * The index of the last `/` or `\`.
 *
 * @param path - A path.
 * @returns The index, or -1.
 */
function lastSep(path: string): number {
  return Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
}

/**
 * The line `statusline-command.sh` prints, without its trailing newline: folder (red outside git), branch, context %,
 * 5-hour % and, from 80 %, 7-day %, joined with `" | "`.
 *
 * @param input - What the line is built from.
 * @returns The ANSI line.
 */
export function statusLine(input: LineInput): string {
  const trimmed = stripSep(input.cwd);
  const folder = trimmed.slice(lastSep(trimmed) + 1) || input.cwd;
  const parts = [paint(input.isGit ? undefined : RED, `${FOLDER} ${folder}`)];
  if (input.isGit && input.branch !== "") parts.push(`${BRANCH} ${input.branch}`);
  const context = finite(input.context);
  if (context === undefined) {
    parts.push(`${CONTEXT} 0%`);
  } else {
    const p = roundHalfEven(context);
    parts.push(paint(p <= 60 ? GREEN : p <= 80 ? YELLOW : RED, `${CONTEXT} ${p}%`));
  }
  const five = finite(input.fiveHour);
  if (five === undefined) {
    parts.push(`${FIVE_HOUR} 0%`);
  } else {
    const p = roundHalfEven(five);
    parts.push(paint(p >= 90 ? RED : p >= 80 ? YELLOW : GREEN, `${FIVE_HOUR} ${p}%`));
  }
  const seven = finite(input.sevenDay);
  if (seven !== undefined) {
    const p = roundHalfEven(seven);
    if (p >= 80) parts.push(paint(p >= 90 ? RED : YELLOW, `${SEVEN_DAY} ${p}%`));
  }
  return parts.join(" | ");
}
