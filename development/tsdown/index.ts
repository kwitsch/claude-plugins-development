// The tsdown build standard of this repository (.claude/rules/tsdown-build.md): a plugin's tsdown.config.ts is
// `export default pluginConfig({ mods: [...], scripts: [...] })`. Every entry is built on its own into one
// self-contained file, and the first build also writes plugin/.claude-plugin/plugin.json from package.json.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Rolldown, UserConfig } from "tsdown";
import { pluginManifest } from "../scripts/plugin-manifest.ts";

/** Entries of one plugin, each a path below src/ without extension, e.g. "hooks/register", "bin/mcp". */
export type PluginEntries = {
  /** Function-hooks modules: src/<entry>.ts -> plugin/<entry>.js, compressed, not mangled, no shebang. */
  mods?: string[];
  /** MCP servers, command hooks, bin scripts: src/<entry>.ts -> plugin/<entry>.mjs, fully minified, shebang, 0755. */
  scripts?: string[];
};

/** What an entry is built as. */
type Kind = "mod" | "script";

/** The shape of a valid entry: path segments of word characters and hyphens, no extension, no `..`. */
const ENTRY = /^[\w-]+(\/[\w-]+)*$/;
/** The shared sources every bundled file may import as `@shared/<name>.js`. */
const SHARED_SRC = fileURLToPath(new URL("../shared/src", import.meta.url));
/** The layout check of what plugin/ may hold, shared with the old build. */
const LAYOUT_CHECK = fileURLToPath(new URL("../scripts/check-plugin-layout.ts", import.meta.url));

/**
 * The output extension of a kind.
 *
 * @param kind - What the entry is built as.
 * @returns `.js` for a mod, `.mjs` for a script.
 */
const ext = (kind: Kind): string => (kind === "mod" ? ".js" : ".mjs");

/**
 * Fails an entry's build unless its output is one self-contained file of its kind.
 *
 * @param kind - What the entry is built as.
 * @returns The rolldown plugin.
 */
function checkPlugin(kind: Kind): Rolldown.Plugin {
  return {
    name: "plugin-build:check",
    generateBundle(_options, bundle) {
      const files = Object.values(bundle);
      const chunk = files[0];
      // a dynamic import() or an emitted asset adds a second file
      if (files.length !== 1 || chunk?.type !== "chunk") return this.error(`expected exactly one output file, got ${files.map((f) => f.fileName).join(", ")}`);
      // covers a bare builtin ("fs"), a dependency left external and a missed @shared alias
      const external = [...chunk.imports, ...chunk.dynamicImports].filter((s) => !s.startsWith("node:"));
      if (external.length) return this.error(`${chunk.fileName} is not self-contained, it imports ${external.join(", ")} (only node: imports may stay)`);
      const hasShebang = chunk.code.startsWith("#!");
      if (kind === "script" && !hasShebang) return this.error(`${chunk.fileName}: line 1 of a script source must be #!/usr/bin/env node`);
      if (kind === "mod" && hasShebang) return this.error(`${chunk.fileName}: a mod must not start with a shebang`);
    },
  };
}

/**
 * Validates package.json and the layout of plugin/ before the build, then removes stale build output and writes plugin.json.
 *
 * @param root - The plugin directory (holds package.json, src/ and plugin/).
 * @param outputs - The output paths of all entries, relative to plugin/.
 * @returns The rolldown plugin.
 */
function manifestPlugin(root: string, outputs: string[]): Rolldown.Plugin {
  const out = path.join(root, "plugin");
  /** Build output that stays: the entries' files and the plugin's `pluginBuild.assets`. */
  const keep = new Set(outputs);
  let manifest: Record<string, unknown> = {};
  /**
   * Deletes every regular .mjs/.js file below a directory that is not kept. Symlinks are never followed or deleted.
   *
   * @param dir - Directory below plugin/.
   */
  const removeStale = (dir: string): void => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, d.name);
      if (d.isDirectory()) removeStale(file);
      else if (d.isFile() && /\.m?js$/.test(d.name) && !keep.has(path.relative(out, file).split(path.sep).join("/"))) rmSync(file);
    }
  };
  return {
    name: "plugin-build:manifest",
    buildStart() {
      const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, unknown> & { pluginBuild?: { assets?: string[] } };
      // throws on an invalid manifest field, before anything is written
      manifest = pluginManifest(pkg);
      const check = spawnSync(process.execPath, [LAYOUT_CHECK, root], { stdio: "inherit" });
      if (check.status !== 0) return this.error("plugin/ holds files the shipped plugin may not contain (listed above)");
      // read after the layout check: it has validated pluginBuild.assets as an array of strings
      for (const a of pkg.pluginBuild?.assets ?? []) keep.add(a);
    },
    writeBundle() {
      removeStale(out);
      mkdirSync(path.join(out, ".claude-plugin"), { recursive: true });
      writeFileSync(path.join(out, ".claude-plugin", "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
    },
  };
}

/**
 * The tsdown configs of one plugin, one per entry, so no code is shared between outputs.
 *
 * @param entries - The plugin's entries by kind.
 * @param root - The plugin directory; a plugin's build script runs tsdown in it.
 * @returns One config per entry; the first one also writes plugin.json and removes stale output.
 */
export function pluginConfig(entries: PluginEntries, root: string = process.cwd()): UserConfig[] {
  const listed: { kind: Kind; entry: string }[] = [
    ...(entries.mods ?? []).map((entry) => ({ kind: "mod" as const, entry })),
    ...(entries.scripts ?? []).map((entry) => ({ kind: "script" as const, entry })),
  ];
  if (!listed.length) throw new Error("tsdown.config.ts: no entry listed (mods or scripts)");
  const seen = new Set<string>();
  for (const { kind, entry } of listed) {
    if (!ENTRY.test(entry)) throw new Error(`tsdown.config.ts: invalid ${kind} entry ${JSON.stringify(entry)} (a path below src/ without extension, e.g. "hooks/register")`);
    if (seen.has(`${kind}:${entry}`)) throw new Error(`tsdown.config.ts: ${kind} entry "${entry}" is listed twice`);
    seen.add(`${kind}:${entry}`);
    if (!existsSync(path.join(root, "src", `${entry}.ts`))) throw new Error(`src/${entry}.ts: listed as a ${kind} entry in tsdown.config.ts but does not exist`);
  }
  const outputs = listed.map(({ kind, entry }) => entry + ext(kind));
  return listed.map(({ kind, entry }, i): UserConfig => ({
    entry: { [entry]: path.join(root, "src", `${entry}.ts`) },
    outDir: path.join(root, "plugin"),
    cwd: root,
    format: "esm",
    platform: "node",
    target: "es2022",
    // plugin/ also holds hand-written files
    clean: false,
    dts: false,
    sourcemap: false,
    alias: { "@shared": SHARED_SRC },
    // every import is bundled; node: builtins stay external (platform node), checkPlugin enforces the outcome
    deps: { alwaysBundle: [/./], onlyBundle: false },
    outExtensions: () => ({ js: ext(kind) }),
    // a mod is compressed only: Claude Code's static check reads the names $, on, next and register
    minify: kind === "mod" ? { mangle: false, compress: true } : true,
    plugins: [checkPlugin(kind), ...(i === 0 ? [manifestPlugin(root, outputs)] : [])],
  }));
}
