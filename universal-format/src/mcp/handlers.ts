/**
 * The `format_pre` hook handler and its helpers. The contract is fail open: every guard failure and every caught error
 * returns `{}`, so the original Write/Edit proceeds untouched.
 *
 * @packageDocumentation
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { clearPrettierConfigCaches, formatInProcess, isPrettierIgnored, PRETTIER_CONFIG_FILENAMES, primePrettierIgnoreCache } from "./prettier.js";
import { EXT_MAP, type FormatTool, PRETTIER_LANGS, REGISTRY, selectFormatter } from "./registry.js";
import { walkToRoot } from "./util.js";

/**
 * Input of `format_pre` as the `input` template of `plugin/hooks/hooks.json` builds it. Trust boundary: every field
 * is checked before use. The substitution is text only, so a boolean arrives as the string `"true"` or `"false"`.
 */
export type FormatPreInput = {
  /** The session's working directory; a hint, never a gate. */
  cwd?: unknown;
  /** The session's scratchpad directory; files inside it are never formatted. An empty or relative value means none. */
  scratchpad_dir?: unknown;
  /** `Write` or `Edit`. */
  tool_name?: unknown;
  /** The tool's input; a field the tool call lacks arrives as an empty string. */
  tool_input?: {
    /** The target file. */
    file_path?: unknown;
    /** Write: the content. */
    content?: unknown;
    /** Edit: the text to replace. */
    old_string?: unknown;
    /** Edit: its replacement. */
    new_string?: unknown;
    /** Edit: replace every occurrence; a boolean or its string form. */
    replace_all?: unknown;
  };
};

/** What `format_pre` answers: `{}` (leave the tool call alone) or the rewritten tool input with a notice for the model. */
export type HookResult = {
  /** Never carries a `permissionDecision`: `allow` would approve every Write/Edit, `defer` would drop the rewrite. */
  hookSpecificOutput?: {
    /** The hook event. */
    hookEventName: "PreToolUse";
    /** The tool input that replaces the model's. */
    updatedInput: { file_path: string; content: string } | { file_path: string; old_string: string; new_string: string; replace_all: boolean };
    /** The notice the model reads. */
    additionalContext: string;
  };
};

/** How long a CLI formatter may run; the hook's `timeout` in `hooks.json` is the backstop. */
const SPAWN_TIMEOUT_MS = 30000;

/**
 * Whether one of Claude Code's own subtrees (`.claude/worktrees`, `.claude/agent-memory`) is part of a path.
 *
 * @param segments - The path's segments.
 * @returns True when the path leads into such a subtree.
 */
const hasClaudeInternal = (segments: string[]): boolean => segments.some((s, i) => s === ".claude" && (segments[i + 1] === "worktrees" || segments[i + 1] === "agent-memory"));

/**
 * Whether a base-relative path is never formatted: dependency and VCS state (`node_modules`, `vendor`, `.git`),
 * Claude Code's worktrees and agent memory, and personal override files (`*.local.*`). Must get the base-relative
 * path: the absolute path of a session inside its own worktree contains `.claude/worktrees`.
 *
 * @param rel - The path relative to the base directory.
 * @returns True when the path is excluded.
 */
export function isExcludedPath(rel: string): boolean {
  const segments = rel.split(path.sep);
  if (segments.some((s) => s === "node_modules" || s === "vendor" || s === ".git")) return true;
  return hasClaudeInternal(segments) || segments[segments.length - 1].includes(".local.");
}

/**
 * The path of `resolved` relative to `dir` when `dir` is it or contains it. Uses `path.relative`: a prefix test
 * answered "no" for every file when `dir` had a trailing separator or was `/`.
 *
 * @param dir - The directory.
 * @param resolved - The absolute path.
 * @returns The relative path, or null when `dir` does not contain it.
 */
function relativeIfContains(dir: string, resolved: string): string | null {
  const rel = path.relative(dir, resolved);
  return rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel) ? null : rel;
}

/** {@link findGitRoot} by directory, for the life of the process. */
const gitRootCache = new Map<string, string>();

/**
 * The nearest ancestor of a directory (inclusive) that holds a `.git` entry, file or directory (a worktree's and a
 * submodule's is a file). The walk ends at `home` without checking it: a dotfiles checkout there must not become the
 * project of an unrelated file.
 *
 * @param fileDir - The directory to start at.
 * @param home - The user's home directory.
 * @returns The directory, or `""` when none was found.
 */
