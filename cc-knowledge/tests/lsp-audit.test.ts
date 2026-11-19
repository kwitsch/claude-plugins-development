// lsp-audit: the built audit-lsp.mjs run on throwaway project dirs, and the shape of its skill and docs.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PLUGIN, readPlugin, readPluginJson, REFS, run, SKILL, tmpDir } from "./support/plugin.ts";

const SCRIPT = join(PLUGIN, "skills", "lsp-audit", "scripts", "audit-lsp.mjs");
const audit = (proj: string, ...args: string[]) => run(SCRIPT, [proj, ...args]);
type Entry = { ext: string; server?: string };
type Out = { lspJsonExists: boolean; legacyRootLspJson: boolean; pluginManifestMissing: boolean; migratedFromRoot: boolean; wrote: boolean; applied: string[]; mergedIntoServers: string[]; createdServers: string[]; conflictsSkipped: unknown[]; proposals: Entry[]; unknown: Entry[] };
type Server = { extensionToLanguage: Record<string, string> };
const json = (r: { stdout: string }): Out => JSON.parse(r.stdout) as Out;
const read = (p: string): string => readFileSync(p, "utf8");
const readJson = (p: string): Record<string, Server> => JSON.parse(read(p)) as Record<string, Server>;
const write = (p: string, c: string): void => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, c);
};
const canonical = (p: string): boolean => {
  const t = read(p);
  return t === JSON.stringify(JSON.parse(t), null, 2) + "\n";
};
const VTSLS_TS = { vtsls: { command: "npx", args: ["-y", "@vtsls/language-server@0.3.0", "--stdio"], extensionToLanguage: { ".ts": "typescript" }, startupTimeout: 60000 } };
const PYLSP = `{ "pylsp": { "command": "pylsp", "args": [], "extensionToLanguage": { ".py": "python" }, "startupTimeout": 60000 } }\n`;

/** A project dir with an `.lsp.json` in the plugin location. */
function proj(lsp?: string): { p: string; d: string; f: string } {
  const p = tmpDir();
  const d = join(p, ".claude", "skills", "lsp");
  const f = join(d, ".lsp.json");
  if (lsp !== undefined) write(f, lsp);
  return { p, d, f };
}

const SKILL_MD = (): string => readPlugin("skills/lsp-audit/SKILL.md");
const REF_MD = (): string => readPlugin("skills/lsp-audit/scripts/audit-lsp.reference.md");

test("audit-lsp.mjs exists and passes node --check", () => {
  expect(existsSync(SCRIPT)).toBe(true);
  expect(run(process.execPath, ["--check", SCRIPT]).status).toBe(0);
});

test("audit-lsp.reference.md exists and documents the invocation", () => {
  expect(REF_MD()).toContain("audit-lsp.mjs");
});

test("audit-lsp.reference.md documents the plugin target, legacy migration and new output keys", () => {
  const r = REF_MD();
  for (
    const s of [".claude/skills/lsp/.lsp.json", ".claude-plugin/plugin.json", "legacyRootLspJson", "migratedFromRoot", "pluginManifestMissing", "only migrates a legacy root file"]
  ) expect(r).toContain(s);
});

test("lsp-map.json is valid JSON with the expected catalog shape", () => {
  const m = readPluginJson("skills/lsp-audit/scripts/lsp-map.json");
  for (const v of Object.values(m)) expect(typeof v === "string" || (typeof v === "object" && v !== null && "server" in v)).toBe(true);
});

test("audit mode: reports catalog proposals and unknowns for uncovered exts", () => {
  const { p } = proj("{}\n");
  for (const n of ["a.py", "b.go", "c.md"]) write(join(p, n), "x\n");
  const r = audit(p);
  expect(r.status).toBe(0);
  const o = json(r);
  expect(o.lspJsonExists).toBe(true);
  expect(o.proposals.filter((x) => x.ext === ".py" && x.server === "pylsp")).toHaveLength(1);
  expect(o.proposals.filter((x) => x.ext === ".go" && x.server === "gopls")).toHaveLength(1);
  expect(o.unknown.filter((x) => x.ext === ".md")).toHaveLength(1);
});

