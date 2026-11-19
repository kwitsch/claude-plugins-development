/**
 * The one prettier of this process (the vendored bundle `./vendor/index.mjs`) with its java, php and shell plugins,
 * the printWidth guard for JSON/YAML, and the caches of project config and `.prettierignore` state. There is no
 * resolver: a project's own prettier is never looked up, its prettier config is honored in full.
 *
 * @packageDocumentation
 */
import { walkToRoot } from "@shared/scope.js";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { resolveEditorconfig } from "./editorconfig.js";
import { loadJava, loadPhp, loadShell, prettier } from "./vendor/index.js";

/** Version of the bundled prettier. */
export const BUNDLED_PRETTIER_VERSION: string = String(prettier.version);

/**
 * A plugin's module namespace as the plugin object prettier expects: java and shell expose it as `default`, the php
 * namespace is the plugin itself.
 *
 * @param ns - The module namespace.
 * @returns The plugin object.
 */
function asPlugin(ns: unknown): prettier.Plugin {
  return ((ns as { default?: unknown }).default ?? ns) as prettier.Plugin;
}

/**
 * The bundled plugins, each loaded on first use: a server start evaluates none of them. No plugin option is ever set
 * from this code; the project's prettier config is the only knob.
 */
const BUNDLED_PLUGIN_LOADERS = {
  java: () => loadJava().then(asPlugin),
  php: () => loadPhp().then(asPlugin),
  shell: () => loadShell().then(asPlugin),
};
/** Name of a bundled plugin. */
type BundledPluginName = keyof typeof BUNDLED_PLUGIN_LOADERS;

/** The languages prettier formats Markdown inside (tagged templates, script and custom blocks). */
const MARKDOWN_HOSTS: ReadonlySet<string> = new Set(["jsts", "html", "vue"]);
/** A source can embed Markdown only through a construct that names it. */
const MARKDOWN_TOKEN = /\b(?:md|markdown)\b/i;

/**
 * The bundled plugins a format needs: its own for java, php and shell; all three for Markdown (fenced blocks are
 * formatted through them) and for a Markdown host whose source names `md` or `markdown`; none otherwise.
 *
 * @param lang - The language key.
 * @param src - The source text; only read for a Markdown host.
 * @returns The plugin names.
 */
export function bundledPluginsFor(lang: string, src = ""): BundledPluginName[] {
  const all = Object.keys(BUNDLED_PLUGIN_LOADERS) as BundledPluginName[];
  if (lang === "markdown" || (MARKDOWN_HOSTS.has(lang) && MARKDOWN_TOKEN.test(src))) return all;
  return all.filter((name) => name === lang);
}

// prettier-plugin-java starts `Parser.init()` at module scope: with a missing or corrupt wasm file that promise rejects
// with nothing attached, which ends a node process and with it every other language. Report it on stderr instead
// (stdout is the JSON-RPC channel); only the affected language then fails open.
process.on("unhandledRejection", (reason: unknown) => {
  const msg = (reason instanceof Error ? reason.message : String(reason)).split("\n")[0];
  process.stderr.write(`[universal-format] background plugin init failed; that language will fail open: ${msg}\n`);
});

/** The config file names prettier searches for, from a file's directory up to the filesystem root. */
export const PRETTIER_CONFIG_FILENAMES = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yml",
  ".prettierrc.yaml",
  ".prettierrc.json5",
  ".prettierrc.js",
  "prettier.config.js",
  ".prettierrc.ts",
  "prettier.config.ts",
  ".prettierrc.mjs",
  "prettier.config.mjs",
  ".prettierrc.mts",
  "prettier.config.mts",
  ".prettierrc.cjs",
  "prettier.config.cjs",
  ".prettierrc.cts",
  "prettier.config.cts",
  ".prettierrc.toml",
];

/** {@link hasPrettierProjectConfig} by directory; cleared by {@link clearPrettierConfigCaches}. */
const projectConfigCache = new Map<string, boolean>();

