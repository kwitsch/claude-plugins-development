#!/usr/bin/env node
// Usage: build-plugin.mts [plugin dir]  (default: the cwd; every plugin's `build` script runs it from its own dir)
// Builds one plugin: src/**/*.mts -> plugin/**/*.mjs via oxc-transform (type stripping; type checks run in
// `pnpm lint`), minified with oxc-minify, then generates plugin/.claude-plugin/plugin.json from package.json.
// Generated .mjs files and plugin/.claude-plugin/plugin.json must never be edited by hand.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { minifySync } from "oxc-minify";
import { transformSync } from "oxc-transform";
import { pluginManifest } from "./plugin-manifest.mts";

/** The plugin directory (holds package.json, src/ and plugin/). */
const ROOT = path.resolve(process.argv[2] ?? ".");
/** The shipped plugin. */
const PLUGIN = path.join(ROOT, "plugin");
/** The TypeScript sources. */
const SRC = path.join(ROOT, "src");

/**
 * Every file below a directory, recursively.
 *
 * @param dir - Directory to walk; a missing one yields no files.
 * @returns The file paths.
 */
const walk = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((d) => !d.isDirectory())
      .map((d) => path.join(d.parentPath, d.name))
    : [];

/** Where the bundled helper modules of a function-hooks plugin are written. */
const libPath = (): string => path.join(PLUGIN, "hooks", "lib.mjs");

/** A top-level sibling import of the form `import { a, b } from "./x.mjs";` (type stripping leaves one statement per import). */
const SIBLING_IMPORT = /^import\s*\{([^}]*)\}\s*from\s*"\.\/([\w-]+)\.mjs";?[ \t]*$/gm;

/**
 * Bundles the helper modules of `plugin/hooks` into one module without a bundler. A helper is any hooks module that
 * `plugin/hooks/hooks.json` does not list; the listed entry modules stay separate files (Claude Code reads them) and
 * import what they need from `./lib.mjs` instead of the helpers. Works on type-stripped code and relies on what the
 * sources guarantee, all of it checked here: helpers import each other by `./name.mjs` with named imports only, their
 * top-level names are unique across helpers (they were one file once), and they keep no state at module level that
 * a test kit reload could miss.
 *
 * @param compiled - Type-stripped code by output path.
 * @returns The helpers' output paths, the entry modules with their imports pointed at lib.mjs, and lib.mjs' code.
 */