test("--fix: writes pylsp + gopls blocks, no .md server, canonical 2-space+newline output", () => {
  const { p, f } = proj("{}\n");
  for (const n of ["a.py", "b.go", "c.md"]) write(join(p, n), "x\n");
  const r = audit(p, "--fix");
  expect(r.status).toBe(0);
  expect(json(r).applied).toContain(".py");
  expect(json(r).applied).toContain(".go");
  const c = readJson(f);
  expect(c.pylsp.extensionToLanguage[".py"]).toBe("python");
  expect(c.gopls.extensionToLanguage[".go"]).toBe("go");
  expect(Object.values(c).some((s) => ".md" in (s.extensionToLanguage ?? {}))).toBe(false);
  expect(canonical(f)).toBe(true);
});

test("--fix merges into an existing server (no duplicate block)", () => {
  const { p, f } = proj(JSON.stringify(VTSLS_TS, null, 2) + "\n");
  write(join(p, "a.mjs"), "x\n");
  const r = audit(p, "--fix");
  expect(r.status).toBe(0);
  expect(json(r).mergedIntoServers).toContain("vtsls");
  const c = readJson(f);
  expect(c.vtsls.extensionToLanguage[".mjs"]).toBe("javascript");
  expect(c.vtsls.extensionToLanguage[".ts"]).toBe("typescript");
  expect(Object.keys(c).filter((k) => k === "vtsls")).toHaveLength(1);
});

test("new server block is scoped to only the applied extension, not catalog-family siblings", () => {
  const other = { othercss: { command: "x", args: [], extensionToLanguage: { ".scss": "scss" }, startupTimeout: 60000 } };
  const { p, f } = proj(JSON.stringify(other, null, 2) + "\n");
  write(join(p, "a.css"), "x\n");
  const r = audit(p, "--apply", ".css");
  expect(r.status).toBe(0);
  expect(json(r).createdServers).toContain("cssls");
  expect(json(r).conflictsSkipped).toEqual([]);
  const c = readJson(f);
  expect(Object.keys(c.cssls.extensionToLanguage)).toEqual([".css"]);
  expect(c.othercss.extensionToLanguage[".scss"]).toBe("scss");
});

test("malformed .lsp.json: exit 1, file byte-for-byte unchanged, nothing written", () => {
  const { p, d, f } = proj("{ not valid json");
  write(join(p, "a.py"), "x\n");
  const r = audit(p, "--fix");
  expect(r.status).toBe(1);
  expect(read(f)).toBe("{ not valid json");
  expect(existsSync(join(d, ".claude-plugin"))).toBe(false);
});

test("no .lsp.json: --fix creates a well-formed fresh file", () => {
  const { p, d, f } = proj();
  write(join(p, "a.py"), "x\n");
  expect(existsSync(join(p, ".claude"))).toBe(false);
  const r = audit(p, "--fix");
  expect(r.status).toBe(0);
  expect(readJson(f).pylsp.extensionToLanguage[".py"]).toBe("python");
  expect(canonical(f)).toBe(true);
  const m = readJson(join(d, ".claude-plugin", "plugin.json"));
  expect(m.name).toBe("lsp");
  expect(m.description).toBe("Project LSP server configuration, maintained by cc-knowledge:lsp-audit.");
  expect(existsSync(join(p, ".lsp.json"))).toBe(false);
});

test("--apply applies only the named extension", () => {
  const { p, f } = proj("{}\n");
  write(join(p, "a.py"), "x\n");
  write(join(p, "b.go"), "x\n");
  const r = audit(p, "--apply", ".py");
  expect(r.status).toBe(0);
  expect(json(r).applied).toEqual([".py"]);
  const c = readJson(f);
  expect(c.pylsp.extensionToLanguage[".py"]).toBe("python");
  expect("gopls" in c).toBe(false);
});

test("dotfile with only a leading dot is skipped (no extension)", () => {
  const { p } = proj("{}\n");
  write(join(p, ".gitignore"), "x\n");
  write(join(p, "a.py"), "x\n");
  const r = audit(p);
  expect(r.status).toBe(0);
  const o = json(r);
  const exts = [...o.proposals.map((x) => x.ext), ...o.unknown.map((x) => x.ext)];
  expect(exts).not.toContain(".gitignore");
  expect(exts).not.toContain("gitignore");
});

