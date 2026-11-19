#!/usr/bin/env node
/**
 * Detects the development tools (runtimes, package managers, LSP servers) a project uses, from catalog signal-file
 * basenames anywhere in the pruned tree, catalog root-only signal paths (`rootFiles`) at the project root only, and
 * from the bare command names in the project-root `.mcp.json` and `.lsp.json` (legacy) and the `.lsp.json` of the
 * project's lsp plugin (`.claude/skills/lsp/`, where lsp-audit writes the LSP servers), against the bundled
 * `tool-map.json` catalog.
 *
 * @remarks
 * Zero-dep. Audit mode is read-only; `--write` renders the bundled init-dev-environment templates into
 * `<root>/.claude/skills/init-dev-environment/` atomically, only when that directory is absent; `--add <ids>`
 * re-renders an existing skill's `SKILL.md` and `install.sh` with the listed detected tools it lacks added.
 * Diagnostics go to stderr; stdout carries only the JSON result object.
 *
 * @packageDocumentation
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

/**
 * Directories never walked: the lsp-audit denylist plus virtualenv, cache and build-output directories; third-party
 * packages in them ship their own `package.json` / `requirements.txt`, which would read as a project signal.
 */
const PRUNE_NAMES = new Set([".git", "node_modules", "vendor", "dist", "build", ".venv", "venv", ".tox", "site-packages", "target"]);

/** Commands every machine that runs Claude Code has; never reported. */
const ASSUMED_PRESENT = new Set(["git", "bash", "sh", "curl", "claude"]);

/** Trust-boundary filter for repo-supplied command names: 1-64 characters, so paths, `${...}`, spaces, backticks and `$(...)` never pass. */
const COMMAND_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/** Evidence entries kept per tool. */
const EVIDENCE_CAP = 5;

/** A parsed JSON object whose members are not typed. */
type JsonObject = Record<string, unknown>;

/** The catalog indexed for detection. */
type Catalog = {
  /** Signal-file basename to tool id. */
  fileIndex: Map<string, string>;
  /** Command name to tool id. */
  commandIndex: Map<string, string>;
  /** `[root-relative path, tool id]` pairs from the optional per-entry `rootFiles` arrays, checked at the project root only. */
  rootFiles: [string, string][];
  /** The catalog ids in key order. */
  ids: string[];
};

/** A detected tool with the files or commands that showed it. */
type ToolHit = { id: string; evidence: string[] };

/** A command found in a config that the catalog does not know. */
type ManualHit = { command: string; evidence: string[] };

/** What detection found. */
type Detection = { tools: ToolHit[]; manual: ManualHit[]; ids: string[] };

/**
 * Loads the bundled catalog and indexes it. Both indexes are Maps, so a repo-supplied name like "constructor" can
 * never resolve to a tool.
 *
 * @returns The indexes and the catalog ids.
 * @throws Error when `tool-map.json` is malformed.
 */
function loadCatalog(): Catalog {
  try {
    const catalog = JSON.parse(readFileSync(new URL("./tool-map.json", import.meta.url), "utf8")) as unknown;
    if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) throw new Error("expected a JSON object at the top level");
    const entries = catalog as Record<string, { files?: unknown; commands?: unknown; rootFiles?: unknown } | null>;
    const fileIndex = new Map<string, string>();
    const commandIndex = new Map<string, string>();
    const rootFiles: [string, string][] = [];
    const ids = Object.keys(entries);
    for (const id of ids) {
      const entry = entries[id];
      if (!entry || !Array.isArray(entry.files) || !Array.isArray(entry.commands)) throw new Error(`"${id}" needs "files" and "commands" arrays`);
      if (
        entry.rootFiles !== undefined
        && (!Array.isArray(entry.rootFiles) || !entry.rootFiles.every((f: unknown) => typeof f === "string"))
      ) throw new Error(`"${id}" "rootFiles" must be an array of strings`);
      for (const f of entry.files as string[]) fileIndex.set(f, id);
      for (const c of entry.commands as string[]) commandIndex.set(c, id);
      for (const p of entry.rootFiles ?? []) rootFiles.push([p, id]);
    }
    return { fileIndex, commandIndex, rootFiles, ids };
  } catch (err) {
    throw new Error(`Malformed bundled tool-map.json catalog: ${(err as Error).message}`, { cause: err });
  }
}

