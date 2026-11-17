/**
 * `.editorconfig` resolver and the mapping of its properties to CLI formatter flags.
 *
 * @packageDocumentation
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { FormatTool } from "./registry.js";

/** The `.editorconfig` properties this plugin understands, normalised by {@link normalizeProps}. */
export type EditorConfigProps = {
  /** `tab` or `space`, lower case. */
  indent_style?: string;
  /** A positive integer, or the literal `tab`. */
  indent_size?: number | "tab";
  /** A positive integer; `off` counts as not set. */
  max_line_length?: number;
  /** Lower case. */
  end_of_line?: string;
};

/** A parsed `.editorconfig` file. */
type ParsedEditorconfig = {
  /** Whether the file declares `root = true`. */
  root: boolean;
  /** The sections in file order. */
  sections: { glob: string; props: Record<string, string> }[];
};

/** What a tool is run with: its argv, or `skip` for a style it cannot honor. */
export type Invocation = { argv: string[] } | { skip: true };

/**
 * Builds the argv of a tool from its strategy, a governing tool-native config and the resolved `.editorconfig`.
 *
 * @param tool - The formatter.
 * @param opts - `hasNativeConfig`: a tool-native config governs the file; `editorconfig`: the resolved properties, or null when no `.editorconfig` was found.
 * @returns The argv (without the stdin tail), or `skip` for a hard style conflict.
 */
export function buildInvocation(tool: FormatTool, opts: { hasNativeConfig?: boolean; editorconfig?: EditorConfigProps | null } = {}): Invocation {
  const { hasNativeConfig = false, editorconfig = null } = opts;
  if (tool.strategy !== "mapped" || hasNativeConfig || !editorconfig || !Object.hasOwn(MAPPERS, tool.name)) return { argv: tool.base.slice() };
  return MAPPERS[tool.name](tool.base, editorconfig);
}

/** `.editorconfig` to CLI flags, per mapped tool. */
const MAPPERS: Record<string, (base: string[], ec: EditorConfigProps) => Invocation> = {
  ruff(base, ec) {
    const argv = base.slice();
    if (typeof ec.max_line_length === "number") argv.push("--line-length", String(ec.max_line_length));
    if (ec.indent_style === "tab" || ec.indent_style === "space") argv.push("--config", `format.indent-style='${ec.indent_style}'`);
    // `indent-width` is a top-level ruff setting: `format.indent-width` is rejected (exit 2, no output)
    if (typeof ec.indent_size === "number") argv.push("--config", `indent-width=${ec.indent_size}`);
    return { argv };
  },
  black(base, ec) {
    if (ec.indent_style === "tab") return { skip: true }; // black is fixed at 4 spaces
    const argv = base.slice();
    if (typeof ec.max_line_length === "number") argv.push("--line-length", String(ec.max_line_length));
    return { argv };
  },
  rustfmt(base, ec) {
    const argv = base.slice();
    if (typeof ec.max_line_length === "number") argv.push("--config", `max_width=${ec.max_line_length}`);
    if (ec.indent_style === "tab") argv.push("--config", "hard_tabs=true");
    else if (ec.indent_style === "space") argv.push("--config", "hard_tabs=false");
    if (typeof ec.indent_size === "number") argv.push("--config", `tab_spaces=${ec.indent_size}`);
    return { argv };
  },
};

/**
 * Whether a tool-native config governs a file: walks from the file's directory up to `cwd` (inclusive).
 *
 * @param fileDir - The file's directory.
 * @param cwd - Where the walk ends.
 * @param entries - A file name (must exist), or a file plus a TOML section it must hold (`[section]` or `[section.*]`).
 * @returns True on the first match.
 */
