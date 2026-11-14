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
import { parseSync, type StaticImport } from "oxc-parser";
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

/** The helper name of a sibling import source `./name.mjs`, else undefined. */
const siblingName = (source: string): string | undefined => /^\.\/([\w-]+)\.mjs$/.exec(source)?.[1];

/**
 * Cuts spans out of code and puts their replacement in. A span followed by a line break takes it along when its
 * replacement is empty (a dropped import leaves no blank line), so text inside literals is never touched.
 *
 * @param code - The code.
 * @param spans - Non-overlapping spans with their replacement text.
 * @returns The code with every span replaced.
 */
const splice = (code: string, spans: { start: number; end: number; text: string }[]): string => {
  let out = code;
  for (const s of [...spans].sort((a, b) => b.start - a.start)) {
    const end = s.text === "" && out[s.end] === "\n" ? s.end + 1 : s.end;
    out = out.slice(0, s.start) + s.text + out.slice(end);
  }
  return out;
};

/**
 * Bundles the helper modules of `plugin/hooks` into one module without a bundler. A helper is any hooks module that
 * `plugin/hooks/hooks.json` does not list; the listed entry modules stay separate files (Claude Code reads them) and
 * import what they need from `./lib.mjs` instead of the helpers. Works on type-stripped code; imports and exports are
 * taken from the oxc-parser parse, never matched by line (a line of a multi-line template literal can look like one).
 * Relies on what the sources guarantee, all of it checked here: helpers import each other by `./name.mjs` with named
 * imports only (no `as`), export only declarations, their top-level names (imported or declared) are unique across
 * helpers (they were one file once; named imports of one other source, such as `node:path`, merge into one import),
 * and they keep no state at module level that a test kit reload could miss.
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
  /** The module's static imports and `export` statement starts, from the parse. */
  const parse = (f: string, code: string): { imports: StaticImport[]; exports: number[] } => {
    const r = parseSync(f, code, { sourceType: "module" });
    if (r.errors.length) fail(`${path.relative(ROOT, f)} does not parse: ${r.errors[0].message}`);
    return { imports: r.module.staticImports, exports: r.module.staticExports.map((e) => e.start) };
  };
  /** The specifiers (`a`, `a as b`) of an import of helper `name`; fails on a namespace, default or side-effect import. */
  const namedSpecs = (f: string, imp: StaticImport, name: string): string[] => {
    if (!imp.entries.length || imp.entries.some((e) => (e.importName.kind as string) !== "Name")) {
      fail(`${path.relative(ROOT, f)} imports ./${name}.mjs other than by named imports`);
    }
    return imp.entries.map((e) => (e.importName.name === e.localName.value ? e.localName.value : `${e.importName.name ?? ""} as ${e.localName.value}`));
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
    const { imports, exports } = parse(f, code);
    const deps: string[] = [];
    for (const imp of imports) {
      const name = siblingName(imp.moduleRequest.value);
      if (name === undefined) {
        hoisted.add(code.slice(imp.start, imp.end).trim());
        continue;
      }
      const dep = byName.get(name);
      if (!dep) fail(`${path.relative(ROOT, f)} imports ./${name}.mjs, which is not a helper`);
      else deps.push(dep);
      // the import is dropped, so an alias would leave its local name unbound
      if (namedSpecs(f, imp, name).some((s) => s.includes(" as "))) fail(`${path.relative(ROOT, f)} renames an import of ./${name}.mjs with \`as\``);
    }
    // every import is dropped; `export <declaration>` loses its keyword (lib.mjs exports what the entries take)
    const spans = imports.map((i) => ({ start: i.start, end: i.end, text: "" }));
    for (const start of exports) {
      const kw = /^export\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/.exec(code.slice(start, start + 40))?.[0];
      if (kw === undefined) fail(`${path.relative(ROOT, f)} exports something other than a declaration`);
      else spans.push({ start, end: start + kw.length, text: "" });
    }
    bodies.set(f, splice(code, spans));
    for (const d of deps) visit(d);
    visiting.delete(f);
    ordered.push(f);
  };
  for (const f of members) visit(f);
  // named imports of one source merge into one import (the same name from two helpers is bound once); others stay whole lines
  const named = new Map<string, Set<string>>();
  const imports: string[] = [];
  for (const line of hoisted) {
    const m = /^import\s*\{([^}]*)\}\s*from\s*(["'][^"']*["']);?$/.exec(line);
    if (!m) imports.push(line);
    else for (const s of m[1].split(",").map((x) => x.trim().replace(/\s+/g, " ")).filter(Boolean)) named.set(m[2], (named.get(m[2]) ?? new Set()).add(s));
  }
  for (const [source, specs] of named) imports.push(`import { ${[...specs].join(", ")} } from ${source};`);
  // every top-level name, imported or declared, is unique across the helpers
  const seen = new Map<string, string>();
  const bind = (name: string, where: string): void => {
    const other = seen.get(name);
    if (other !== undefined) fail(`${name} is bound by ${other} and ${where}`);
    seen.set(name, where);
  };
  for (const line of imports) {
    // the local name is the last word of each specifier: `a`, `a as b`, `* as b`, a default `b`
    const clause = /^import\s*([^"']*?)\s*from\s*["']/.exec(line)?.[1] ?? "";
    for (const s of clause.replace(/[{}]/g, ",").split(",").map((x) => x.trim()).filter(Boolean)) bind(s.split(/\s+/).at(-1) ?? s, `\`${line}\``);
  }
  for (const f of ordered) {
    for (const m of (bodies.get(f) ?? "").matchAll(/^(?:export\s+)?(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      bind(m[1], path.relative(ROOT, f));
    }
  }
  // the entries import from lib.mjs; lib.mjs exports exactly the names they take
  const needed = new Set<string>();
  const entries = new Map<string, string>();
  for (const [f, code] of compiled) {
    if (!entryPaths.has(f)) continue;
    // all imports of helpers become one import from lib.mjs, in the place of the first
    const taken: string[] = [];
    const spans: { start: number; end: number; text: string }[] = [];
    for (const imp of parse(f, code).imports) {
      const name = siblingName(imp.moduleRequest.value);
      if (name === undefined || !byName.has(name)) continue;
      for (const n of namedSpecs(f, imp, name)) {
        taken.push(n);
        needed.add(n.split(" as ")[0]);
      }
      spans.push({ start: imp.start, end: imp.end, text: "" });
    }
    // the first helper import becomes the lib.mjs import, the others go (with their line break)
    if (spans.length) spans[0].text = `import { ${taken.sort().join(", ")} } from "./lib.mjs";`;
    entries.set(f, splice(code, spans));
  }
  const text = ordered.map((f) => bodies.get(f) ?? "").join("\n");
  const code = `${imports.join("\n")}\n${text}\nexport { ${[...needed].sort().join(", ")} };\n`;
  // the name check above sees only a declaration's first name; Node's parse catches every other duplicate binding
  // (`const a = 1, b = 2`, destructuring) before it ships as a SyntaxError
  const check = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: code, encoding: "utf8" });
  if (check.status !== 0) fail(`lib.mjs does not parse (a top-level name bound twice across helpers?):\n${check.stderr}`);
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