function findGitRoot(fileDir: string, home: string): string {
  const cached = gitRootCache.get(fileDir);
  if (cached !== undefined) return cached;
  let found = "";
  walkToRoot(fileDir, (dir) => {
    if (home && dir === home) return true;
    if (!existsSync(path.join(dir, ".git"))) return false;
    found = dir;
    return true;
  });
  gitRootCache.set(fileDir, found);
  return found;
}

/** The config file names of dprint, a copy of `CONFIG_NAMES` in `dprint/src/skills/dprint/config-names.ts` (`tests/dprint-gate.test.ts` compares them). */
export const DPRINT_CONFIG_NAMES: readonly string[] = ["dprint.json", "dprint.jsonc", ".dprint.json", ".dprint.jsonc", ".config/dprint.json", ".config/dprint.jsonc"];

/**
 * Whether dprint's own config search from `cwd` finds a config: upward, ending after a directory that holds a `.git`
 * entry or at the filesystem root. Not cached: a config added or removed outside Write/Edit is seen at once.
 *
 * @param cwd - The session's working directory.
 * @returns True when a config was found.
 */
function hasDprintConfig(cwd: string): boolean {
  let found = false;
  walkToRoot(cwd, (dir) => {
    found = DPRINT_CONFIG_NAMES.some((n) => existsSync(path.join(dir, n)));
    return found || existsSync(path.join(dir, ".git"));
  });
  return found;
}

/**
 * Whether the dprint plugin is enabled: the most specific settings file (local, project, at `cwd` and at its git
 * root, then user) that has a `dprint@<marketplace>` key under `enabledPlugins` decides, and only `true` enables.
 * Unreadable files are skipped; no entry anywhere means not enabled. Read on every call: enabling a plugin never
 * passes through Write/Edit.
 *
 * @param cwd - The session's working directory.
 * @returns True when dprint is enabled.
 */
function isDprintPluginEnabled(cwd: string): boolean {
  const projectDirs = [...new Set([cwd, findGitRoot(cwd, os.homedir()) || cwd])];
  const files = [
    ...projectDirs.flatMap((d) => [path.join(d, ".claude", "settings.local.json"), path.join(d, ".claude", "settings.json")]),
    path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json"),
  ];
  for (const file of files) {
    try {
      const enabled = (JSON.parse(readFileSync(file, "utf8")) as { enabledPlugins?: unknown } | null)?.enabledPlugins;
      if (typeof enabled !== "object" || enabled === null) continue;
      // every marketplace's dprint counts: a disabled copy from one must not hide the enabled one from another
      const entries = Object.entries(enabled).filter(([k]) => k.startsWith("dprint@"));
      if (entries.length > 0) return entries.some(([, v]) => v === true);
    } catch {
      // missing or malformed: next scope
    }
  }
  return false;
}

/**
 * Whether dprint formats this working directory: it has a dprint config and the dprint plugin is enabled. Any error
 * means no (keep formatting). The config walk comes first: the settings are read only in a dprint-configured project.
 *
 * @param cwd - The session's working directory.
 * @returns True when universal-format must format nothing inside `cwd`.
 */
function dprintGoverns(cwd: string): boolean {
  try {
    return hasDprintConfig(cwd) && isDprintPluginEnabled(cwd);
  } catch {
    return false;
  }
}

/**
 * The base directory of a file together with the file's path relative to it (see {@link resolveBase}).
 *
 * @param cwd - The session's working directory, or `""`.
 * @param resolved - The absolute file path.
 * @returns The base and the base-relative path, which never starts with `..`.
 */
function resolveBaseAndRel(cwd: string, resolved: string): { base: string; rel: string } {
  if (cwd) {
    const rel = relativeIfContains(cwd, resolved);
    if (rel !== null) return { base: cwd, rel };
  }
  const fileDir = path.dirname(resolved);
  const base = findGitRoot(fileDir, os.homedir()) || fileDir;
  return { base, rel: path.relative(base, resolved) };
}

/**
 * The directory every project-scoped lookup of a file anchors at (`.prettierignore`, prettier `plugins`, the bound of
 * the config walks, the formatter's cwd): `cwd` when it contains the file, else the file's git root below the home
 * directory, else the file's own directory. Always the file's directory or an ancestor of it.
 *
 * @param cwd - The session's working directory, or `""`.
 * @param resolved - The absolute file path.
 * @returns The base directory.
 */
export function resolveBase(cwd: string, resolved: string): string {
  return resolveBaseAndRel(cwd, resolved).base;
}