/**
 * Whether a prettier project config governs a directory: one of prettier's config files, or a top-level `prettier`
 * key in `package.json` or `package.yaml` (the latter by a line-anchored regex: no YAML parser is bundled here).
 * Walks to the filesystem root, as prettier's own search does. Existence only, cached per directory.
 *
 * @param fileDir - The directory of the file being formatted.
 * @returns True when a config was found.
 */
export function hasPrettierProjectConfig(fileDir: string): boolean {
  const cached = projectConfigCache.get(fileDir);
  if (cached !== undefined) return cached;
  const result = walkToRoot(fileDir, (dir) => {
    if (PRETTIER_CONFIG_FILENAMES.some((name) => existsSync(path.join(dir, name)))) return true;
    try {
      const pkg: unknown = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      if (typeof pkg === "object" && pkg !== null && Object.hasOwn(pkg, "prettier")) return true;
    } catch {
      // missing, unreadable or invalid: treated as absent
    }
    try {
      if (/^prettier\s*:/m.test(readFileSync(path.join(dir, "package.yaml"), "utf8"))) return true;
    } catch {
      // missing or unreadable: treated as absent
    }
    return false;
  });
  projectConfigCache.set(fileDir, result);
  return result;
}

/**
 * JSON and YAML only: whether prettier's default 80 columns would apply to a project that never asked for a line
 * length, that is, no prettier project config and no `.editorconfig` `max_line_length` governs the file. Both walks
 * are unbounded, like prettier's own.
 *
 * @param file - The file being formatted.
 * @param cwd - The project base.
 * @returns True when `printWidth` should be lifted.
 */
export function shouldOverridePrintWidth(file: string, cwd: string): boolean {
  if (hasPrettierProjectConfig(path.dirname(file))) return false;
  const ec = resolveEditorconfig(file, cwd, { unbounded: true });
  return !(ec.found && typeof ec.props.max_line_length === "number");
}

/**
 * Rewrites the `plugins` entries of a project config to absolute paths resolved against the project: the bundled
 * prettier would resolve a bare specifier against the server process's cwd. Non-strings and absolute paths pass.
 *
 * @param plugins - The config's `plugins` value.
 * @param cwd - The project base.
 * @returns The rewritten entries, or null when the value is no array or an entry cannot be resolved (the caller then leaves the file alone).
 */
export function resolveConfigPlugins(plugins: unknown, cwd: string): unknown[] | null {
  if (!Array.isArray(plugins)) return null;
  const req = createRequire(path.join(cwd, "package.json"));
  const out: unknown[] = [];
  for (const entry of plugins as unknown[]) {
    if (typeof entry !== "string" || path.isAbsolute(entry)) {
      out.push(entry);
      continue;
    }
    try {
      out.push(req.resolve(entry));
    } catch {
      return null;
    }
  }
  return out;
}

/**
 * Formats a whole source text with the bundled prettier and the project's config. Never clears prettier's config
 * cache (see {@link clearPrettierConfigCaches}).
 *
 * @param src - The source text.
 * @param filePath - The absolute path of the file it will be written to.
 * @param cwd - The project base.
 * @param lang - The language key.
 * @returns The formatted text; `src` unchanged when a plugin the project's config names cannot be resolved.
 */