test("pruned directories do not contribute extensions", () => {
  const { p } = proj("{}\n");
  write(join(p, "node_modules", "foo.py"), "x\n");
  const r = audit(p);
  expect(r.status).toBe(0);
  expect(json(r).proposals.map((x) => x.ext)).not.toContain(".py");
});

test("an existing plugin manifest is never overwritten", () => {
  const { p, d, f } = proj("{}\n");
  const man = join(d, ".claude-plugin", "plugin.json");
  const before = "{\"name\":\"lsp\",\"description\":\"custom\"}";
  write(man, before);
  write(join(p, "a.py"), "x\n");
  const r = audit(p, "--fix");
  expect(r.status).toBe(0);
  expect(json(r).wrote).toBe(true);
  expect(readJson(f).pylsp.extensionToLanguage[".py"]).toBe("python");
  expect(read(man)).toBe(before);
});

test("a plugin .lsp.json without a manifest is reported and repaired without rewriting the .lsp.json", () => {
  const before = "{ \"keep\":   {\"command\":\"x\",\"extensionToLanguage\":{\".zz\":\"zz\"}} }\n";
  const { p, d, f } = proj(before);
  write(join(p, "a.py"), "x\n");
  let r = audit(p);
  expect(r.status).toBe(0);
  expect(json(r).pluginManifestMissing).toBe(true);
  expect(existsSync(join(d, ".claude-plugin"))).toBe(false);
  r = audit(p, "--apply", "");
  expect(r.status).toBe(0);
  const o = json(r);
  expect(o.wrote).toBe(true);
  expect(o.applied).toEqual([]);
  expect(o.migratedFromRoot).toBe(false);
  expect(readJson(join(d, ".claude-plugin", "plugin.json")).name).toBe("lsp");
  expect(read(f)).toBe(before);
  expect(json(audit(p)).pluginManifestMissing).toBe(false);
});

test("a plain skill at .claude/skills/lsp fails closed in every mode and is left untouched", () => {
  const { p, d, f } = proj("{}\n");
  write(join(p, "a.py"), "x\n");
  write(join(d, "SKILL.md"), "---\nname: lsp\n---\n");
  for (const args of [[], ["--fix"]]) {
    const r = audit(p, ...args);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("plain skill");
  }
  expect(existsSync(join(d, ".claude-plugin"))).toBe(false);
  expect(read(f)).toBe("{}\n");
});

test("--fix migrates a root .lsp.json into the lsp plugin and removes it", () => {
  const { p, d, f } = proj();
  write(join(p, "a.ts"), "x\n");
  write(join(p, "a.py"), "x\n");
  write(join(p, ".lsp.json"), JSON.stringify(VTSLS_TS, null, 2) + "\n");
  const r = audit(p, "--fix");
  expect(r.status).toBe(0);
  expect(json(r).migratedFromRoot).toBe(true);
  expect(json(r).wrote).toBe(true);
  expect(existsSync(join(p, ".lsp.json"))).toBe(false);
  const c = readJson(f);
  expect(c.vtsls.extensionToLanguage[".ts"]).toBe("typescript");
  expect(c.pylsp.extensionToLanguage[".py"]).toBe("python");
  expect(readJson(join(d, ".claude-plugin", "plugin.json")).name).toBe("lsp");
});

test("--fix with nothing to add still migrates the root file byte-identically", () => {
  const { p, f } = proj();
  write(join(p, "a.py"), "x\n");
  const c = {
    pylsp: { command: "pylsp", args: [], extensionToLanguage: { ".py": "python" }, startupTimeout: 60000 },
    jsonls: { command: "vscode-json-languageserver", args: ["--stdio"], extensionToLanguage: { ".json": "json" }, startupTimeout: 60000 },
  };
  const text = JSON.stringify(c, null, 2) + "\n";
  write(join(p, ".lsp.json"), text);
  const r = audit(p, "--fix");
  expect(r.status).toBe(0);
  expect(json(r).applied).toEqual([]);
  expect(json(r).migratedFromRoot).toBe(true);
  expect(existsSync(join(p, ".lsp.json"))).toBe(false);
  expect(read(f)).toBe(text);
});

