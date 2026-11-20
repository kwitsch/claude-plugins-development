// Shared helpers of the cc-knowledge tests: paths, file reads, frontmatter, throwaway directories, spawning a built
// script. The scripts export nothing, so their tests spawn the built `plugin/`; the hook's unit tests load `src/`.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";

/** The repository root. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The plugin package directory (`cc-knowledge/`). */
export const PKG = join(ROOT, "cc-knowledge");

/** The built plugin directory (`cc-knowledge/plugin/`). */
export const PLUGIN = join(PKG, "plugin");

/** The cc-reference skill directory. */
export const SKILL = join(PLUGIN, "skills", "cc-reference");

/** The bundled reference files directory. */
export const REFS = join(SKILL, "references");

/**
 * Reads a file of the built plugin.
 *
 * @param rel - Path relative to `cc-knowledge/plugin/`.
 * @returns The file text.
 */
export const readPlugin = (rel: string): string => readFileSync(join(PLUGIN, rel), "utf8");

/**
 * Reads a file of the repository.
 *
 * @param rel - Path relative to the repository root.
 * @returns The file text.
 */
export const readRepo = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

/**
 * Parses a JSON file of the built plugin.
 *
 * @param rel - Path relative to `cc-knowledge/plugin/`.
 * @returns The parsed value.
 */
export const readPluginJson = (rel: string): ReturnType<typeof JSON.parse> => JSON.parse(readPlugin(rel));

/**
 * Splits a markdown file into its YAML frontmatter and body. Only top-level `key: value` lines are read (a value
 * that continues on indented lines keeps the first line).
 *
 * @param text - The file text.
 * @returns The top-level frontmatter fields (empty without frontmatter), the raw frontmatter and the body.
 */
export function frontmatter(text: string): { data: Record<string, string>; raw: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, raw: "", body: text };
  const data: Record<string, string> = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) data[kv[1]] = (kv[2] ?? "").trim();
  }
  return { data, raw: m[1] ?? "", body: m[2] ?? "" };
}

/** Throwaway directories created by {@link tmpDir}, removed after each test. */
const made: string[] = [];

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Creates a throwaway directory that is removed after the test.
 *
 * @param prefix - Name prefix.
 * @returns The absolute path (resolved, no symlink).
 */
export function tmpDir(prefix = "cck-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

/**
 * Writes a file, creating its directories.
 *
 * @param path - Absolute path.
 * @param content - File content.
 * @param mode - Optional file mode.
 */
export function put(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
}

/**
 * Drops an executable bash stub into a directory.
 *
 * @param binDir - Directory that goes on the stub PATH.
 * @param name - Command name.
 * @param lines - Script body lines.
 */
export function makeStub(binDir: string, name: string, lines: string[]): void {
  put(join(binDir, name), `#!/usr/bin/env bash\n${lines.join("\n")}\n`, 0o755);
}

/** The result of {@link run}. */
export type Run = { status: number | null; stdout: string; stderr: string };

/**
 * Runs a built script (or any program) and collects its output.
 *
 * @param file - The program; a path ending in `.mjs` runs under the current node.
 * @param args - Arguments.
 * @param opts - `cwd`, `env` (replaces the environment when given; the default keeps the current one) and `input` (stdin).
 * @returns Exit status and output.
 */
export function run(file: string, args: string[] = [], opts: { cwd?: string; env?: Record<string, string>; input?: string } = {}): Run {
  const isNode = file.endsWith(".mjs");
  const r = spawnSync(isNode ? process.execPath : file, isNode ? [file, ...args] : args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    input: opts.input,
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