export function findNativeConfig(fileDir: string, cwd: string, entries: (string | { file: string; section: string })[]): boolean {
  let dir = fileDir;
  for (;;) {
    for (const entry of entries) {
      if (typeof entry === "string") {
        if (existsSync(path.join(dir, entry))) return true;
        continue;
      }
      const p = path.join(dir, entry.file);
      if (!existsSync(p)) continue;
      let text = "";
      try {
        text = readFileSync(p, "utf8");
      } catch {
        // unreadable: treated as absent
      }
      const escaped = entry.section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp("^\\s*\\[" + escaped + "(\\.[^\\]]*)?\\]", "m").test(text)) return true;
    }
    if (dir === cwd) return false;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Resolves the `.editorconfig` properties of a file: walks from its directory up to `cwd` (inclusive), stops after a
 * file with `root = true`; nearer files and later sections win.
 *
 * @param file - The file.
 * @param cwd - Where the walk ends.
 * @param opts - `unbounded`: walk to the filesystem root instead, as prettier's own lookup does.
 * @returns `found` (any `.editorconfig` was read) and the normalised properties.
 */
export function resolveEditorconfig(file: string, cwd: string, opts: { unbounded?: boolean } = {}): { found: boolean; props: EditorConfigProps } {
  const { unbounded = false } = opts;
  const basename = path.basename(file);
  /** The files found, nearest first. */
  const parsed: ParsedEditorconfig[] = [];
  let dir = path.dirname(file);
  for (;;) {
    const p = path.join(dir, ".editorconfig");
    if (existsSync(p)) {
      let text: string | undefined;
      try {
        text = readFileSync(p, "utf8");
      } catch {
        // unreadable: treated as absent
      }
      if (text !== undefined) {
        const pf = parseEditorconfig(text);
        parsed.push(pf);
        if (pf.root) break;
      }
    }
    if (!unbounded && dir === cwd) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (parsed.length === 0) return { found: false, props: {} };
  const raw: Record<string, string> = {};
  // farthest first, so the nearer file wins
  for (const pf of parsed.slice().reverse()) {
    for (const section of pf.sections) {
      if (matchGlob(section.glob, basename)) Object.assign(raw, section.props);
    }
  }
  return { found: true, props: normalizeProps(raw) };
}

/**
 * Parses `.editorconfig` text. Comments (`#`, `;`) and blank lines are ignored; keys before the first section count
 * only for `root`.
 *
 * @param text - The file content.
 * @returns `root` and the sections with their raw properties (keys lower case).
 */
export function parseEditorconfig(text: string): ParsedEditorconfig {
  let root = false;
  const sections: ParsedEditorconfig["sections"] = [];
  let current: ParsedEditorconfig["sections"][number] | null = null;
  for (const line of String(text).split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#") || s.startsWith(";")) continue;
    const sec = /^\[(.*)\]$/.exec(s);
    if (sec) {
      current = { glob: sec[1].trim(), props: {} };
      sections.push(current);
      continue;
    }
    const eq = s.indexOf("=");
    if (eq === -1) continue;
    const key = s.slice(0, eq).trim().toLowerCase();
    const value = s.slice(eq + 1).trim();
    if (!current) {
      if (key === "root") root = value.toLowerCase() === "true";
      continue;
    }
    current.props[key] = value;
  }
  return { root, sections };
}

/**
 * Matches a section glob against a file's base name. Supported: `*`, `**`, `?`, `{a,b}`; a glob with a path separator,
 * a character class, a negation or a brace range never matches (no mapping rather than a wrong one).
 *
 * @param glob - The section glob.
 * @param basename - The file's base name.
 * @returns True when the glob matches.
 */
export function matchGlob(glob: string, basename: string): boolean {
  return globToRegExp(glob)?.test(basename) ?? false;
}

/**
 * Compiles a supported section glob.
 *
 * @param glob - The section glob.
 * @returns The anchored expression, or null for an unsupported glob.
 */
function globToRegExp(glob: string): RegExp | null {
  if (glob.includes("/") || glob.includes("[") || glob.includes("]") || glob.includes("!")) return null;
  if (/\{[^}]*\.\.[^}]*\}/.test(glob)) return null; // brace range {1..9}
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (c === "?") re += ".";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) return null;
      re += "(?:" + glob.slice(i + 1, end).split(",").map(escape).join("|") + ")";
      i = end;
    } else re += escape(c);
  }
  return new RegExp("^" + re + "$");
}

/**
 * Normalises raw properties: styles lower case, sizes positive integers only (anything else is dropped), an explicit
 * `max_line_length = off` dropped.
 *
 * @param raw - The raw properties of the matching sections.
 * @returns The typed properties.
 */
function normalizeProps(raw: Record<string, string>): EditorConfigProps {
  const out: EditorConfigProps = {};
  /** A positive integer, else undefined. */
  const positive = (v: string): number | undefined => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  if (raw.indent_style) out.indent_style = raw.indent_style.toLowerCase();
  if (raw.indent_size !== undefined) {
    const size = raw.indent_size.toLowerCase() === "tab" ? "tab" : positive(raw.indent_size);
    if (size !== undefined) out.indent_size = size;
  }
  if (raw.max_line_length !== undefined && raw.max_line_length.toLowerCase() !== "off") {
    const n = positive(raw.max_line_length);
    if (n !== undefined) out.max_line_length = n;
  }
  if (raw.end_of_line) out.end_of_line = raw.end_of_line.toLowerCase();
  return out;
}
