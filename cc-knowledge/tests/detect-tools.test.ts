// Ports of the bats cases for the repository-audit skill shape and `detect-tools.mjs` (+ `--write` / `--add`).
// The built script runs on throwaway project dirs; nothing is shared between tests.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { frontmatter, PLUGIN, put, readPlugin, readPluginJson, run, tmpDir } from "./support/plugin.ts";

const RA = "skills/repository-audit";
const SCRIPT = join(PLUGIN, RA, "detect-tools.mjs");
const INSTALL_SH = join(PLUGIN, RA, "templates", "init-dev-environment", "install.sh");
const AUDIT = readPlugin(`${RA}/SKILL.md`);
const AUDIT_FM = frontmatter(AUDIT);

/** Runs detect-tools on arguments; `out` is stdout plus stderr (the bats `$output`), `json` the parsed stdout when it is JSON. */
function detect(...args: string[]): { status: number | null; out: string; json: Report } {
  const r = run(SCRIPT, args);
  let json = {} as Report;
  try {
    json = JSON.parse(r.stdout) as Report;
  } catch { /* error output */ }
  return { status: r.status, out: r.stdout + r.stderr, json };
}

/** The fields of detect-tools' JSON report that the tests read. */
type Report = {
  root: string;
  tools: { id: string; evidence: string[] }[];
  manual: { command: string }[];
  skillExists: boolean;
  skillsDirCreated: boolean;
  wrote: boolean;
  missingTools: string[] | null;
  added: string[];
};

/** A tool-map.json entry. */
type MapEntry = { rootFiles?: unknown[]; files: unknown[]; commands: string[] };