test("audit mode with a root .lsp.json is read-only and reports legacyRootLspJson", () => {
  const { p, d } = proj();
  write(join(p, "a.py"), "x\n");
  write(join(p, ".lsp.json"), PYLSP);
  const r = audit(p);
  expect(r.status).toBe(0);
  const o = json(r);
  expect(o.legacyRootLspJson).toBe(true);
  expect(o.lspJsonExists).toBe(false);
  expect(o.proposals.map((x) => x.ext)).not.toContain(".py");
  expect(read(join(p, ".lsp.json"))).toBe(PYLSP);
  expect(existsSync(d)).toBe(false);
});

test("a malformed root .lsp.json fails closed: nothing written, root untouched", () => {
  const { p, d } = proj();
  write(join(p, "a.py"), "x\n");
  write(join(p, ".lsp.json"), "{ not valid json");
  const r = audit(p, "--fix");
  expect(r.status).toBe(1);
  expect(read(join(p, ".lsp.json"))).toBe("{ not valid json");
  expect(existsSync(d)).toBe(false);
});

test("a shared server id with differing blocks fails closed, both files unchanged", () => {
  const { p, f } = proj();
  write(join(p, "a.ts"), "x\n");
  const a = JSON.stringify(VTSLS_TS) + "\n";
  const b = JSON.stringify({ vtsls: { ...VTSLS_TS.vtsls, extensionToLanguage: { ".mjs": "javascript" } } }) + "\n";
  write(join(p, ".lsp.json"), a);
  write(f, b);
  const r = audit(p, "--fix");
  expect(r.status).toBe(1);
  expect(read(join(p, ".lsp.json"))).toBe(a);
  expect(read(f)).toBe(b);
});

test("--apply with an empty list only migrates the root .lsp.json", () => {
  const { p, f } = proj();
  write(join(p, "a.py"), "x\n");
  write(join(p, "b.go"), "x\n");
  write(join(p, ".lsp.json"), PYLSP);
  const r = audit(p, "--apply", "");
  expect(r.status).toBe(0);
  expect(json(r).applied).toEqual([]);
  expect(json(r).migratedFromRoot).toBe(true);
  expect(existsSync(join(p, ".lsp.json"))).toBe(false);
  const c = readJson(f);
  expect(c.pylsp.extensionToLanguage[".py"]).toBe("python");
  expect("gopls" in c).toBe(false);
});

test("a root that is itself a plugin keeps its own .lsp.json (not legacy, never deleted)", () => {
  const { p } = proj();
  write(join(p, ".claude-plugin", "plugin.json"), "{\"name\":\"x\"}\n");
  write(join(p, "a.py"), "x\n");
  write(join(p, ".lsp.json"), PYLSP);
  let r = audit(p);
  expect(r.status).toBe(0);
  expect(json(r).legacyRootLspJson).toBe(false);
  r = audit(p, "--fix");
  expect(r.status).toBe(0);
  expect(json(r).migratedFromRoot).toBe(false);
  expect(read(join(p, ".lsp.json"))).toBe(PYLSP);
});

test("a shared server id differing only in key order is not a conflict", () => {
  const { p, f } = proj();
  write(join(p, "a.ts"), "x\n");
  write(join(p, ".lsp.json"), JSON.stringify(VTSLS_TS) + "\n");
  write(f, "{\"vtsls\":{\"startupTimeout\":60000,\"extensionToLanguage\":{\".ts\":\"typescript\"},\"args\":[\"-y\",\"@vtsls/language-server@0.3.0\",\"--stdio\"],\"command\":\"npx\"}}\n");
  const r = audit(p, "--fix");
  expect(r.status).toBe(0);
  expect(json(r).migratedFromRoot).toBe(true);
  expect(existsSync(join(p, ".lsp.json"))).toBe(false);
  expect(readJson(f).vtsls.extensionToLanguage[".ts"]).toBe("typescript");
});

test.skipIf(process.getuid?.() === 0)("a failing root-file delete exits 1 with a clean diagnostic, plugin files kept", () => {
  const { p, d, f } = proj("{}\n");
  write(join(d, ".claude-plugin", "plugin.json"), "{\"name\":\"lsp\"}\n");
  write(join(p, "a.py"), "x\n");
  write(join(p, ".lsp.json"), PYLSP);
  chmodSync(p, 0o555);
  let r;
  try {
    r = audit(p, "--fix");
  } finally {
    chmodSync(p, 0o755);
  }
  expect(r.status).toBe(1);
  const out = r.stdout + r.stderr;
  expect(out).toContain("could not delete");
  expect(out).not.toContain("at Object.");
  expect(readJson(f).pylsp.extensionToLanguage[".py"]).toBe("python");
});

