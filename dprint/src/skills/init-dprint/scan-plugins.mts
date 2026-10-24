#!/usr/bin/env node
// init-dprint skill helper: list the project's file types (git ls-files in cwd), find the dprint
// config in cwd and report every file type that a plugin in dprint-plugins.json can format but no
// plugin in the config covers. Output and exit codes per scan-plugins.reference.md. Read-only.

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// dprint's own discovery order (resolve_main_config_path.rs, POSSIBLE_CONFIG_FILE_NAMES)
const CONFIG_NAMES = [
  "dprint.json",
  "dprint.jsonc",
  ".dprint.json",
  ".dprint.jsonc",
];

interface RefPlugin {
  id: string;
  npm?: string;
  extensions: string[];
  fileNames?: string[];
}

interface ScanResult {
  code: number;
  status: string;
  config: string;
  lines: string[];
}

/** JSONC -> JSON: drops comments and trailing commas outside string literals */
function stripJsonc(text: string): string {
  const keep = (m: string) => (m[0] === '"' ? m : "");
  return text
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, keep)
    .replace(/"(?:\\.|[^"\\])*"|,(?=\s*[\]}])/g, keep);
}

/** true when a config plugins entry references p (registry URL, npm specifier or node_modules path) */
function inConfig(p: RefPlugin, entries: string[]): boolean {
  const prefix = `https://plugins.dprint.dev/${p.id}-`;
  const npm = p.npm;
  return entries.some(
    (e) =>
      (e.startsWith(prefix) && /^v?\d/.test(e.slice(prefix.length))) ||
      (npm !== undefined &&
        (e === `npm:${npm}` ||
          e.startsWith(`npm:${npm}@`) ||
          e.startsWith(`npm:${npm}/`) ||
          e.includes(`node_modules/${npm}/`))),
  );
}

/** file-type key of a git path: exact reference file name, else "." + lower-cased extension, else null */
function fileType(path: string, names: Set<string>): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (names.has(base)) return base;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? "." + base.slice(dot + 1).toLowerCase() : null;
}

/** args = command-line arguments after the script path */
function scan(args: string[]): ScanResult {
  if (args.length > 0) {
    process.stderr.write("usage: node scan-plugins.mjs (takes no arguments)\n");
    return { code: 2, status: "error", config: "-", lines: [] };
  }
  const config = CONFIG_NAMES.find((n) => existsSync(n));
  if (config === undefined)
    return { code: 11, status: "noconfig", config: "-", lines: [] };

  let entries: string[];
  try {
    const parsed = JSON.parse(stripJsonc(readFileSync(config, "utf8")));
    const plugins: unknown = parsed.plugins;
    if (plugins !== undefined && !Array.isArray(plugins))
      throw new Error('"plugins" is not an array');
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
    ref = JSON.parse(
      readFileSync(new URL("./dprint-plugins.json", import.meta.url), "utf8"),
    ).plugins;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `scan-plugins: cannot read dprint-plugins.json: ${msg}\n`,
    );
    return { code: 2, status: "error", config, lines: [] };
  }

  const candidates = new Map<string, RefPlugin[]>();
  for (const p of ref) {
    for (const key of [
      ...p.extensions.map((x) => "." + x),
      ...(p.fileNames ?? []),
    ]) {
      const list = candidates.get(key);
      if (list) list.push(p);
      else candidates.set(key, [p]);
    }
  }
  const names = new Set(ref.flatMap((p) => p.fileNames ?? []));

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
  found.sort(
    (a, b) => b.n - a.n || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0),
  );
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

const r = scan(process.argv.slice(2));
const missing = r.code === 0 || r.code === 10 ? String(r.lines.length) : "-";
process.stdout.write(
  [`status=${r.status} config=${r.config} missing=${missing}`, ...r.lines].join(
    "\n",
  ) + "\n",
);
process.exitCode = r.code; // not process.exit(): never truncate multi-line stdout on a pipe