/** The write target of a hook call. */
type Target = {
  /** The payload's `cwd`, or `""`. */
  cwd: string;
  /** The base directory (see {@link resolveBase}). */
  base: string;
  /** The absolute file path. */
  resolved: string;
  /** The file path relative to `base`. */
  rel: string;
  /** The `file_path` as the tool gave it. */
  fp: string;
  /** Whether dprint formats this write (a file inside a dprint-governed `cwd`). */
  dprint: boolean;
};

/**
 * Resolves the write target of a hook call.
 *
 * @param args - The hook input.
 * @returns The target, or null when there is no usable path, the path is inside the session scratchpad, or the path is
 * excluded.
 */
function resolveTarget(args: FormatPreInput): Target | null {
  // resolved: a trailing separator would never equal a walked directory, so no bounded walk would end at the base
  const cwd = typeof args.cwd === "string" && args.cwd ? path.resolve(args.cwd) : "";
  const fp = args.tool_input?.file_path;
  if (typeof fp !== "string" || !fp) return null;
  if (!cwd && !path.isAbsolute(fp)) return null; // nothing to resolve a relative path against
  const resolved = path.resolve(cwd, fp);
  // the harness's own scratchpad, decided before the git-root walk
  // shortcut: lexical only (payload paths are physical), a symlinked spelling of the scratchpad is kept, compare real paths if one appears
  const sp = args.scratchpad_dir;
  if (typeof sp === "string" && path.isAbsolute(sp) && relativeIfContains(path.resolve(sp), resolved) !== null) return null;
  const { base, rel } = resolveBaseAndRel(cwd, resolved);
  if (isExcludedPath(rel)) return null;
  // outside the cwd the base can be another agent's worktree root, which hides `.claude/worktrees` from `rel`
  if (base !== cwd && hasClaudeInternal(resolved.split(path.sep))) return null;
  // dprint formats only below its scope root, the cwd: a file elsewhere stays with this plugin
  return { cwd, base, resolved, rel, fp, dprint: base === cwd && dprintGoverns(cwd) };
}

/**
 * Applies an Edit in memory, with the Edit tool's contract.
 *
 * @param current - The file content.
 * @param oldStr - The text to replace; an empty one is rejected (it would match everywhere).
 * @param newStr - Its replacement.
 * @param replaceAll - Replace every occurrence instead of requiring exactly one.
 * @returns The edited content, or null when `oldStr` is empty, absent or (without `replaceAll`) not unique.
 */
export function applyEdit(current: string, oldStr: string, newStr: string, replaceAll: boolean): string | null {
  if (oldStr === "") return null;
  if (replaceAll) return current.includes(oldStr) ? current.split(oldStr).join(newStr) : null;
  const idx = current.indexOf(oldStr);
  if (idx === -1 || current.indexOf(oldStr, idx + oldStr.length) !== -1) return null;
  return current.slice(0, idx) + newStr + current.slice(idx + oldStr.length);
}

/**
 * Start of the line that holds an index.
 *
 * @param s - The text.
 * @param i - An index into it.
 * @returns The index of the line's first character.
 */
const lineStart = (s: string, i: number): number => (i <= 0 ? 0 : s.lastIndexOf("\n", i - 1) + 1);

/**
 * End of the line that holds an index.
 *
 * @param s - The text.
 * @param i - An index into it.
 * @returns The index just past the line's newline, or the text's length for an unterminated last line.
 */
const lineEnd = (s: string, i: number): number => {
  const nl = s.indexOf("\n", i);
  return nl === -1 ? s.length : nl + 1;
};

/** How often {@link shrinkSwap} widens the run before it swaps the whole file; keeps repetitive text from a quadratic scan. */
const MAX_WIDENINGS = 32;

/**
 * Shrinks the swap of a whole file to the smallest run of whole lines that differs. The run is widened line by line,
 * upward first, until {@link applyEdit} reproduces `formatted` from it (an empty or non-unique `old_string` never
 * does); past {@link MAX_WIDENINGS} the whole file is swapped.
 *
 * @param current - The file before the edit.
 * @param formatted - The edited and formatted file.
 * @returns The Edit strings, or null when the two texts are equal.
 */
export function shrinkSwap(current: string, formatted: string): { old_string: string; new_string: string } | null {
  if (current === formatted) return null;
  const max = Math.min(current.length, formatted.length);
  let prefix = 0;
  while (prefix < max && current.charCodeAt(prefix) === formatted.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && current.charCodeAt(current.length - 1 - suffix) === formatted.charCodeAt(formatted.length - 1 - suffix)) suffix++;
  // the changed run of `current` is [prefix, length - suffix); a pure insertion takes the line of the insertion point
  let start = lineStart(current, prefix);
  let end = lineEnd(current, Math.max(prefix, current.length - suffix - 1));
  for (let i = 0; i < MAX_WIDENINGS && (start > 0 || end < current.length); i++) {
    const swap = { old_string: current.slice(start, end), new_string: formatted.slice(start, formatted.length - (current.length - end)) };
    if (applyEdit(current, swap.old_string, swap.new_string, false) === formatted) return swap;
    if (start > 0) start = lineStart(current, start - 1);
    else end = lineEnd(current, end);
  }
  return { old_string: current, new_string: formatted };
}

