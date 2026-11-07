#!/usr/bin/env node
/**
 * universal-lint plugin: lint-only checker for Write/Edit results and files changed outside them.
 *
 * @remarks
 * Command hook, invoked directly per event (no MCP server). stdin = hook JSON (PostToolUseHookInput); `main()`
 * dispatches on `hook_event_name`: SessionStart/CwdChanged print the git watch list as `watchPaths` (stdout JSON,
 * exit 0); FileChanged lints a watched file changed outside Write/Edit (unlink, scope, digest and git gates first);
 * anything else is PostToolUse Write|Edit (digest recorded, then lint). `asyncRewake: true` in hooks.json for
 * PostToolUse and FileChanged: runs in the background (safe because linting never mutates the file); findings go to
 * stderr with exit 2, which wakes Claude with them; no finding = no output, exit 0.
 *
 * lint flow (every failure path returns `{}` silently, fail open): guard `tool_response.success !== false`, then
 * `scopedTarget` (real path strictly inside the real cwd, not excluded: node_modules/vendor/.git, .claude/worktrees,
 * .claude/agent-memory, *.local.*, see `isExcludedPath`; not inside `scratchpad_dir`; no dangling link; lintable
 * extension; file exists). Then up to two INDEPENDENT checks run and their findings combine: (1) the language's chain
 * tool (first on PATH wins; no per-file skip, since no style mapping exists for linters) through spawnSync (cwd =
 * project cwd, 30s timeout, stdout+stderr captured), classified by exit code for most tools (checkstyle by stripped
 * output, since its exit code counts only ERROR-severity violations and the bundled default ruleset runs at
 * `warning`); (2) for .ts/.tsx/.mts/.cts only, a whole-project `tsc --noEmit` via the nearest tsconfig.json (see
 * `runTypeCheck`). Any issues found: truncated, joined text (stderr, exit 2); no finding from either check: nothing
 * printed.
 *
 * @packageDocumentation
 */
