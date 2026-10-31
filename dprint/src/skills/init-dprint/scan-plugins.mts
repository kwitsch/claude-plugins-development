#!/usr/bin/env node
/**
 * init-dprint skill helper: list the project's file types and report every type that a plugin in
 * `dprint-plugins.json` can format but no plugin in the project's dprint config covers.
 *
 * @remarks
 * File types come from `git ls-files` in the working directory; the config is looked up in the working
 * directory only. Output and exit codes are documented in `scan-plugins.reference.md`. Read-only.
 *
 * @packageDocumentation
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { CONFIG_NAMES } from "./config-names.mjs";

/** One plugin entry of `dprint-plugins.json`. */
interface RefPlugin {
  /** Registry name, as accepted by `dprint config add`. */
  id: string;
  /** npm package name, when the plugin is published there. */
  npm?: string;
  /** Lower-cased file extensions without the leading dot. */
  extensions: string[];
  /** Exact file names the plugin formats (for example `Dockerfile`). */
  fileNames?: string[];
}

/** Outcome of {@link scan}: the exit code plus the header fields and one line per uncovered file type. */
interface ScanResult {
  /** Process exit code (0 ok, 2 error, 10 missing, 11 noconfig). */
  code: number;
  /** `ok`, `missing`, `noconfig` or `error`. */
  status: string;
  /** Config file name that was read, or `-`. */
  config: string;
  /** `type=… files=… candidates=…` lines, most frequent type first. */
  lines: string[];
}

/**
 * Convert JSONC to JSON by dropping comments and trailing commas outside string literals.
 *
 * @param text - JSONC source.
 * @returns Text that `JSON.parse` accepts when the input was valid JSONC.
 */
function stripJsonc(text: string): string {
  const keep = (m: string) => (m[0] === "\"" ? m : "");
  return text
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, keep)
    .replace(/"(?:\\.|[^"\\])*"|,(?=\s*[\]}])/g, keep);
}

/**
 * Check whether a config `plugins` entry references a reference plugin.
 *
 * @param p - Reference plugin.
 * @param entries - String entries of the config's `plugins` array.
 * @returns `true` when an entry is p's registry URL, npm specifier or `node_modules` path.
 */
function inConfig(p: RefPlugin, entries: string[]): boolean {
  const prefix = `https://plugins.dprint.dev/${p.id}-`;
  const npm = p.npm;
  return entries.some(
    (e) =>
      (e.startsWith(prefix) && /^v?\d/.test(e.slice(prefix.length)))
      || (npm !== undefined
        && (e === `npm:${npm}`
          || e.startsWith(`npm:${npm}@`)
          || e.startsWith(`npm:${npm}/`)
          || e.includes(`node_modules/${npm}/`))),
  );
}

/**
 * Map a git path to its file-type key.
 *
 * @param path - Repository-relative path as printed by `git ls-files`.
 * @param names - Exact file names known from the reference data.
 * @returns The base name when it is a known file name, else `.` plus the lower-cased extension, else `null`.
 */
function fileType(path: string, names: Set<string>): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (names.has(base)) return base;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? "." + base.slice(dot + 1).toLowerCase() : null;
}

/**
 * Run the scan in the current working directory.
 *
 * @param args - Command-line arguments after the script path; any argument is a usage error.
 * @returns The exit code, header fields and per-type lines to print.
 */
function scan(args: string[]): ScanResult {
  if (args.length > 0) {
    process.stderr.write("usage: node scan-plugins.mjs (takes no arguments)\n");
    return { code: 2, status: "error", config: "-", lines: [] };
  }
  const config = CONFIG_NAMES.find((n) => existsSync(n));
  if (config === undefined) {
    return { code: 11, status: "noconfig", config: "-", lines: [] };
  }

  let entries: string[];
  try {
    // strip a UTF-8 BOM (Windows editors); JSON.parse rejects it, dprint accepts it
    const raw = readFileSync(config, "utf8").replace(/^\uFEFF/, "");
    // a non-object config (e.g. `null`) throws on the member access below -> reported as unreadable
    const parsed = JSON.parse(stripJsonc(raw)) as {
      plugins?: unknown;
      extends?: unknown;
    };
    const plugins = parsed.plugins;
    if (plugins !== undefined && !Array.isArray(plugins)) {
      throw new Error("\"plugins\" is not an array");
    }
    entries = ((plugins ?? []) as unknown[]).filter(
      (e): e is string => typeof e === "string",
    );
    if (parsed.extends !== undefined) {
      process.stderr.write(
        `scan-plugins: ${config} uses "extends"; plugins of extended configs are not checked\n`,
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`scan-plugins: cannot read ${config}: ${msg}\n`);
    return { code: 2, status: "error", config, lines: [] };
  }

  let files: string[];
  try {
    const out = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        encoding: "utf8",
        timeout: 60000,
        // shortcut: 256 MiB of NUL-separated paths (~ millions of files), raise if a monorepo hits it
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    files = out.split("\0").filter((f) => f !== "");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`scan-plugins: 'git ls-files' failed: ${msg}\n`);
    return { code: 2, status: "error", config, lines: [] };
  }

  let ref: RefPlugin[];
  try {
    // bundled, hand-maintained reference data (shape checked by its tests), not user input
    ref = (
      JSON.parse(
        readFileSync(new URL("./dprint-plugins.json", import.meta.url), "utf8"),
      ) as { plugins: RefPlugin[] }
    ).plugins;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `scan-plugins: cannot read dprint-plugins.json: ${msg}\n`,
    );
    return { code: 2, status: "error", config, lines: [] };
  }

  const candidates = new Map<string, RefPlugin[]>();
  const names = new Set<string>();
  const add = (key: string, p: RefPlugin) => {
    const list = candidates.get(key);
    if (list) list.push(p);
    else candidates.set(key, [p]);
  };
  for (const p of ref) {
    for (const x of p.extensions) add("." + x, p);
    for (const n of p.fileNames ?? []) {
      names.add(n);
      add(n, p);
    }
  }

  const counts = new Map<string, number>();
  for (const f of files) {
    const t = fileType(f, names);
    if (t !== null) counts.set(t, (counts.get(t) ?? 0) + 1);
  }

  const found: { type: string; n: number; ids: string[] }[] = [];
  for (const [type, n] of counts) {
    const c = candidates.get(type);
    if (c === undefined || c.some((p) => inConfig(p, entries))) continue;
    found.push({ type, n, ids: c.map((p) => p.id) });
  }
  found.sort((a, b) => b.n - a.n || (a.type < b.type ? -1 : 1));
  const lines = found.map(
    (x) => `type=${x.type} files=${x.n} candidates=${x.ids.join(",")}`,
  );
  return {
    code: lines.length ? 10 : 0,
    status: lines.length ? "missing" : "ok",
    config,
    lines,
  };
}

/** Result of this run. */
const r = scan(process.argv.slice(2));
/** Count printed as `missing=`; `-` when the scan did not get that far. */
const missing = r.code === 0 || r.code === 10 ? String(r.lines.length) : "-";
process.stdout.write(
  [`status=${r.status} config=${r.config} missing=${missing}`, ...r.lines].join(
    "\n",
  ) + "\n",
);
process.exitCode = r.code; // not process.exit(): never truncate multi-line stdout on a pipe