/** Signal files: package.json, pnpm-lock.yaml, sub/Cargo.toml, a root .lsp.json (gopls, npx) and .mcp.json (docker, git, curl, a plugin-root path). */
function fixture(dir: string): void {
  put(join(dir, "package.json"), "{}\n");
  put(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n");
  put(join(dir, "sub/Cargo.toml"), "[package]\n");
  put(join(dir, ".lsp.json"), "{\"gopls\":{\"command\":\"gopls\"},\"ts\":{\"command\":\"npx\"}}\n");
  put(
    join(dir, ".mcp.json"),
    "{\"mcpServers\":{\"d\":{\"command\":\"docker\"},\"g\":{\"command\":\"git\"},\"c\":{\"command\":\"curl\"},\"x\":{\"command\":\"${CLAUDE_PLUGIN_ROOT}/bin/x\"}}}\n",
  );
}

const ids = (j: Report): string[] => j.tools.map((t) => t.id);
const evidence = (j: Report, id: string): string[] => j.tools.find((t) => t.id === id)?.evidence ?? [];
const mode = (p: string): string => (statSync(p).mode & 0o777).toString(8);
const skillDir = (proj: string): string => join(proj, ".claude/skills/init-dev-environment");
const read = (p: string): string => readFileSync(p, "utf8");
const same = (a: string, b: string): boolean => readFileSync(a).equals(readFileSync(b));
/** Leftover atomic-write temp directories (bats: `ls -d .claude/.init-dev-environment-* .claude/skills/.init-dev-environment-*`). */
const leftovers = (proj: string): string[] => [join(proj, ".claude"), join(proj, ".claude/skills")].flatMap((d) => existsSync(d) ? readdirSync(d).filter((n) => n.startsWith(".init-dev-environment-")) : []);
const project = (): string => tmpDir("cck-detect-");

// --- repository-audit SKILL.md shape ---

test("repository-audit SKILL.md exists", () => {
  expect(existsSync(join(PLUGIN, RA, "SKILL.md"))).toBe(true);
});

test("repository-audit SKILL.md has name, description, argument-hint frontmatter", () => {
  expect(AUDIT_FM.data.name).toBe("repository-audit");
  expect(AUDIT_FM.data).toHaveProperty("description");
  expect(AUDIT_FM.data).toHaveProperty("argument-hint");
});

test("repository-audit argument-hint begins with [--fix]", () => {
  expect(AUDIT_FM.data["argument-hint"]).toMatch(/^\[--fix\]/);
});

test("repository-audit runs inline (no context: fork)", () => {
  expect(AUDIT).not.toMatch(/^context:\s*fork/m);
});

test("repository-audit is model-invocable (no disable-model-invocation)", () => {
  expect(AUDIT).not.toMatch(/^disable-model-invocation:\s*true/m);
});

test("repository-audit has no load-time !-injection trigger", () => {
  expect(AUDIT).not.toContain("!`");
});

test("repository-audit carries the AskUserQuestion mandate", () => {
  expect(AUDIT).toContain("AskUserQuestion");
});

test("repository-audit allowed-tools include Bash, Read, Skill, AskUserQuestion", () => {
  for (const t of ["Bash", "Read", "Skill", "AskUserQuestion"]) expect(AUDIT_FM.data["allowed-tools"]).toContain(t);
});

test("repository-audit carries the review-skip justification for unscoped Bash", () => {
  expect(AUDIT).toContain("review-skip(F1)");
});

test("repository-audit allowed-tools include Edit and Write for manual-task application", () => {
  expect(AUDIT_FM.data["allowed-tools"]).toContain("Edit");
  expect(AUDIT_FM.data["allowed-tools"]).toContain("Write");
});

test("repository-audit offers memory-audit manual tasks via AskUserQuestion, auto-selected under --fix", () => {
  for (const s of ["### Offer memory-audit", "`$FIX` set", "multiSelect: true"]) expect(AUDIT).toContain(s);
});

test("memory-audit report lists manual to-dos as id · path · recommendation lines", () => {
  expect(readPlugin("skills/memory-audit/SKILL.md")).toContain("<id> · <path> · <recommendation>");
});

test("repository-audit invokes both nested audits by qualified name", () => {
  expect(AUDIT).toContain("cc-knowledge:lsp-audit");
  expect(AUDIT).toContain("cc-knowledge:memory-audit");
});

test("cc-knowledge README lists repository-audit in the Skills table", () => {
  expect(readPlugin("README.md")).toContain("`repository-audit`");
});

// --- detect-tools.mjs ---

test("detect-tools.mjs exists and passes node --check", () => {
  expect(existsSync(SCRIPT)).toBe(true);
  expect(run(process.execPath, ["--check", SCRIPT]).status).toBe(0);
});

test("tool-map.json is valid JSON with the expected catalog shape", () => {
  const m = readPluginJson(`${RA}/tool-map.json`);
  const all = Object.values<MapEntry>(m);
  for (const e of all) {
    if (e.rootFiles != null) {
      expect(Array.isArray(e.rootFiles)).toBe(true);
      expect(e.rootFiles.every((f: unknown) => typeof f === "string")).toBe(true);
    }
    expect(Array.isArray(e.files)).toBe(true);
    expect(Array.isArray(e.commands)).toBe(true);
    expect([...e.files, ...e.commands].every((s: unknown) => typeof s === "string")).toBe(true);
  }
  expect(m.dprint.rootFiles).toEqual(["dprint.json", "dprint.jsonc", ".dprint.json", ".dprint.jsonc", ".config/dprint.json", ".config/dprint.jsonc"]);
  const cmds: string[] = all.flatMap((e) => e.commands);
  expect(new Set(cmds).size).toBe(cmds.length);
  for (const c of ["git", "bash", "sh", "curl", "claude"]) expect(cmds).not.toContain(c);
});

test("detection: signal files and config commands map to catalog tools and manual to-dos", () => {
  const proj = project();
  fixture(proj);
  const { status, json } = detect(proj);
  expect(status).toBe(0);
  expect(ids(json)).toEqual(["node", "pnpm", "cargo", "gopls"]);
  expect(evidence(json, "cargo")).toContain("sub/Cargo.toml");
  expect(evidence(json, "node")).toEqual(["package.json", ".lsp.json: npx"]);
  expect(json.manual.map((m) => m.command)).toEqual(["docker"]);
  expect(json.skillExists).toBe(false);
  // git, curl (assumed present) and the path command appear nowhere
  expect(JSON.stringify([json.tools, json.manual])).not.toMatch(/git|curl|CLAUDE_PLUGIN_ROOT/);
});

test("detection: command names outside the token regex are dropped; lookups are Map-only", () => {
  const proj = project();
  const servers = { a: { command: "x`id`" }, b: { command: "a b" }, c: { command: "a".repeat(65) }, d: { command: "constructor" } };
  put(join(proj, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
  const { status, json } = detect(proj);
  expect(status).toBe(0);
  expect(json.tools).toEqual([]);
  expect(json.manual.map((m) => m.command)).toEqual(["constructor"]);
});

test("detection: pruned directories contribute nothing", () => {
  const proj = project();
  put(join(proj, "node_modules/x/go.mod"), "module x\n");
  put(join(proj, ".claude/worktrees/w/Cargo.toml"), "[package]\n");
  const { status, json } = detect(proj);
  expect(status).toBe(0);
  expect(json.tools).toEqual([]);
  expect(json.manual).toEqual([]);
});

test("detection: virtualenv, tox and build-output directories contribute nothing", () => {
  const proj = project();
  put(join(proj, ".venv/lib/jup/package.json"), "{}\n");
  put(join(proj, "venv/x/package.json"), "{}\n");
  put(join(proj, "target/y/Cargo.toml"), "[package]\n");
  put(join(proj, ".tox/py3/requirements.txt"), "x\n");
  put(join(proj, "src/site-packages/z/package.json"), "{}\n");
  put(join(proj, "requirements.txt"), "x\n");
  const { status, json } = detect(proj);
  expect(status).toBe(0);
  expect(ids(json)).toEqual(["python3"]);
});

test("detection: a python launcher command maps to python, python3 to python3", () => {
  const proj = project();
  put(join(proj, ".mcp.json"), "{\"mcpServers\":{\"a\":{\"command\":\"python\"}}}\n");
  let r = detect(proj);
  expect(r.status).toBe(0);
  expect(ids(r.json)).toEqual(["python"]);
  put(join(proj, ".mcp.json"), "{\"mcpServers\":{\"a\":{\"command\":\"python3\"}}}\n");
  r = detect(proj);
  expect(r.status).toBe(0);
  expect(ids(r.json)).toEqual(["python3"]);
});

test("detection: LSP server commands in the lsp plugin's .lsp.json (.claude/skills/lsp/) count", () => {
  const proj = project();
  const f = join(proj, ".claude/skills/lsp/.lsp.json");
  put(f, "{\"go\":{\"command\":\"gopls\"},\"py\":{\"command\":\"pylsp\"}}\n");
  let r = detect(proj);
  expect(r.status).toBe(0);
  expect(ids(r.json)).toEqual(["gopls", "pylsp"]);
  expect(evidence(r.json, "gopls")).toEqual([".claude/skills/lsp/.lsp.json: gopls"]);
  writeFileSync(f, "{ not valid");
  r = detect(proj);
  expect(r.status).toBe(1);
  expect(r.out).toMatch(/Malformed.*\.lsp\.json/s);
});

test("detection: an empty project reports nothing, in the canonical JSON format", () => {
  const proj = project();
  const r = run(SCRIPT, [proj]);
  expect(r.status).toBe(0);
  const j = JSON.parse(r.stdout);
  expect(j.tools).toEqual([]);
  expect(j.manual).toEqual([]);
  expect(j.skillExists).toBe(false);
  expect(r.stdout).toBe(JSON.stringify(j, null, 2) + "\n");
});

test("detection: malformed .mcp.json or non-object .lsp.json exits 1 and --write creates nothing", () => {
  const proj = project();
  put(join(proj, "package.json"), "{}\n");
  put(join(proj, ".mcp.json"), "{ not valid json");
  let r = detect(proj);
  expect(r.status).toBe(1);
  expect(r.out).toMatch(/Malformed.*\.mcp\.json/s);
  expect(detect(proj, "--write").status).toBe(1);
  expect(existsSync(join(proj, ".claude/skills"))).toBe(false);
  rmSync(join(proj, ".mcp.json"));
  put(join(proj, ".lsp.json"), "[]\n");
  r = detect(proj);
  expect(r.status).toBe(1);
  expect(r.out).toMatch(/Malformed.*\.lsp\.json.*an array/s);
});

test("detection: a root dprint config detects dprint", () => {
  const proj = project();
  put(join(proj, "dprint.json"), "{}\n");
  const { status, json } = detect(proj);
  expect(status).toBe(0);
  expect(ids(json)).toEqual(["dprint"]);
  expect(evidence(json, "dprint")).toEqual(["dprint.json"]);
});

test("detection: .config/dprint.jsonc at the root detects dprint", () => {
  const proj = project();
  put(join(proj, ".config/dprint.jsonc"), "{}\n");
  const { status, json } = detect(proj);
  expect(status).toBe(0);
  expect(ids(json)).toEqual(["dprint"]);
  expect(evidence(json, "dprint")).toEqual([".config/dprint.jsonc"]);
});

test("detection: a nested dprint config does not detect dprint", () => {
  const proj = project();
  put(join(proj, "sub/dprint.json"), "{}\n");
  put(join(proj, "sub/.config/dprint.json"), "{}\n");
  const { status, json } = detect(proj);
  expect(status).toBe(0);
  expect(json.tools).toEqual([]);
});

// --- init-dev-environment generation (--write, SKILL.md.tmpl) ---

test("detect-tools.reference.md exists and documents the script and its bundled templates", () => {
  const f = join(PLUGIN, RA, "detect-tools.reference.md");
  expect(existsSync(f)).toBe(true);
  const t = read(f);
  for (const s of ["detect-tools.mjs", "install.sh", "Bundled templates"]) expect(t).toContain(s);
});

test("--write creates the init-dev-environment skill atomically (0755, byte-identical install.sh)", () => {
  const proj = project();
  fixture(proj);
  expect(existsSync(join(proj, ".claude"))).toBe(false);
  const { status, json } = detect(proj, "--write");
  expect(status).toBe(0);
  expect(json.wrote).toBe(true);
  expect(json.skillsDirCreated).toBe(true);
  const d = skillDir(proj);
  expect(existsSync(join(d, "SKILL.md"))).toBe(true);
  expect(same(join(d, "install.sh"), INSTALL_SH)).toBe(true);
  const s = read(join(d, "SKILL.md"));
  expect(s).toContain("name: init-dev-environment");
  expect(s).toContain("install.sh --dry-run node pnpm cargo gopls");
  expect(s).toContain("(install manually): docker");
  expect(s).not.toContain("@@");
  expect(s).not.toContain("!`");
  expect(mode(d)).toBe("755");
  expect(leftovers(proj)).toEqual([]);
});

test("--write next to an existing .claude/skills reports skillsDirCreated false", () => {
  const proj = project();
  fixture(proj);
  mkdirSync(join(proj, ".claude/skills/other"), { recursive: true });
  const { status, json } = detect(proj, "--write");
  expect(status).toBe(0);
  expect(json.wrote).toBe(true);
  expect(json.skillsDirCreated).toBe(false);
  expect(existsSync(join(skillDir(proj), "SKILL.md"))).toBe(true);
});

test("--write never overwrites an existing init-dev-environment directory", () => {
  const proj = project();
  fixture(proj);
  put(join(skillDir(proj), "SKILL.md"), "hand edit\n");
  const { status, json } = detect(proj, "--write");
  expect(status).toBe(0);
  expect([json.skillExists, json.wrote, json.skillsDirCreated]).toEqual([true, false, false]);
  expect(read(join(skillDir(proj), "SKILL.md"))).toBe("hand edit\n");
  expect(existsSync(join(skillDir(proj), "install.sh"))).toBe(false);
});

test("--write with no detected tools writes nothing", () => {
  const proj = project();
  const { status, json } = detect(proj, "--write");
  expect(status).toBe(0);
  expect(json.tools).toEqual([]);
  expect(json.wrote).toBe(false);
  expect(json.skillsDirCreated).toBe(false);
  expect(existsSync(join(proj, ".claude"))).toBe(false);
});

test("--add extends an existing skill with only the confirmed missing ids, byte-identical to a fresh generation", () => {
  const proj = project();
  const fresh = project();
  const d = skillDir(proj);
  put(join(proj, "package.json"), "{}\n");
  put(join(proj, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n");
  let r = detect(proj, "--write");
  expect(r.status).toBe(0);
  expect(r.json.wrote).toBe(true);
  expect(r.json.missingTools).toBeNull();
  r = detect(proj);
  expect(r.status).toBe(0);
  expect(r.json.skillExists).toBe(true);
  expect(r.json.missingTools).toEqual([]);
  fixture(proj);
  put(join(d, "install.sh"), "old\n", 0o755);
  put(join(d, "notes.md"), "keep\n");
  r = detect(proj);
  expect(r.status).toBe(0);
  expect(r.json.missingTools).toEqual(["cargo", "gopls"]);
  r = detect(proj, "--add", "gopls,yarn,docker,node,constructor");
  expect(r.status).toBe(0);
  expect(r.json.added).toEqual(["gopls"]);
  const s = read(join(d, "SKILL.md"));
  expect(s).toContain("install.sh --dry-run node pnpm gopls");
  expect(s).not.toContain("@@");
  expect(same(join(d, "install.sh"), INSTALL_SH)).toBe(true);
  expect(mode(join(d, "install.sh"))).toBe("755");
  expect(read(join(d, "notes.md"))).toBe("keep\n");
  expect(leftovers(proj)).toEqual([]);
  r = detect(proj, "--add", "cargo");
  expect(r.status).toBe(0);
  expect(r.json.added).toEqual(["cargo"]);
  r = detect(proj);
  expect(r.status).toBe(0);
  expect(r.json.missingTools).toEqual([]);
  fixture(fresh);
  r = detect(fresh, "--write");
  expect(r.status).toBe(0);
  expect(r.json.wrote).toBe(true);
  expect(read(join(d, "SKILL.md"))).toBe(read(join(skillDir(fresh), "SKILL.md")));
});

test("--add leaves an unreadable or absent skill untouched", () => {
  const proj = project();
  const d = skillDir(proj);
  const injected = "    bash ${CLAUDE_SKILL_DIR}/install.sh --dry-run node $(id)";
  fixture(proj);
  put(join(d, "SKILL.md"), "hand edit\n");
  let r = detect(proj);
  expect(r.status).toBe(0);
  expect(r.json.skillExists).toBe(true);
  expect(r.json.missingTools).toBeNull();
  r = detect(proj, "--add", "node,cargo");
  expect(r.status).toBe(0);
  expect(r.json.added).toEqual([]);
  expect(read(join(d, "SKILL.md"))).toBe("hand edit\n");
  expect(existsSync(join(d, "install.sh"))).toBe(false);
  writeFileSync(join(d, "SKILL.md"), injected + "\n");
  r = detect(proj);
  expect(r.status).toBe(0);
  expect(r.json.missingTools).toBeNull();
  r = detect(proj, "--add", "node");
  expect(r.status).toBe(0);
  expect(r.json.added).toEqual([]);
  expect(read(join(d, "SKILL.md"))).toBe(injected + "\n");
  rmSync(d, { recursive: true });
  r = detect(proj, "--add", "node");
  expect(r.status).toBe(0);
  expect(r.json.added).toEqual([]);
  expect(r.json.skillExists).toBe(false);
  expect(existsSync(d)).toBe(false);
});

test("--add does not swallow a following flag or project-root path as its id list", () => {
  const proj = project();
  const d = skillDir(proj);
  put(join(proj, "package.json"), "{}\n");
  expect(detect(proj, "--write").status).toBe(0);
  fixture(proj);
  // `--add <root>`: the path stays the project root, the list is empty
  let r = detect("--add", proj);
  expect(r.status).toBe(0);
  expect(r.json.root).toBe(proj);
  expect(r.json.missingTools).toEqual(["pnpm", "cargo", "gopls"]);
  expect(r.json.added).toEqual([]);
  // `<root> --add --write`: --write is still parsed as a flag
  r = detect(proj, "--add", "--write");
  expect(r.status).toBe(0);
  expect(r.json.added).toEqual([]);
  expect(r.json.wrote).toBe(false);
  expect(r.json.skillsDirCreated).toBe(false);
  expect(read(join(d, "SKILL.md")).split("\n")).toContain("    bash ${CLAUDE_SKILL_DIR}/install.sh --dry-run node");
});

test("--add exits 1 on malformed config or a failed replace, leaving the skill untouched and no temp dir", () => {
  const proj = project();
  const d = skillDir(proj);
  put(join(proj, "package.json"), "{}\n");
  expect(detect(proj, "--write").status).toBe(0);
  fixture(proj);
  const before = read(join(d, "SKILL.md"));
  // malformed .mcp.json: detect() throws before any write
  const goodMcp = read(join(proj, ".mcp.json"));
  writeFileSync(join(proj, ".mcp.json"), "{ not valid json");
  let r = detect(proj, "--add", "pnpm");
  expect(r.status).toBe(1);
  expect(r.out).toMatch(/Malformed.*\.mcp\.json/s);
  expect(read(join(d, "SKILL.md"))).toBe(before);
  writeFileSync(join(proj, ".mcp.json"), goodMcp);
  // malformed .lsp.json (non-object) fails the same way
  writeFileSync(join(proj, ".lsp.json"), "[]\n");
  r = detect(proj, "--add", "pnpm");
  expect(r.status).toBe(1);
  expect(r.out).toMatch(/Malformed.*\.lsp\.json/s);
  expect(read(join(d, "SKILL.md"))).toBe(before);
  writeFileSync(join(proj, ".lsp.json"), "{\"gopls\":{\"command\":\"gopls\"}}\n");
  // replace failure: install.sh is swapped first, so a non-empty directory in its place fails the first rename
  // and SKILL.md must stay as it was
  rmSync(join(d, "install.sh"));
  put(join(d, "install.sh/blocker"), "x\n");
  r = detect(proj, "--add", "pnpm");
  expect(r.status).toBe(1);
  expect(r.out).toContain("Failed to update");
  expect(read(join(d, "SKILL.md"))).toBe(before);
  expect(existsSync(join(d, "install.sh/blocker"))).toBe(true);
  expect(leftovers(proj)).toEqual([]);
});

test("SKILL.md.tmpl: frontmatter, model-invocable, inline, no bang-backtick or plugin-root token", () => {
  const t = readPlugin(`${RA}/templates/init-dev-environment/SKILL.md.tmpl`);
  expect(t).toMatch(/^name:\s*init-dev-environment$/m);
  expect(t).toMatch(/^description:/m);
  expect(t).not.toMatch(/^description:.*: /m);
  expect(t).not.toMatch(/^disable-model-invocation:\s*true/m);
  expect(t).not.toMatch(/^context:\s*fork/m);
  expect(t).not.toContain("!`");
  expect(t).not.toContain("CLAUDE_PLUGIN_ROOT");
  for (const s of ["AskUserQuestion", "@@TOOLS@@", "run_in_background"]) expect(t).toContain(s);
});

test("tool-map.json ids each have an install_<id> recipe in install.sh", () => {
  const sh = read(INSTALL_SH);
  const missing = Object.keys(readPluginJson(`${RA}/tool-map.json`)).filter(
    (id) => !new RegExp(`^install_${id.replaceAll("-", "_")}\\(\\)`, "m").test(sh),
  );
  expect(missing).toEqual([]);
});

test("--write with a root dprint config renders the verify step", () => {
  const proj = project();
  put(join(proj, "dprint.json"), "{}\n");
  const { status, json } = detect(proj, "--write");
  expect(status).toBe(0);
  expect(json.wrote).toBe(true);
  const s = read(join(skillDir(proj), "SKILL.md"));
  for (const x of ["install.sh --dry-run dprint", "## 4. Verify dprint", "## 5. Report", "dprint --version && dprint check"]) {
    expect(s).toContain(x);
  }
});

// --- repository-audit tool-detection phase (SKILL.md steps 5-7) ---

test("repository-audit wires the tool-detection phase and the Dev environment report section", () => {
  const toks = [
    "init-dev-environment",
    "detect-tools.reference.md",
    "${CLAUDE_SKILL_DIR}/detect-tools.mjs",
    "--write",
    "--add",
    "skillExists",
    "missingTools",
    "skillsDirCreated",
    "Dev environment",
    "Dev tool",
    "multiSelect: true",
  ];
  expect(toks.filter((t) => !AUDIT.includes(t))).toEqual([]);
  expect(AUDIT.split("\n").length - 1).toBeLessThan(500);
});

test("cc-knowledge README mentions init-dev-environment", () => {
  expect(readPlugin("README.md")).toContain("init-dev-environment");
});