/**
 * Walks the tree (prune rules: see {@link PRUNE_NAMES}) and collects, per tool id, the root-relative paths of regular
 * files whose basename is a catalog signal. Symlinks are never followed: `Dirent.isDirectory()`/`isFile()` are false
 * for them.
 *
 * @param root - Absolute project root.
 * @param fileIndex - Basename to tool id.
 * @returns Signal file paths per tool id.
 */
function findSignalFiles(root: string, fileIndex: Map<string, string>): Map<string, string[]> {
  const hits = new Map<string, string[]>();
  /**
   * Walks one directory.
   *
   * @param dir - Directory to walk.
   * @param parentName - Basename of its parent.
   */
  const walk = (dir: string, parentName: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // readdir order is filesystem-dependent; sort so capped evidence is deterministic.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const name = e.name;
      if (e.isDirectory()) {
        if (PRUNE_NAMES.has(name)) continue;
        if (parentName === ".claude" && (name === "worktrees" || name === "agent-memory")) continue;
        walk(join(dir, name), name);
      } else if (e.isFile()) {
        const id = fileIndex.get(name);
        if (id === undefined) continue;
        const list = hits.get(id) ?? [];
        list.push(relative(root, join(dir, name)));
        hits.set(id, list);
      }
    }
  };
  walk(root, basename(root));
  return hits;
}

/**
 * Reads a JSON config file. Absent gives `null`. Malformed JSON or a top level that is not a plain object throws, so
 * `main` fails closed before any write.
 *
 * @param path - File to read.
 * @returns The parsed object, or `null` when the file does not exist.
 * @throws Error when the file is malformed or not an object.
 */
function readJsonObject(path: string): JsonObject | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Malformed ${path}: ${(err as Error).message}`, { cause: err });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Malformed ${path}: expected a JSON object at the top level, got ${Array.isArray(parsed) ? "an array" : parsed === null ? "null" : `a ${typeof parsed}`}`);
  }
  return parsed as JsonObject;
}

/**
 * Bare command names from `.lsp.json` (every server block's `command`) at the project root (legacy) and in the lsp
 * plugin lsp-audit writes (`.claude/skills/lsp/`), and from the root `.mcp.json` (every `mcpServers.*.command`).
 * Fixed paths, never searched for; entries without a string `command` (e.g. http/sse servers) are skipped.
 *
 * @param root - Absolute project root.
 * @returns Each command with the file it came from.
 */
function configCommands(root: string): { command: string; source: string }[] {
  const out: { command: string; source: string }[] = [];
  /**
   * Takes the command of one server block.
   *
   * @param block - A server block.
   * @param source - The config file it came from.
   */
  const take = (block: unknown, source: string): void => {
    if (block && typeof block === "object" && !Array.isArray(block) && typeof (block as JsonObject).command === "string") {
      out.push({ command: (block as { command: string }).command, source });
    }
  };
  for (const source of [".lsp.json", ".claude/skills/lsp/.lsp.json"]) {
    const lsp = readJsonObject(join(root, source));
    if (lsp) { for (const block of Object.values(lsp)) take(block, source); }
  }
  const mcp = readJsonObject(join(root, ".mcp.json"));
  const servers = mcp ? mcp.mcpServers : null;
  if (servers && typeof servers === "object" && !Array.isArray(servers)) { for (const block of Object.values(servers)) take(block, ".mcp.json"); }
  return out;
}

/**
 * Classifies signal files (tree-wide basenames, plus catalog `rootFiles` paths checked at the project root only) and
 * config commands into catalog tools and manual to-dos. Evidence is unique, in insertion order (signal files first,
 * then config commands), capped at {@link EVIDENCE_CAP}.
 *
 * @param root - Absolute project root.
 * @returns The detected tools, the unknown commands and the catalog ids in catalog key order.
 */