import { execFileSync, spawnSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** Inner linter timeout; the hook-level timeout (hooks.json timeout: 90 = the lint budget) is the backstop. */
const SPAWN_TIMEOUT_MS = 30000;

/** Cold npx install can exceed SPAWN_TIMEOUT_MS; stay inside the 90s lint budget (hooks.json timeout 90). */
const NPX_SPAWN_TIMEOUT_MS = 55000;

/** Cap on the additionalContext findings text. */
const MAX_CONTEXT_CHARS = 4000;

/** spawnSync's 1MB default truncates a noisy linter's output as ENOBUFS. */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * Full-project incremental type-check: slower than a single-file/dir tool (SPAWN_TIMEOUT_MS) but not a cold registry
 * install (NPX_SPAWN_TIMEOUT_MS); kept its own, smaller budget so a stale async finding (this hook is async:true)
 * doesn't arrive too late to be useful.
 */
const TSC_SPAWN_TIMEOUT_MS = 45000;

/**
 * cargo check/clippy compile the crate; slower than a single-file/dir tool (SPAWN_TIMEOUT_MS), same budget rationale
 * as TSC_SPAWN_TIMEOUT_MS; stays under the hook-level timeout backstop.
 */
const CARGO_SPAWN_TIMEOUT_MS = 45000;

/** Above this many lintable files the watch list is empty (nothing watched), as dprint's watch-list.mts. */
export const WATCH_LIMIT = 5000;

/** Budget of each git call (ls-files for the watch list, status for the FileChanged gate). */
const GIT_TIMEOUT_MS = 10000;

/** tsc only understands real TypeScript syntax; .js/.jsx/.mjs/.cjs stay chain-linted only (eslint or oxlint, see resolveOxlintConfig). */
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
  /** npm package to run via `npx --yes` when the binary is absent from PATH. */
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
interface Finding {
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
 * Linter registry. chain = first tool on PATH wins. Every entry runs check-only --
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
        args: [],
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

/**
 * PATH probe cache (server-lifetime): tool name -> boolean on PATH.
 */
const probeCache = new Map<string, boolean>();
/**
 * Whether a tool is executable on PATH (cached per tool name).
 *
 * @param tool - Binary name to look for.
 * @returns True when an executable of that name sits in a PATH directory.
 */
function onPath(tool: string): boolean {
  const cached = probeCache.get(tool);
  if (cached !== undefined) return cached;
  let found = false;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      accessSync(path.join(dir, tool), fsConstants.X_OK);
      found = true;
      break;
    } catch {
      /* keep looking */
    }
  }
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
 * @param tool - Chain entry to check.
 * @param toolOnPath - Whether the tool binary is on PATH.
 * @param npxOnPath - Whether npx is on PATH.
 * @returns True when the tool can run directly or via npx.
 */
export function isToolAvailable(tool: LintTool, toolOnPath: boolean, npxOnPath: boolean): boolean {
  return toolOnPath || (!!tool.npmSpec && npxOnPath);
}

/**
 * Run the resolved lint tool: through `npx --yes <npmSpec>` when it is absent
 * from PATH but npm-distributed (its own, longer timeout, since a cold
 * `npx --yes <pkg>` install can exceed the local-binary budget), else spawn it
 * directly (`spawnAs` when set).
 *
 * @param tool - The selected chain entry.
 * @param argv - Full argv from buildArgv.
 * @param spawnOpts - Options for spawnSync.
 * @returns The spawnSync result of whichever route ran.
 */
function runLintTool(tool: LintTool, argv: string[], spawnOpts: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string> {
  if (tool.npmSpec && !onPath(tool.name)) {
    return spawnSync("npx", ["--yes", tool.npmSpec, ...argv], {
      ...spawnOpts,
      timeout: NPX_SPAWN_TIMEOUT_MS,
    });
  }
  // spawnAs decouples "which binary name gates PATH-availability /
  // selectLintTool matching" (tool.name -- probed by onPath/selectLintTool)
  // from "which binary + args are actually spawned". Only the rust chain's
  // clippy entry sets it today: it probes the standalone cargo-clippy driver
  // binary (whose presence signals the clippy rustup component is installed)
  // but must actually run via the `cargo clippy` subcommand, since the bare
  // driver binary rejects buildArgv's --manifest-path.
  const spawnName = tool.spawnAs?.name ?? tool.name;
  const spawnArgv = tool.spawnAs ? [...tool.spawnAs.args, ...argv] : argv;
  return spawnSync(spawnName, spawnArgv, spawnOpts);
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
      const p = path.join(dir, rel);
      if (existsSync(p)) return p;
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
    return existsSync(p) ? p : null;
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
    if (!existsSync(p)) return null;
    let text: string;
    try {
      text = readFileSync(p, "utf8");
    } catch {
      return null; // unreadable -- treat as absent, keep climbing
    }
    return !looksLikeSolutionStyleTsconfig(text) ? p : null;
  });
}

/** Eslint config file names, checked after the oxlint names within one directory. */
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
 * oxlint wins a same-dir tie, and no config at all means eslint.
 *
 * @param fileDir - Directory of the edited file.
 * @param cwd - Project root.
 * @returns Path of the nearest config if it is an oxlint config, else null (eslint).
 */