export async function formatInProcess(src: string, filePath: string, cwd: string, lang: string): Promise<string> {
  // a copy: prettier caches the resolved config, a mutation would leak into every later file with the same config
  const config: prettier.Options = { ...(await prettier.resolveConfig(filePath, { editorconfig: true })) };
  let projectPlugins: NonNullable<prettier.Options["plugins"]> = [];
  if (Array.isArray(config.plugins)) {
    const resolved = resolveConfigPlugins(config.plugins, cwd);
    if (resolved === null) return src;
    projectPlugins = resolved as NonNullable<prettier.Options["plugins"]>;
  }
  // a finite width prettier resolved itself is the project's (an `.editorconfig` section glob the own resolver cannot match)
  if ((lang === "json" || lang === "yaml") && !Number.isFinite(config.printWidth ?? NaN) && shouldOverridePrintWidth(filePath, cwd)) config.printWidth = 99999; // prettier rejects Infinity
  // bundled plugins last: a project config naming the same plugin cannot leave prettier without a parser
  const bundled = await Promise.all(bundledPluginsFor(lang, src).map((name) => BUNDLED_PLUGIN_LOADERS[name]()));
  return await prettier.format(src, { ...config, plugins: [...projectPlugins, ...bundled], filepath: filePath });
}

/**
 * Drops prettier's cached config and this module's project-config answers. Called once a config file written through
 * Write/Edit has landed on disk, never per format. Leaves the ignore cache alone: a config write cannot change what
 * is ignored.
 */
export function clearPrettierConfigCaches(): void {
  projectConfigCache.clear();
  try {
    void prettier.clearConfigCache();
  } catch {
    // a broken clear must never break the hook
  }
}

/** The ignore state of one base directory. */
type IgnoreState = {
  /** False only when the base's `.prettierignore` is absent or holds blank and `#` lines only: nothing can be ignored. */
  hasRules: boolean;
  /** prettier's answers by file path; matching is path-based, so an answer holds while the ignore file is unchanged. */
  verdicts: Map<string, boolean>;
};

/** Ignore state by base directory; filled on first use, refreshed only when a `.prettierignore` write landed. */
const ignoreCache = new Map<string, IgnoreState>();

/** The one ignore file, at the base directory. `.gitignore` is deliberately no ignore source. */
const PRETTIER_IGNORE_FILENAME = ".prettierignore";

/**
 * Reads the base's `.prettierignore` and derives `hasRules` from its content. Any doubt (an unreadable file) counts
 * as having rules, so prettier decides.
 *
 * @param cwd - The base directory.
 * @returns A fresh state without verdicts.
 */
function readIgnoreState(cwd: string): IgnoreState {
  const verdicts = new Map<string, boolean>();
  const file = path.join(cwd, PRETTIER_IGNORE_FILENAME);
  if (!existsSync(file)) return { hasRules: false, verdicts };
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { hasRules: true, verdicts };
  }
  return { hasRules: text.split(/\r?\n/).some((line) => line !== "" && !line.startsWith("#")), verdicts };
}

/**
 * Whether the base's `.prettierignore` excludes a path. prettier alone decides what matches; a base without rules and
 * an already decided path are answered from the cache. Any error means not ignored.
 *
 * @param filePath - The absolute file path.
 * @param cwd - The base directory.
 * @returns True when the path is ignored.
 */
export async function isPrettierIgnored(filePath: string, cwd: string): Promise<boolean> {
  try {
    let state = ignoreCache.get(cwd);
    if (state === undefined) {
      state = readIgnoreState(cwd);
      ignoreCache.set(cwd, state);
    }
    if (!state.hasRules) return false;
    const memo = state.verdicts.get(filePath);
    if (memo !== undefined) return memo;
    // getFileInfo discovers no ignore file by itself; a missing one is tolerated
    const info = await prettier.getFileInfo(filePath, { ignorePath: [path.join(cwd, PRETTIER_IGNORE_FILENAME)] });
    state.verdicts.set(filePath, info.ignored);
    return info.ignored;
  } catch {
    return false;
  }
}

/**
 * Re-reads a base's `.prettierignore` and drops its verdicts. Called once a `.prettierignore` write has landed.
 *
 * @param cwd - The base directory.
 */
export function primePrettierIgnoreCache(cwd: string): void {
  try {
    ignoreCache.set(cwd, readIgnoreState(cwd));
  } catch {
    ignoreCache.delete(cwd);
  }
}