/** The one ignore file; a landed write re-reads this server's ignore state of its base. */
export const PRETTIER_IGNORE_BASENAMES: Set<string> = new Set([".prettierignore"]);

/** Base names whose write changes what prettier resolves: its config files, the two package manifests, `.editorconfig` and the ignore file. */
export const CACHE_INVALIDATING_BASENAMES: Set<string> = new Set([...PRETTIER_CONFIG_FILENAMES, "package.json", "package.yaml", ".editorconfig", ...PRETTIER_IGNORE_BASENAMES]);

/**
 * The identity of a file's state on disk.
 *
 * @param file - The file path.
 * @returns Inode, size and mtime, or `""` when the file does not exist.
 */
function fileStamp(file: string): string {
  try {
    const s = statSync(file);
    return `${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch {
    return "";
  }
}

/**
 * Config files a Write/Edit is about to land on, by path, with the stamp they had when the hook ran. The hook runs
 * before the write: clearing the caches then would cache the old content again.
 */
const pendingRefreshes = new Map<string, string>();

/**
 * Clears the config caches for every pending config write that has landed (its stamp changed) and re-reads the ignore
 * state of an ignore file's directory (the only base it governs). A write that never lands keeps its entry, at one `stat` per format.
 */
function refreshLandedConfigWrites(): void {
  for (const [file, stamp] of pendingRefreshes) {
    if (fileStamp(file) === stamp) continue;
    pendingRefreshes.delete(file);
    clearPrettierConfigCaches();
    if (PRETTIER_IGNORE_BASENAMES.has(path.basename(file))) primePrettierIgnoreCache(path.dirname(file));
  }
}

/**
 * Runs a CLI formatter on a text through stdin. Never blocks the server (other hook calls are served meanwhile) and
 * never throws.
 *
 * @param tool - The formatter.
 * @param argv - Its complete argv.
 * @param cwd - The working directory of the spawn.
 * @param src - The text to format.
 * @param signal - Aborts the run when the client cancelled the call.
 * @returns The tool's stdout when its exit code is one of `okExit` and stdout is not empty; else null (spawn error, timeout, crash, abort).
 */
function runStdinFormatter(tool: FormatTool, argv: string[], cwd: string, src: string, signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(null);
    let out = "";
    const finish = (value: string | null): void => {
      clearTimeout(timer);
      resolve(value);
    };
    // `signal` kills the child on abort; its `error` event then resolves null
    const child = spawn(tool.name, argv, { cwd, stdio: ["pipe", "pipe", "ignore"], signal, killSignal: "SIGKILL" });
    // resolves at once: `close` waits for the pipes, which a surviving grandchild can hold open
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, SPAWN_TIMEOUT_MS);
    child.on("error", () => finish(null));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    // neither exit code nor output alone is trustworthy: black echoes the unformatted input on a parse error
    // (exit 123), ktlint reports a syntax error with exit 0 and no output
    child.on("close", (code) => finish((tool.okExit ?? [0]).includes(code ?? -1) && out.length > 0 ? out : null));
    child.stdin.on("error", () => {}); // EPIPE: the tool gave up before it read everything
    child.stdin.end(src);
  });
}

/**
 * Formats a text as a file of a language: the bundled prettier in-process, else the language's first CLI formatter on
 * PATH. A prettier error propagates (the handler fails open).
 *
 * @param src - The text.
 * @param resolved - The absolute path of the file it will be written to.
 * @param base - The base directory.
 * @param lang - The language key.
 * @param signal - Aborts a CLI formatter when the client cancelled the call.
 * @returns The formatted text and the formatter's name, or null when no formatter could run.
 */
async function formatContent(src: string, resolved: string, base: string, lang: string, signal?: AbortSignal): Promise<{ formatted: string; tool: string } | null> {
  if (PRETTIER_LANGS.has(lang)) return { formatted: await formatInProcess(src, resolved, base, lang), tool: "prettier" };
  if (!Object.hasOwn(REGISTRY, lang)) return null;
  const selection = selectFormatter(REGISTRY[lang].chain, resolved, base);
  if (!selection) return null;
  // a Write may create the file's directory: spawn in the nearest existing one (a missing cwd fails the spawn)
  let cwd = base;
  walkToRoot(selection.tool.spawnCwd === "fileDir" ? path.dirname(resolved) : base, (dir) => {
    if (!existsSync(dir)) return false;
    cwd = dir;
    return true;
  });
  const formatted = await runStdinFormatter(selection.tool, selection.argv, cwd, src, signal);
  return formatted === null ? null : { formatted, tool: selection.tool.name };
}

/**
 * PreToolUse `Write|Edit`: formats the content before the write and hands it back as `updatedInput`. A Write gets its
 * formatted content. An Edit is applied in memory, the whole file formatted, and the Edit tool gets the changed run of
 * whole lines (a format that only undoes the edit becomes a no-op Edit).
 *
 * @param args - The hook input.
 * @param signal - Aborts when the client cancelled the call.
 * @returns The hook output; `{}` on every guard failure and error.
 */
export async function formatPre(args: FormatPreInput, signal?: AbortSignal): Promise<HookResult> {
  try {
    refreshLandedConfigWrites();
    const target = resolveTarget(args);
    if (!target) return {};
    const { cwd, base, resolved, rel, fp } = target;

    // before the language guard (most of these names have no extension) and before the dprint gate (a config written
    // while dprint formats the project counts once dprint is disabled)
    if (CACHE_INVALIDATING_BASENAMES.has(path.basename(resolved))) pendingRefreshes.set(resolved, fileStamp(resolved));
    if (target.dprint) return {};

    const ext = path.extname(resolved).toLowerCase();
    if (!Object.hasOwn(EXT_MAP, ext)) return {};
    const lang = EXT_MAP[ext];
    // `.prettierignore` opts out of the prettier languages only; for a CLI language the opt-out is not installing the tool
    if (PRETTIER_LANGS.has(lang) && (await isPrettierIgnored(resolved, base))) return {};

    // a file outside the cwd is named absolutely: a relative path is ambiguous across projects
    const display = base === cwd ? rel : resolved;
    const noticeFor = (tool: string): string => `universal-format: ${tool} reformatted ${display}; re-read it before further string-based edits. This reformat is intentional and exempt from "surgical/minimal-diff" change-scope rules — do not revert or redo it by hand to shrink the diff.`;
    const input = args.tool_input ?? {};

    if (args.tool_name === "Write") {
      const content = input.content;
      if (typeof content !== "string") return {};
      const result = await formatContent(content, resolved, base, lang, signal);
      if (result === null || result.formatted === content) return {};
      return { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { file_path: fp, content: result.formatted }, additionalContext: noticeFor(result.tool) } };
    }

    if (args.tool_name === "Edit") {
      if (!existsSync(resolved)) return {};
      // the Edit tool matches `old_string` against LF-normalised content and writes CRLF back itself, so a CRLF file
      // is handled in LF throughout: a `\r\n` in the swap could never match
      const raw = readFileSync(resolved, "utf8");
      const crlf = raw.includes("\r\n");
      const toLf = (s: string): string => (crlf ? s.replaceAll("\r\n", "\n") : s);
      const current = toLf(raw);
      const oldStr = input.old_string;
      const newStr = input.new_string;
      if (typeof oldStr !== "string" || typeof newStr !== "string") return {};
      // both forms: the hooks.json template substitutes text, so the boolean arrives as a string
      const replaceAll = input.replace_all === true || input.replace_all === "true";
      const merged = applyEdit(current, oldStr, newStr, replaceAll);
      if (merged === null) return {}; // absent or not unique: the original Edit proceeds and reports it
      const result = await formatContent(merged, resolved, base, lang, signal);
      if (result === null) return {};
      const formatted = toLf(result.formatted);
      if (formatted === merged) return {};
      const swap = shrinkSwap(current, formatted);
      if (swap === null) {
        // the formatter turns the edit back into the file on disk: a no-op Edit (which the Edit tool refuses) keeps the
        // file formatted, the raw edit would not
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            updatedInput: { file_path: fp, old_string: oldStr, new_string: oldStr, replace_all: replaceAll },
            additionalContext: `universal-format: ${result.tool} formats this edit straight back to the current content of ${display}, so there is nothing to change. The Edit tool will refuse it with "No changes to make: old_string and new_string are exactly the same" - that is expected, not a fault: the file is unchanged and already formatted. Do not retry this edit.`,
          },
        };
      }
      return { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { file_path: fp, ...swap, replace_all: false }, additionalContext: noticeFor(result.tool) } };
    }

    return {};
  } catch {
    return {};
  }
}