export function resolveOxlintConfig(fileDir: string, cwd: string): string | null {
  const hit = walkUpToCwd(fileDir, cwd, (dir) => {
    for (const n of [...OXLINT_CONFIG_FILENAMES, ...ESLINT_CONFIG_FILENAMES]) {
      const p = path.join(dir, n);
      if (existsSync(p)) return p;
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
    if (YAMLLINT_CONFIG_FILENAMES.some((name) => existsSync(path.join(dir, name)))) return true;
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
 * root (a workspace/monorepo case).
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
  return walkToRoot(fileDir, (dir) => MARKDOWNLINT_CONFIG_FILENAMES.some((name) => existsSync(path.join(dir, name))));
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
 * Trim, collapse runs of 3+ blank lines to one, and cap at MAX_CONTEXT_CHARS.
 *
 * @param text - Findings text.
 * @returns The text trimmed, collapsed and capped.
 */
export function truncate(text: string): string {
  const collapsed = text.replace(/\n{3,}/g, "\n\n").trim();
  if (collapsed.length <= MAX_CONTEXT_CHARS) return collapsed;
  return collapsed.slice(0, MAX_CONTEXT_CHARS) + "\n… (truncated)";
}

/**
 * Two-pass tool selection, mirroring universal-format's selectFormatter: a chain
 * tool actually on PATH always wins over any other chain tool that's merely
 * npx-reachable, regardless of chain order. Without this, giving npmSpec to more
 * than one chain entry (e.g. markdownlint-cli2 before markdownlint) would let the
 * earlier entry's npx fallback shadow a later entry that's genuinely installed --
 * npx ships with node, so it's essentially always "available."
 *
 * @param chain - A language's tool chain.
 * @returns The tool to run, or null when none is available.
 */
function selectLintTool(chain: LintTool[]): LintTool | null {
  for (const tool of chain) {
    if (onPath(tool.name)) return tool;
  }
  if (!onPath("npx")) return null;
  for (const tool of chain) {
    if (tool.npmSpec) return tool;
  }
  return null;
}

/**
 * Shared spawnSync options builder -- only `timeout` differs between the
 * chain-tool run (SPAWN_TIMEOUT_MS) and the tsc run (TSC_SPAWN_TIMEOUT_MS).
 *
 * @param cwd - Working directory of the child.
 * @param timeout - Timeout in milliseconds.
 * @returns The spawnSync options.
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

/**
 * Run the language's chain-selected tool (existing chain/runLintTool
 * machinery, unchanged behavior) and return its finding, or null on any
 * guard failure / clean / skip verdict. selectLintTool's own null path
 * already covers "nothing on PATH and nothing npx-eligible" -- no separate
 * pre-check needed (an earlier `isToolAvailable`-based short-circuit here was
 * logically redundant with it and has been removed).
 *
 * @param lang - Registry entry of the file's language.
 * @param resolved - Absolute path of the edited file.
 * @param cwd - Project root.
 * @param rel - Path of the file relative to cwd.
 * @returns `ran`: a tool ran to a clean or issues verdict (false on no tool, guard
 *   failure, spawn error/signal or skip verdict); `finding`: the issues, else null.
 */
function runChainLint(lang: LangEntry, resolved: string, cwd: string, rel: string): { ran: boolean; finding: Finding | null } {
  const none = { ran: false, finding: null };
  const tool = selectLintTool(lang.chain);
  if (!tool) return none;
  // Gate cargo runs on a resolvable manifest: a stray .rs outside any Cargo
  // project is a silent no-op, not a spurious "could not find Cargo.toml"
  // exit-101 finding. Resolved once here and threaded through buildArgv and
  // the target computation below -- resolveCargoManifest is a directory walk
  // doing an existsSync per level, so re-resolving it for the same
  // file/cwd pair would repeat that walk for no new answer.
  let manifest: string | null = null;
  if (tool.manifestPath) {
    manifest = resolveCargoManifest(path.dirname(resolved), cwd);
    if (!manifest) return none;
  }

  const argv = buildArgv(tool, resolved, cwd, manifest);
  // Compile-heavy cargo tools get their own budget (mirrors TSC_SPAWN_TIMEOUT_MS).
  const timeout = tool.manifestPath ? CARGO_SPAWN_TIMEOUT_MS : SPAWN_TIMEOUT_MS;
  const spawnOpts = buildSpawnOpts(cwd, timeout);
  const result = runLintTool(tool, argv, spawnOpts);
  if (result.error || result.signal) return none;

  // Cargo entries are neither file-scoped nor targetsDir: the natural target
  // is the crate directory (the dir containing the resolved Cargo.toml). The
  // gate above guarantees `manifest` is non-null here.
  const target = tool.targetsDir ? path.relative(cwd, path.dirname(resolved)) || "." : manifest ? path.relative(cwd, path.dirname(manifest)) || "." : rel;
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
  if (verdict === "skip") return none;
  // cargo prints paths relative to the crate (or workspace) root, go tools get the package dir, the rest run in cwd.
  const base = manifest ? path.dirname(manifest) : tool.targetsDir ? path.dirname(resolved) : cwd;
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
 *
 * @param resolved - Absolute path of the edited file.
 * @param cwd - Project root.
 * @returns The finding, or null.
 */
function runTypeCheck(resolved: string, cwd: string): Finding | null {
  const tsconfigPath = resolveTsconfig(path.dirname(resolved), cwd);
  if (!tsconfigPath) return null;

  const cachePath = tsBuildInfoPathFor(tsconfigPath);
  try {
    mkdirSync(path.dirname(cachePath), { recursive: true });
  } catch {
    return null; // can't create the cache dir -- fail open, no cache-less fallback
  }

  const staticArgs = ["--noEmit", "--incremental"];
  const dynamicTail = ["--tsBuildInfoFile", cachePath, "-p", tsconfigPath];
  const spawnOpts = buildSpawnOpts(cwd, TSC_SPAWN_TIMEOUT_MS);

  let result: SpawnSyncReturns<string>;
  if (onPath("tsc")) {
    result = spawnSync("tsc", [...staticArgs, ...dynamicTail], spawnOpts);
  } else {
    // Most real TS projects only have `typescript` as a local devDependency
    // (node_modules/.bin usually isn't on a hook's PATH) -- no npx fallback
    // here (see `.claude/rules/typescript-check.md`: the two-bin `typescript` package makes the
    // existing npx idiom's correctness unverified for this specific tool).
    const localTsc = path.join(cwd, "node_modules", ".bin", "tsc");
    if (!existsSync(localTsc)) return null;
    result = spawnSync(localTsc, [...staticArgs, ...dynamicTail], spawnOpts);
  }
  if (result.error || result.signal) return null;
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
 * The real-path scope rule shared by every event (dprint's `inScope`): `file` resolved against `cwd` must exist, have a
 * lintable extension, its real path must lie strictly inside realpath(cwd), not be excluded (`isExcludedPath` on the
 * path relative to the real cwd), not lie inside realpath(scratchpad) when given, and not be a dangling link.
 *
 * @param cwd - Payload cwd (the scope root; never `process.cwd()`).
 * @param file - Absolute or cwd-relative path.
 * @param scratchpad - The session's `scratchpad_dir`, when the payload has one.
 * @param roots - Pre-resolved `realish(cwd)` / `realish(scratchpad)`, so a caller scoping many files resolves them once.
 * @returns `{ fp, real }` (lexical absolute path, real path) or null when out of scope.
 */
export function scopedTarget(cwd: string, file: string, scratchpad?: string, roots?: { cwd: string; scratchpad?: string }): { fp: string; real: string } | null {
  try {
    const fp = path.resolve(cwd, file);
    const real = realish(fp);
    const outside = (rel: string): boolean => rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
    const rel = path.relative(roots?.cwd ?? realish(cwd), real);
    if (rel === "" || outside(rel) || isExcludedPath(rel)) return null;
    if (scratchpad) {
      const rs = roots ? roots.scratchpad ?? realish(scratchpad) : realish(scratchpad);
      if (real === rs || real.startsWith(rs + path.sep)) return null;
    }
    const ext = path.extname(fp).toLowerCase();
    if (!EXT_MAP[ext] && !TYPE_CHECK_EXTS.has(ext)) return null;
    if (!existsSync(fp)) return null;
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
 * `scratchpad_dir`, dangling link, unsupported extension, file absent). Used by lintFileHandler (and through it by the
 * skill driver). Fails closed to null on any unexpected error, matching lintFileHandler's fail-open-to-{} philosophy.
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

/**
 * Location regex A: `<path>.<ext>:<line>` or `<path>.<ext>(<line>` (ruff, ktlint, golangci-lint, go vet, checkstyle,
 * markdownlint, psalm, oxlint `,-[src/a.ts:3:7]`, cargo `--> src/a.rs:12:5`, tsc `a.ts(12,5)` / `a.ts:12:5`).
 */
const LOC_PATH_RE = /(?<path>[^\s:()[\]'"]+\.[A-Za-z0-9]+)[:(](?<line>\d+)(?:[:,]\d+)?/;
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
 * not reportable.
 *
 * @param finding - One tool's finding.
 * @param ranges - Inclusive 0-based edited line ranges, or null when every line counts as edited.
 * @param resolved - Absolute path of the edited file.
 * @returns The finding with only the kept text, `finding` itself when no line is located (unknown format, fail open),
 *   or null when nothing reportable remains.
 */
export function gateFinding(finding: Finding, ranges: Array<[number, number]> | null, resolved: string): Finding | null {
  const hit = (line: number): "hit" | "miss" => (ranges === null || ranges.some(([s, e]) => s <= line - 1 && line - 1 <= e) ? "hit" : "miss");
  const classify = (raw: string): "hit" | "miss" | "foreign" | null => {
    const plain = raw.replace(ANSI_SGR_RE, "");
    const row = LOC_ROW_RE.exec(plain); // a stylish row first: its message text can look like `foo.bar(3)`
    if (row?.groups) return hit(Number(row.groups.line));
    const a = LOC_PATH_RE.exec(plain);
    if (a?.groups) {
      const p = path.normalize(a.groups.path);
      const abs = path.resolve(finding.base, p);
      // Suffix fallback only when the base-resolved path is not a real file, so a same-named other file stays foreign.
      const own = abs === resolved || (!path.isAbsolute(p) && !existsSync(abs) && resolved.endsWith(path.sep + p));
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
      if (kinds[start] === "miss" && !preambleParse && !PARSE_ERROR_RE.test(seg.join("\n"))) return;
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
 * Lint `resolved` (chain tool + tsc), gate the findings against `ranges` (null = whole file), and build the hook result.
 *
 * @param resolved - Lexical absolute path of the in-scope file.
 * @param cwd - Payload cwd (spawn cwd and config search root).
 * @param ranges - Edited line ranges, or null when the whole file counts.
 * @param hookEventName - `hookSpecificOutput.hookEventName` of the result.
 * @param label - Prefix of the findings text (`<label>: <findings>`).
 * @returns The hook result: findings as additionalContext, or an empty object.
 */
function lintResolved(resolved: string, cwd: string, ranges: Array<[number, number]> | null, hookEventName: string, label: string): HookResult {
  const rel = path.relative(cwd, resolved);
  const ext = path.extname(resolved).toLowerCase();
  const lang = EXT_MAP[ext];
  const typeCheckEligible = TYPE_CHECK_EXTS.has(ext);
  const oxlintConfig = lang === "jsts" ? resolveOxlintConfig(path.dirname(resolved), cwd) : null;

  const findings: Finding[] = [];
  let oxlintRan = false;
  if (lang) {
    // -c makes the detected config oxlint's root: oxlint ignores a nested
    // oxlint.config.ts and rejects options.typeAware in a nested config otherwise.
    const entry = oxlintConfig ? { chain: REGISTRY.oxlint.chain.map((t) => ({ ...t, args: [...t.args, "-c", oxlintConfig] })) } : REGISTRY[lang];
    const chain = runChainLint(entry, resolved, cwd, rel);
    if (chain.finding) findings.push(chain.finding);
    oxlintRan = oxlintConfig !== null && chain.ran;
  }
  // Skip tsc only when oxlint actually ran with a typeCheck config; otherwise tsc is the only type check.
  if (typeCheckEligible && !(oxlintRan && oxlintConfig && oxlintConfigTypeChecks(oxlintConfig))) {
    const tsResult = runTypeCheck(resolved, cwd);
    if (tsResult) findings.push(tsResult);
  }
  // Gate before truncate() so the context budget is spent on in-range text.
  const kept = findings.flatMap((f) => {
    const g = gateFinding(f, ranges, resolved);
    return g ? [g] : [];
  });
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
 * The lint_file tool handler (PostToolUse Write|Edit). Returns {} on every guard failure / clean / skip (fail open).
 *
 * @param args - The PostToolUse hook payload.
 * @returns The hook result: findings as additionalContext, or an empty object.
 */
export function lintFileHandler(args: PostToolUseHookInput, scoped: { fp: string; real: string } | null = postToolScope(args)): HookResult {
  try {
    const resolved = scoped?.fp;
    if (!resolved) return {};
    const ranges = editRanges(args);
    if (ranges?.length === 0) return {}; // the Edit changed nothing
    return lintResolved(resolved, args.cwd, ranges, "PostToolUse", "universal-lint");
  } catch {
    return {};
  }
}

/**
 * FileChanged: lint a watched file changed outside Write/Edit, whole file (no edit-range gate). Skips, first match
 * wins: `unlink` event; out of scope (`scopedTarget`); content still equal to the digest Write/Edit recorded; git says
 * ignored (`!!`) or unchanged (empty status). A git failure (no git, not a repo, timeout) lints. Returns {} for every
 * skip and on any error (fail open).
 *
 * @param args - The FileChanged hook payload.
 * @returns The hook result: findings as additionalContext, or an empty object.
 */
export function fileChangedHandler(args: PostToolUseHookInput): HookResult {
  // shortcut: one process per FileChanged, no cross-process cap; add slot files under CLAUDE_PLUGIN_DATA if bulk changes overload the machine
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
    return lintResolved(s.fp, cwd, null, "FileChanged", "universal-lint (changed outside Write/Edit)");
  } catch {
    return {};
  }
}

/**
 * Lintable, in-scope files of `cwd` per `git ls-files -co --exclude-standard` (tracked + untracked-not-ignored; in a
 * subdirectory git lists only paths below it, relative to it), each filtered through `scopedTarget` (drops excluded
 * paths, scratchpad files, dangling links and index entries deleted from disk).
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
  let roots: { cwd: string; scratchpad?: string };
  try {
    roots = { cwd: realish(cwd), scratchpad: scratchpad ? realish(scratchpad) : undefined };
  } catch {
    return [];
  }
  // Set: unmerged index entries are listed once per stage
  const list = [
    ...new Set(
      out.split("\0").filter(Boolean).flatMap((rel) => {
        const fp = scopedTarget(cwd, rel, scratchpad, roots)?.fp;
        return fp ? [fp] : [];
      }),
    ),
  ];
  if (list.length > WATCH_LIMIT) {
    process.stderr.write(`universal-lint: watch list: ${list.length} files above ${WATCH_LIMIT}, FileChanged linting off for this cwd\n`);
    return [];
  }
  return list;
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
 */
function main(): void {
  try {
    const input = JSON.parse(readFileSync(0, "utf8")) as PostToolUseHookInput;
    const ev = input?.hook_event_name;
    if (ev === "SessionStart" || ev === "CwdChanged") {
      const r = watchPathsHandler(input);
      if (r.hookSpecificOutput) process.stdout.write(JSON.stringify(r));
      return;
    }
    let ctx: string | undefined;
    if (ev === "FileChanged") ctx = fileChangedHandler(input).hookSpecificOutput?.additionalContext;
    else {
      const scoped = postToolScope(input);
      recordWrittenFor(scoped);
      ctx = lintFileHandler(input, scoped).hookSpecificOutput?.additionalContext;
    }
    if (ctx) {
      process.stderr.write(ctx + "\n");
      process.exitCode = 2;
    }
  } catch {
    // fail open — no output, exit 0
  }
}

if (isMainModule()) main();