test("a plugin .lsp.json symlinked to the root file fails closed, root file kept", () => {
  const { p, d, f } = proj();
  mkdirSync(d, { recursive: true });
  write(join(p, "a.py"), "x\n");
  write(join(p, ".lsp.json"), PYLSP);
  symlinkSync("../../../.lsp.json", f);
  expect(lstatSync(f).isSymbolicLink()).toBe(true);
  const r = audit(p, "--fix");
  expect(r.status).toBe(1);
  expect(read(join(p, ".lsp.json"))).toBe(PYLSP);
});

// --- lsp-audit SKILL.md ---

test("lsp-audit SKILL.md exists", () => {
  expect(existsSync(join(PLUGIN, "skills/lsp-audit/SKILL.md"))).toBe(true);
});

test("lsp-audit SKILL.md has name, description, argument-hint frontmatter", () => {
  const t = SKILL_MD();
  expect(t).toMatch(/^name:\s*lsp-audit/m);
  expect(t).toMatch(/^description:/m);
  expect(t).toMatch(/^argument-hint:/m);
});

test("lsp-audit is model-invocable (no disable-model-invocation)", () => {
  expect(SKILL_MD()).not.toMatch(/^disable-model-invocation:\s*true/m);
});

test("lsp-audit runs inline (no context: fork)", () => {
  expect(SKILL_MD()).not.toMatch(/^context:\s*fork/m);
});

test("lsp-audit gates via AskUserQuestion", () => {
  expect(SKILL_MD()).toContain("AskUserQuestion");
});

test("lsp-audit allowed-tools include Bash, Read, AskUserQuestion", () => {
  const t = SKILL_MD();
  for (const tool of ["Bash", "Read", "AskUserQuestion"]) expect(t).toMatch(new RegExp(`^allowed-tools:.*${tool}`, "m"));
});

test("lsp-audit carries the review-skip justification for unscoped Bash", () => {
  expect(SKILL_MD()).toContain("review-skip(F1)");
});

test("lsp-audit has a Read step for audit-lsp.reference.md", () => {
  expect(SKILL_MD()).toContain("audit-lsp.reference.md");
});

test("lsp-audit references its bundled script via CLAUDE_SKILL_DIR", () => {
  expect(SKILL_MD()).toContain("${CLAUDE_SKILL_DIR}/scripts/audit-lsp.mjs");
});

test("lsp-audit has no load-time !-injection trigger", () => {
  expect(SKILL_MD()).not.toContain("!`");
});

test("lsp-audit points at the cc-reference LSP schema doc, not a local restatement", () => {
  expect(SKILL_MD()).toContain("claude-code-plugins-lsp.reference.md");
});

test("lsp-audit SKILL.md targets the project-scope lsp plugin path", () => {
  expect(SKILL_MD()).toContain(".claude/skills/lsp");
});

test("lsp-audit SKILL.md gates the legacy root migration on legacyRootLspJson", () => {
  const t = SKILL_MD();
  for (const s of ["legacyRootLspJson", "migratedFromRoot", "pluginManifestMissing", "apply \"\"", "lsp@skills-dir"]) expect(t).toContain(s);
});

// --- docs ---

test("docs describe the project-scope lsp plugin target", () => {
  expect(readPlugin("README.md")).toContain(".claude/skills/lsp");
});

test("README lists lsp-audit in the Skills table", () => {
  expect(readPlugin("README.md")).toContain("`lsp-audit`");
});

test("LSP reference documents no project-root scope and keeps one not-loaded directive", () => {
  const t = read(join(REFS, "claude-code-plugins-lsp.reference.md"));
  expect(t).not.toContain("Project-scoped");
  expect(t).not.toContain("has no path variable substitution");
  expect(t).toContain("is not loaded by Claude Code");
});

test("cc-reference SKILL.md LSP index carries no project-root scope or example", () => {
  const t = read(join(SKILL, "SKILL.md"));
  expect(t).not.toContain("project-scoped (undocumented");
  expect(t).not.toContain("Example (project-root");
  expect(t).toContain("Example (plugin-scoped .lsp.json)");
  expect(t).toContain("project-root .lsp.json not loaded");
});