function detect(root: string): Detection {
  const { fileIndex, commandIndex, rootFiles, ids } = loadCatalog();
  const toolEvidence = new Map<string, string[]>();
  const manualEvidence = new Map<string, string[]>();
  /**
   * Adds one evidence item to a key, unique and capped.
   *
   * @param map - The evidence map.
   * @param key - Tool id or command.
   * @param item - The evidence.
   */
  const add = (map: Map<string, string[]>, key: string, item: string): void => {
    const list = map.get(key) ?? [];
    if (!list.includes(item) && list.length < EVIDENCE_CAP) list.push(item);
    map.set(key, list);
  };
  for (const [id, paths] of findSignalFiles(root, fileIndex)) for (const p of paths) add(toolEvidence, id, p);
  // rootFiles are signal files too, but only at the project root (a nested config never counts)
  for (const [p, id] of rootFiles) if (existsSync(join(root, p))) add(toolEvidence, id, p);
  for (const { command, source } of configCommands(root)) {
    if (!COMMAND_TOKEN.test(command) || ASSUMED_PRESENT.has(command)) continue;
    const id = commandIndex.get(command);
    if (id !== undefined) add(toolEvidence, id, `${source}: ${command}`);
    else add(manualEvidence, command, `${source}: ${command}`);
  }
  const tools = ids.filter((id) => toolEvidence.has(id)).map((id) => ({ id, evidence: toolEvidence.get(id) ?? [] }));
  const manual = [...manualEvidence.keys()].sort().map((command) => ({ command, evidence: manualEvidence.get(command) ?? [] }));
  return { tools, manual, ids };
}

/**
 * Fills the `SKILL.md` template. Function replacers keep `$&`/`$1` literal.
 *
 * @param template - The template text.
 * @param ids - Tool ids for `@@TOOLS@@`.
 * @param manual - Unknown commands for `@@MANUAL@@`.
 * @returns The rendered text.
 */
function render(template: string, ids: string[], manual: { command: string }[]): string {
  return template.replaceAll("@@TOOLS@@", () => ids.join(" ")).replaceAll("@@MANUAL@@", () => (manual.length ? manual.map((m) => m.command).join(", ") : "none"));
}

/**
 * The tool ids an existing init-dev-environment skill installs, read from the first `install.sh --dry-run <ids>` line
 * of its `SKILL.md`. A hand-edited list is never guessed at, nor re-rendered into the skill's shell command lines.
 *
 * @param skillDir - The skill directory.
 * @param catalogIds - The catalog ids.
 * @returns The listed ids, or `null` when `SKILL.md` cannot be read, has no such line, or lists any token that is not a catalog id.
 */
