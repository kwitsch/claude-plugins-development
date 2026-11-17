/**
 * The extension to language map and the CLI formatter chains. The prettier languages have no chain: prettier is never
 * spawned.
 *
 * @packageDocumentation
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { buildInvocation, type EditorConfigProps, findNativeConfig, type Invocation, resolveEditorconfig } from "./editorconfig.js";
import { onPath } from "./util.js";

/** One formatter of a language's chain: it gets the would-be file content on stdin, its stdout is what gets written. */
export type FormatTool = {
  /** The executable's name. */
  name: string;
  /** `mapped`: `.editorconfig` becomes flags unless a tool-native config governs; `native`/`fixed`: always run with `base`. */
  strategy: "native" | "fixed" | "mapped";
  /** The argv before the mapped `.editorconfig` flags (never the target file). */
  base: string[];
  /** The tool's own config files: a name, or a file plus the TOML section it must hold. */
  nativeConfig?: (string | { file: string; section: string })[];
  /** The argv tail that makes the tool read stdin, print to stdout and resolve its project config as if the input lay at `file`. */
  stdinArgs: (file: string) => string[];
  /** Flags derived from the project, put between the mapped flags and the stdin tail; `base` bounds the upward search. */
  extraArgs?: (file: string, base: string) => string[];
  /** Exit codes whose stdout is the fully formatted content; `[0]` when omitted. */
  okExit?: number[];
  /** Working directory of the spawn: the project base (default), or the file's directory for a tool that finds its config from the cwd. */
  spawnCwd?: "base" | "fileDir";
};

/** A language's formatter chain: the first tool on PATH wins. */
export type LangEntry = {
  /** The tools in order of preference. */
  chain: FormatTool[];
};

/** Lower-case file extension (with the dot) to language key. */
export const EXT_MAP: Record<string, string> = {
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
  ".json": "json",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".md": "markdown",
  ".html": "html",
  ".htm": "html",
  ".vue": "vue",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".php": "php",
  ".rs": "rust",
};

/** The languages the bundled prettier formats in-process. */
export const PRETTIER_LANGS: Set<string> = new Set(["jsts", "json", "yaml", "markdown", "css", "scss", "less", "html", "vue", "graphql", "shell", "java", "php"]);

/** The CLI formatter chains of the languages prettier does not cover. Each tool's stdin mode was run against the real tool. */
export const REGISTRY: Record<string, LangEntry> = {
  kotlin: {
    chain: [
      {
        name: "ktlint",
        strategy: "native",
        base: ["--format", "--log-level=none"],
        stdinArgs: (file) => ["--stdin", "--stdin-path", file],
        // 1: reformatted, violations it cannot fix remain; stdout is still the whole formatted file
        okExit: [0, 1],
      },
      {
        name: "ktfmt",
        strategy: "native",
        base: ["--enable-editorconfig", "--quiet"],
        stdinArgs: (file) => [`--stdin-name=${file}`, "-"],
      },
    ],
  },
  python: {
    chain: [
      {
        name: "ruff",
        strategy: "mapped",
        nativeConfig: [".ruff.toml", "ruff.toml", { file: "pyproject.toml", section: "tool.ruff" }],
        base: ["format", "--quiet"],
        stdinArgs: (file) => ["--stdin-filename", file, "-"],
      },
      {
        name: "black",
        strategy: "mapped",
        nativeConfig: [{ file: "pyproject.toml", section: "tool.black" }],
        base: ["--quiet"],
        stdinArgs: (file) => ["--stdin-filename", file, "-"],
      },
    ],
  },
  go: {
    chain: [
      // -srcdir may be the complete file name: import grouping then sees the file's own module
      { name: "goimports", strategy: "fixed", base: [], stdinArgs: (file) => ["-srcdir", file] },
      { name: "gofmt", strategy: "fixed", base: [], stdinArgs: () => [] },
    ],
  },
  rust: {
    chain: [
      {
        name: "rustfmt",
        strategy: "mapped",
        nativeConfig: ["rustfmt.toml", ".rustfmt.toml"],
        base: [],
        // without --edition rustfmt parses stdin as Rust 2015
        extraArgs: (file, base) => {
          const edition = cargoEdition(path.dirname(file), base);
          return edition ? ["--edition", edition] : [];
        },
        stdinArgs: () => [],
        // no path flag for stdin: rustfmt finds rustfmt.toml by walking up from the cwd
        spawnCwd: "fileDir",
      },
    ],
  },
};

/**
 * The `edition = "YYYY"` of the nearest `Cargo.toml` that states one, from a directory up to `base` (inclusive). A
 * crate with `edition.workspace = true` has no literal, so the walk goes on to the workspace root.
 *
 * @param fileDir - The directory to start at.
 * @param base - Where the walk ends.
 * @returns The four-digit edition, or `""` when no manifest states one.
 */
export function cargoEdition(fileDir: string, base: string): string {
  let dir = fileDir;
  for (;;) {
    const manifest = path.join(dir, "Cargo.toml");
    if (existsSync(manifest)) {
      let text = "";
      try {
        text = readFileSync(manifest, "utf8");
      } catch {
        // unreadable manifest: keep walking
      }
      const m = /^\s*edition\s*=\s*"(\d{4})"/m.exec(text);
      if (m) return m[1];
    }
    if (dir === base) return "";
    const parent = path.dirname(dir);
    if (parent === dir) return "";
    dir = parent;
  }
}

/**
 * The invocation of a tool for a file: `base` for a native or fixed tool, or for a mapped one that a tool-native
 * config governs; else the `.editorconfig` of the file mapped to flags.
 *
 * @param tool - The formatter.
 * @param file - The file being written.
 * @param cwd - The project base that bounds the config walks.
 * @returns The argv, or `skip` for a style the tool cannot honor.
 */
export function resolveInvocation(tool: FormatTool, file: string, cwd: string): Invocation {
  if (tool.strategy !== "mapped") return buildInvocation(tool);
  const hasNativeConfig = findNativeConfig(path.dirname(file), cwd, tool.nativeConfig ?? []);
  let editorconfig: EditorConfigProps | null = null;
  if (!hasNativeConfig) {
    const ec = resolveEditorconfig(file, cwd);
    if (ec.found) editorconfig = ec.props;
  }
  return buildInvocation(tool, { hasNativeConfig, editorconfig });
}

/**
 * The first tool of a chain that can run: on PATH and without a hard style conflict. One pass, no package runner.
 *
 * @param chain - The language's tools in order.
 * @param file - The file being written.
 * @param cwd - The project base.
 * @returns The tool and its complete argv (project flags and stdin tail included), or null.
 */
export function selectFormatter(chain: FormatTool[], file: string, cwd: string): { tool: FormatTool; argv: string[] } | null {
  for (const tool of chain) {
    if (!onPath(tool.name)) continue;
    const inv = resolveInvocation(tool, file, cwd);
    if ("skip" in inv) continue;
    return { tool, argv: [...inv.argv, ...(tool.extraArgs?.(file, cwd) ?? []), ...tool.stdinArgs(file)] };
  }
  return null;
}