function bundleLib(compiled: Map<string, string>): { members: string[]; entries: Map<string, string>; code: string } {
  const hooksDir = path.join(PLUGIN, "hooks");
  const listed = (JSON.parse(readFileSync(path.join(hooksDir, "hooks.json"), "utf8")) as { modules?: string[] }).modules ?? [];
  const entryPaths = new Set(listed.map((m) => path.resolve(hooksDir, m)));
  const members = [...compiled.keys()].filter((f) => path.dirname(f) === hooksDir && !entryPaths.has(f));
  const byName = new Map(members.map((f) => [path.basename(f, ".mjs"), f]));
  const fail = (msg: string): never => {
    console.error(`bundleHooksLib: ${msg}`);
    return process.exit(1);
  };
  // the helpers in dependency order (a helper after the helpers it imports), the other imports (node:) hoisted
  const ordered: string[] = [];
  const hoisted = new Set<string>();
  const visiting = new Set<string>();
  const bodies = new Map<string, string>();
  const visit = (f: string): void => {
    if (ordered.includes(f)) return;
    if (visiting.has(f)) fail(`import cycle at ${path.relative(ROOT, f)}`);
    visiting.add(f);
    const code = compiled.get(f) ?? "";
    const deps: string[] = [];
    const body = code.replace(SIBLING_IMPORT, (_m, _names: string, name: string) => {
      const dep = byName.get(name);
      if (!dep) fail(`${path.relative(ROOT, f)} imports ./${name}.mjs, which is not a helper`);
      else deps.push(dep);
      return "";
    });
    for (const line of body.split("\n")) if (/^import[\s{*"']/.test(line)) hoisted.add(line.trim());
    bodies.set(f, body.split("\n").filter((l) => !/^import[\s{*"']/.test(l)).join("\n"));
    for (const d of deps) visit(d);
    visiting.delete(f);
    ordered.push(f);
  };
  for (const f of members) visit(f);
  // every top-level name is unique across the helpers
  const seen = new Map<string, string>();
  for (const f of ordered) {
    for (const m of (bodies.get(f) ?? "").matchAll(/^(?:export\s+)?(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      const other = seen.get(m[1]);
      if (other !== undefined) fail(`${m[1]} is declared in ${path.relative(ROOT, other)} and ${path.relative(ROOT, f)}`);
      seen.set(m[1], f);
    }
  }
  // the entries import from lib.mjs; lib.mjs exports exactly the names they take
  const needed = new Set<string>();
  const entries = new Map<string, string>();
  for (const [f, code] of compiled) {
    if (!entryPaths.has(f)) continue;
    // all imports of helpers become one import from lib.mjs, in the place of the first
    const taken: string[] = [];
    let first = true;
    const rewritten = code.replace(SIBLING_IMPORT, (m, names: string, name: string) => {
      if (!byName.has(name)) return m;
      for (const n of names.split(",").map((s) => s.trim()).filter(Boolean)) {
        taken.push(n);
        needed.add(n.split(/\s+as\s+/)[0]);
      }
      if (!first) return "";
      first = false;
      return "\u0000lib\u0000";
    });
    entries.set(f, rewritten.replace("\u0000lib\u0000", () => `import { ${taken.sort().join(", ")} } from "./lib.mjs";`).replace(/\n{3,}/g, "\n\n"));
  }
  const text = ordered.map((f) => (bodies.get(f) ?? "").replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/gm, "")).join("\n");
  if (/^export\s/m.test(text)) fail("a helper exports something other than a declaration");
  const code = `${[...hoisted].join("\n")}\n${text}\nexport { ${[...needed].sort().join(", ")} };\n`;
  return { members, entries, code };
}

// 0. plugin/ ships only build output and hand-written plugin files (.claude/rules/plugin-build-output.md)
const layout = spawnSync(
  process.execPath,
  [path.join(path.dirname(fileURLToPath(import.meta.url)), "check-plugin-layout.mts"), ROOT],
  { stdio: "inherit" },
);
if (layout.status !== 0) process.exit(layout.status ?? 1);

// 1. remove stale build output (plugin/ holds no hand-written .mjs)
for (const f of walk(PLUGIN)) if (f.endsWith(".mjs")) rmSync(f);

// 2. compile: strip types file by file (.mts -> .mjs), then minify.
// Type checking is not part of the build: `pnpm lint` (oxlint --type-check) does it.
const files = walk(SRC);
const stray = files.filter((f) => !f.endsWith(".mts"));
if (stray.length) {
  // src/ holds only .mts: anything else (a .ts, a .js) would silently not ship
  for (const f of stray) console.error(`${path.relative(ROOT, f)}: src/ holds only .mts sources`);
  process.exit(1);
}
const sources = files.filter((f) => !f.endsWith(".d.mts"));
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as Record<string, unknown>;
/** Type-stripped code per output file. */
const compiled = new Map<string, string>();
for (const src of sources) {
  const out = path.join(PLUGIN, path.relative(SRC, src)).replace(/\.mts$/, ".mjs");
  const t = transformSync(src, readFileSync(src, "utf8"), { sourceType: "module", target: "es2022" });
  if (t.errors.length) {
    for (const e of t.errors) console.error(`${path.relative(ROOT, src)}: ${e.message}`);
    process.exit(1);
  }
  compiled.set(out, t.code);
}

// package.json `pluginBuild.bundleHooksLib: true`: the helper modules of plugin/hooks (everything hooks.json does not list) become one lib.mjs.
if ((pkg["pluginBuild"] as { bundleHooksLib?: unknown } | undefined)?.bundleHooksLib === true) {
  const lib = bundleLib(compiled);
  for (const f of lib.members) compiled.delete(f);
  for (const [f, code] of lib.entries) compiled.set(f, code);
  compiled.set(libPath(), lib.code);
}

for (const [out, code] of compiled) {
  // shipped output is for node, not humans: minify (drops comments, keeps the shebang and export names).
  // Function-hooks entry modules (the ones plugin/hooks/hooks.json lists, and every hooks/*.mjs when nothing is bundled)
  // keep their names and shape: Claude Code's static check wants named hook functions, `$`/`on` spelled as such and no
  // shadowed names, which compress/mangle would break. They also keep their whitespace: whitespace removal turns every
  // string literal into a template literal, and the static check reads only string literals (e.g. a
  // `$.command.register({ name })` its own command hook answers). The bundled lib is compressed and stripped of
  // whitespace, but not mangled: it still spells `$` and the engine calls the way the sources do.
  const hooksModule = path.relative(PLUGIN, out).startsWith("hooks" + path.sep);
  const isLib = out === libPath();
  const m = minifySync(out, code, {
    module: true,
    compress: hooksModule && !isLib ? false : { target: "es2022" },
    mangle: !hooksModule,
    codegen: { removeWhitespace: !hooksModule || isLib, legalComments: "none" },
  });
  if (m.errors.length) {
    for (const e of m.errors) console.error(`${path.relative(ROOT, out)}: ${e.message}`);
    process.exit(1);
  }
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, m.code.endsWith("\n") ? m.code : m.code + "\n");
  if (m.code.startsWith("#!")) chmodSync(out, 0o755);
}

// 3. manifest: generated from <name>/package.json (the only manifest source) by plugin-manifest.mts
let manifest: Record<string, unknown>;
try {
  manifest = pluginManifest(pkg);
} catch (e) {
  // nothing is written: the previous manifest stays in place
  console.error((e as Error).message);
  process.exit(1);
}
mkdirSync(path.join(PLUGIN, ".claude-plugin"), { recursive: true });
writeFileSync(path.join(PLUGIN, ".claude-plugin", "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`built ${String(manifest.name)}@${String(manifest.version)} (${sources.length} source file(s))`);