function skillToolIds(skillDir: string, catalogIds: string[]): string[] | null {
  let text: string;
  try {
    text = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
  const m = /install\.sh --dry-run ([^\n]*)/.exec(text);
  if (!m) return null;
  const known = new Set(catalogIds);
  const listed = (m[1] ?? "").trim().split(/\s+/);
  return listed.every((id) => known.has(id)) ? listed : null;
}

/**
 * Writes `<root>/.claude/skills/init-dev-environment/` from the bundled templates. Both templates are read first and
 * the files are built in a same-filesystem temp dir outside the watched skills dir. When the skill directory is
 * created (`replace` false), the temp dir is chmod 0755 (mkdtemp creates 0700) and renamed into place. When it is
 * updated (`replace` true), `install.sh` and then `SKILL.md` are renamed over the existing files one at a time (a
 * directory rename cannot replace a non-empty directory), each keeping the mode of the file it replaces; other files
 * in the directory and its mode are kept. On any failure after mkdtemp the temp dir is removed and the error
 * rethrown, so a create never leaves a partial skill directory.
 *
 * @param root - Absolute project root.
 * @param ids - Tool ids the skill installs.
 * @param manual - Unknown commands for the template's manual list.
 * @param replace - `true` (`--add`) swaps files into the existing skill directory; `false` (`--write`) renames a fresh directory into place, which fails if one appeared meanwhile.
 * @returns `true` when this call created `<root>/.claude/skills`.
 */
function writeSkill(root: string, ids: string[], manual: { command: string }[], replace: boolean): boolean {
  const skillTemplate = readFileSync(new URL("../templates/init-dev-environment/SKILL.md.tmpl", import.meta.url), "utf8");
  const installer = readFileSync(new URL("../templates/init-dev-environment/install.sh", import.meta.url));
  const skillsDir = join(root, ".claude", "skills");
  const skillDir = join(skillsDir, "init-dev-environment");
  const skillsDirCreated = !existsSync(skillsDir);
  mkdirSync(skillsDir, { recursive: true });
  let tmp = "";
  try {
    tmp = mkdtempSync(join(root, ".claude", ".init-dev-environment-"));
    writeFileSync(join(tmp, "SKILL.md"), render(skillTemplate, ids, manual));
    writeFileSync(join(tmp, "install.sh"), installer);
    if (replace) {
      // A directory rename cannot replace a non-empty directory: swap file by
      // file, installer first, so a failure in between leaves the newer
      // installer (a recipe superset) under the older tool list. A replaced
      // file keeps its existing mode (e.g. a committed 0755 install.sh).
      /**
       * Renames one built file over its existing copy, keeping that copy's mode.
       *
       * @param name - File name in the skill directory.
       */
      const swap = (name: string): void => {
        const dest = join(skillDir, name);
        if (existsSync(dest)) chmodSync(join(tmp, name), statSync(dest).mode & 0o7777);
        renameSync(join(tmp, name), dest);
      };
      swap("install.sh");
      swap("SKILL.md");
      rmSync(tmp, { recursive: true, force: true });
    } else {
      chmodSync(tmp, 0o755);
      renameSync(tmp, skillDir);
    }
  } catch (err) {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    // Undo the skills dir this call created, so a retry still reports
    // skillsDirCreated (rmdir only removes an empty directory).
    if (skillsDirCreated) {
      try {
        rmdirSync(skillsDir);
      } catch {
        // not empty or already gone: leave it
      }
    }
    throw err;
  }
  return skillsDirCreated;
}

/**
 * Prints an error to stderr and exits 1.
 *
 * @param msg - The message.
 * @returns Never returns.
 */
function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Parses the arguments, runs the detection and prints the JSON result. */
function main(): void {
  const argv = process.argv.slice(2);
  let rootArg: string | null = null;
  let write = false;
  let addIds: string[] | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") write = true;
    else if (a === "--add") {
      // The id list never starts with "--" or holds a "/", so a following flag
      // or project-root path is left for the loop instead of being swallowed.
      const next = argv[i + 1] ?? "";
      const isList = !next.startsWith("--") && !next.includes("/");
      if (isList) i++;
      addIds = (isList ? next : "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (!a.startsWith("--") && rootArg === null) rootArg = a;
  }
  const root = resolve(rootArg ?? ".");
  const skillDir = join(root, ".claude", "skills", "init-dev-environment");

  let found: Detection;
  try {
    found = detect(root);
  } catch (err) {
    return fail((err as Error).message);
  }

  const skillExists = existsSync(skillDir);
  const listed = skillExists ? skillToolIds(skillDir, found.ids) : null;
  const missingTools = listed ? found.tools.map((t) => t.id).filter((id) => !listed.includes(id)) : null;
  const out: Record<string, unknown> = { root, tools: found.tools, manual: found.manual, skillDir, skillExists, missingTools };
  if (write) {
    const wrote = found.tools.length > 0 && !skillExists;
    let skillsDirCreated = false;
    if (wrote) {
      try {
        skillsDirCreated = writeSkill(
          root,
          found.tools.map((t) => t.id),
          found.manual,
          false,
        );
      } catch (err) {
        return fail(`Failed to write ${skillDir}: ${(err as Error).message}`);
      }
    }
    out.wrote = wrote;
    out.skillsDirCreated = skillsDirCreated;
  }
  if (addIds) {
    const requested = new Set(addIds);
    const added = (missingTools ?? []).filter((id) => requested.has(id));
    if (added.length) {
      const keep = new Set([...(listed ?? []), ...added]);
      try {
        writeSkill(
          root,
          found.ids.filter((id) => keep.has(id)),
          found.manual,
          true,
        );
      } catch (err) {
        return fail(`Failed to update ${skillDir}: ${(err as Error).message}`);
      }
    }
    out.added = added;
  }
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

main();
