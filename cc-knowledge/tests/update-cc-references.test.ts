// Hermetic tests of the development skill update-cc-references (`.claude/skills/update-cc-references/refresh.ts`).
// The skill is dev tooling of this repository, not shipped: the script is spawned from its source path with the cwd
// in a throwaway git repository, on an isolated PATH (node, git, bash, cat, a curl stub and a pnpm stub). No network.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { makeStub, put, REFS, ROOT, tmpDir } from "./support/plugin.ts";

/** The script under test. */
const SCRIPT = join(ROOT, ".claude/skills/update-cc-references/refresh.ts");
/** The source map next to it. */
const SOURCES = JSON.parse(readFileSync(join(ROOT, ".claude/skills/update-cc-references/sources.json"), "utf8")) as {
  refsDir: string;
  targets: Record<string, string[]>;
  files: Record<string, { docs: string[] }>;
};

/** The reference file of the fixture target `memory`. */
const REF_REL = "cc-knowledge/plugin/skills/cc-reference/references/claude-code-memory.reference.md";
/** The manifest source of the fixture plugin. */
const PKG_REL = "cc-knowledge/package.json";
/** The target name `plan` derives for the reference file. */
const NAME = "claude-code-memory";

const REF_TEXT = `# Memory reference

> Harness-optimized. Source: code.claude.com/docs/en/memory, verified 2026-01-01.

| Field | Meaning |
| --- | --- |
| alpha | first row |
| beta | second row, version >= 2.1.100 |
| gamma | third row |
`;

const PKG_TEXT = `{
  "name": "cc-knowledge",
  "version": "1.0.0",
  "description": "Fixture plugin."
}
`;

/** Runs a git command in a directory. */
function git(cwd: string, ...args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout };
}

/** A throwaway repository holding the fixture reference file and manifest, with an isolated PATH. */
function world(opts: { curlBody?: string; curlFail?: boolean; pnpmFail?: boolean } = {}) {
  const dir = tmpDir("ccref-");
  const bin = join(dir, "bin");
  for (const t of ["node", "git", "bash", "cat"]) {
    const found = spawnSync("bash", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
    put(join(bin, ".keep"), "");
    symlinkSync(found, join(bin, t));
  }
  makeStub(bin, "curl", [
    "[ \"${CURL_FAIL:-}\" = 1 ] && exit 22",
    "out=\"\"",
    "while [ \"$#\" -gt 0 ]; do",
    "  if [ \"$1\" = \"-o\" ]; then out=\"$2\"; shift; fi",
    "  shift",
    "done",
    "printf '%s\\n' \"$CURL_BODY\" > \"$out\"",
  ]);
  const pnpmLog = join(dir, "pnpm.log");
  makeStub(bin, "pnpm", [`echo "$PWD :: $*" >> "${pnpmLog}"`, opts.pnpmFail ? "echo build broke >&2; exit 1" : "exit 0"]);
  const repo = join(dir, "repo");
  const ref = join(repo, REF_REL);
  const pkg = join(repo, PKG_REL);
  put(ref, REF_TEXT);
  put(pkg, PKG_TEXT);
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  const scratch = join(dir, "scratch");
  const env = {
    PATH: bin,
    HOME: join(dir, "home"),
    TMPDIR: dir,
    CURL_BODY: opts.curlBody ?? "Memory docs. CLAUDE.md imports load at startup since 2.1.50.",
    CURL_FAIL: opts.curlFail ? "1" : "",
  };
  /** Runs refresh.ts in the fixture repository; stdout is one JSON object. */
  const refresh = (...args: string[]) => {
    const r = spawnSync(join(bin, "node"), [SCRIPT, ...args], { cwd: repo, env, encoding: "utf8" });
    let json: ReturnType<typeof JSON.parse> = null;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      // not JSON: the test asserts on status/stderr
    }
    return { status: r.status, json, stderr: r.stderr };
  };
  /** Replaces text in the reference file. */
  const edit = (from: string, to: string) => writeFileSync(ref, readFileSync(ref, "utf8").replace(from, to));
  /** Appends a line to the reference file. */
  const append = (line: string) => writeFileSync(ref, readFileSync(ref, "utf8") + line + "\n");
  const planDate = () => (JSON.parse(readFileSync(join(scratch, "plan.json"), "utf8")) as { date: string }).date;
  const sameAsHead = () => git(repo, "diff", "--quiet", "HEAD", "--", ref).status === 0;
  return { dir, repo, ref, pkg, scratch, pnpmLog, refresh, edit, append, planDate, sameAsHead, git: (...a: string[]) => git(repo, ...a) };
}

test("sources.json maps every target file to docs and lists only existing reference files", () => {
  expect(SOURCES.refsDir).toBe("cc-knowledge/plugin/skills/cc-reference/references");
  for (const f of Object.values(SOURCES.targets).flat()) {
    expect(existsSync(join(REFS, f)), f).toBe(true);
    expect(SOURCES.files[f]?.docs.length, f).toBeGreaterThan(0);
  }
});

test("plan rejects an unknown target with exit 1", () => {
  const w = world();
  const r = w.refresh("plan", "bogus", w.scratch);
  expect(r.status).toBe(1);
  expect(r.json.ok).toBe(false);
});

test("plan memory fetches docs and writes plan.json plus a filled workflow.js", () => {
  const w = world();
  const r = w.refresh("plan", "memory", w.scratch);
  expect(r.status).toBe(0);
  expect(r.json.ok).toBe(true);
  expect(r.json.workflowScript).toBe(join(w.scratch, "workflow.js"));
  const plan = JSON.parse(readFileSync(join(w.scratch, "plan.json"), "utf8"));
  expect(plan.targets).toHaveLength(1);
  expect(plan.targets[0].name).toBe(NAME);
  expect(plan.targets[0].file).toBe(join(spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: w.repo, encoding: "utf8" }).stdout.trim(), REF_REL));
  expect(readFileSync(plan.targets[0].docs[0].path, "utf8").length).toBeGreaterThan(0);
  expect(plan.date).toBe(new Date().toISOString().slice(0, 10));
  const wf = readFileSync(join(w.scratch, "workflow.js"), "utf8");
  expect(wf).not.toContain("__PLAN__");
  expect(wf).toContain(NAME);
  // the section index the workflow tells the author to keep in sync is the plugin's SKILL.md
  expect(wf).toContain("cc-knowledge/plugin/skills/cc-reference/SKILL.md");
  // The Workflow script body must parse as an async function body (top-level await/return).
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor as new(...a: string[]) => unknown;
  expect(() => new AsyncFunction("agent", "pipeline", "phase", wf.replace(/^export /m, ""))).not.toThrow();
});

test("plan stops with exit 2 on an HTML-contaminated or failed fetch", () => {
  const html = world({ curlBody: "<!DOCTYPE html>" });
  const r = html.refresh("plan", "memory", html.scratch);
  expect(r.status).toBe(2);
  expect(r.json.failed[0]).toBe("https://code.claude.com/docs/en/memory");
  expect(existsSync(join(html.scratch, "plan.json"))).toBe(false);
  const down = world({ curlBody: "fine", curlFail: true });
  expect(down.refresh("plan", "memory", down.scratch).status).toBe(2);
});

test("gate/finish: a pure addition is additive and gets the plan date stamped", () => {
  const w = world();
  w.refresh("plan", "memory", w.scratch);
  w.append("| delta | added row |");
  const g = w.refresh("gate", w.scratch, NAME);
  expect(g.status).toBe(0);
  expect(g.json.changing).toEqual([]);
  expect(g.json.additive).toBe(1);
  expect(g.json.diffPath).toBeNull();
  const f = w.refresh("finish", w.scratch, NAME);
  expect(f.status).toBe(0);
  expect(f.json.status).toBe("updated");
  expect(f.json.stale).toBe(false);
  const text = readFileSync(w.ref, "utf8");
  expect(text).toContain(`verified ${w.planDate()}.`);
  expect(text).toContain("| delta | added row |");
});

test("finish without --keep reverts a line change and restores the file", () => {
  const w = world();
  w.refresh("plan", "memory", w.scratch);
  w.edit("| alpha | first row |", "| alpha | first row changed |");
  const f = w.refresh("finish", w.scratch, NAME);
  expect(f.status).toBe(0);
  expect(f.json.status).toBe("unchanged");
  expect(f.json.reverted).toEqual(["h1"]);
  expect(w.sameAsHead()).toBe(true);
});

test("gate labels a line change h1 and finish --keep h1 keeps it", () => {
  const w = world();
  w.refresh("plan", "memory", w.scratch);
  w.edit("| alpha | first row |", "| alpha | first row changed |");
  const g = w.refresh("gate", w.scratch, NAME);
  expect(g.status).toBe(0);
  expect(g.json.changing).toEqual(["h1"]);
  expect(readFileSync(g.json.diffPath, "utf8")).toMatch(/^@@ .* h1$/m);
  const f = w.refresh("finish", w.scratch, NAME, "--keep", "h1");
  expect(f.status).toBe(0);
  expect(f.json.status).toBe("updated");
  expect(f.json.kept).toEqual(["h1"]);
  const text = readFileSync(w.ref, "utf8");
  expect(text).toContain("| alpha | first row changed |");
  expect(text).toContain(`verified ${w.planDate()}.`);
});

test("gate reverts an added version absent from the docs (v9.9.9)", () => {
  const w = world();
  w.refresh("plan", "memory", w.scratch);
  w.append("| delta | since v9.9.9 |");
  const g = w.refresh("gate", w.scratch, NAME);
  expect(g.status).toBe(0);
  expect(g.json.autoReverted).toHaveLength(1);
  expect(g.json.autoReverted[0].versions).toEqual(["9.9.9"]);
  expect(w.sameAsHead()).toBe(true);
});

test("gate keeps a carried-over version gate that is in the removed line", () => {
  const w = world();
  w.refresh("plan", "memory", w.scratch);
  w.edit("| beta | second row, version >= 2.1.100 |", "| beta | second row edited, version >= 2.1.100 |");
  const g = w.refresh("gate", w.scratch, NAME);
  expect(g.status).toBe(0);
  expect(g.json.autoReverted).toEqual([]);
  expect(g.json.changing).toEqual(["h1"]);
  const f = w.refresh("finish", w.scratch, NAME, "--keep", "h1");
  expect(f.status).toBe(0);
  expect(f.json.status).toBe("updated");
  expect(readFileSync(w.ref, "utf8")).toContain("| beta | second row edited, version >= 2.1.100 |");
});

test("gate reverts a changed version gate absent from docs and removed line", () => {
  const w = world();
  w.refresh("plan", "memory", w.scratch);
  w.edit("| beta | second row, version >= 2.1.100 |", "| beta | second row, version >= 2.1.200 |");
  const g = w.refresh("gate", w.scratch, NAME);
  expect(g.status).toBe(0);
  expect(g.json.autoReverted).toHaveLength(1);
  expect(w.sameAsHead()).toBe(true);
});

test("finish treats a file edited after gate as stale and reverts its line change", () => {
  const w = world();
  w.refresh("plan", "memory", w.scratch);
  w.edit("| alpha | first row |", "| alpha | first row changed |");
  w.refresh("gate", w.scratch, NAME);
  w.append("| delta | added row |");
  const f = w.refresh("finish", w.scratch, NAME, "--keep", "h1");
  expect(f.status).toBe(0);
  expect(f.json.stale).toBe(true);
  expect(f.json.kept).toEqual([]);
  const text = readFileSync(w.ref, "utf8");
  expect(text).not.toContain("first row changed");
  expect(text).toContain("| delta | added row |");
});

test("gate and finish reject an unknown name with exit 1", () => {
  const w = world();
  w.refresh("plan", "memory", w.scratch);
  expect(w.refresh("gate", w.scratch, "no-such-file").status).toBe(1);
  expect(w.refresh("finish", join(w.dir, "no-scratch"), NAME).status).toBe(1);
});

test("release on a clean reference tree reports changed:false and writes nothing", () => {
  const w = world();
  w.refresh("plan", "memory", w.scratch);
  const r = w.refresh("release", w.scratch);
  expect(r.status).toBe(0);
  expect(r.json.changed).toBe(false);
  expect(w.git("diff", "--quiet", "HEAD").status).toBe(0);
  expect(existsSync(w.pnpmLog)).toBe(false);
});

test("release bumps the patch of cc-knowledge/package.json once per branch and rebuilds", () => {
  const w = world();
  w.refresh("plan", "memory", w.scratch);
  w.append("| delta | added row |");
  const r = w.refresh("release", w.scratch);
  expect(r.status).toBe(0);
  expect(r.json).toMatchObject({ changed: true, bumped: true, previousVersion: "1.0.0", version: "1.0.1", built: true });
  expect(JSON.parse(readFileSync(w.pkg, "utf8")).version).toBe("1.0.1");
  // plugin.json is regenerated by the plugin's build, never edited by the script
  expect(readFileSync(w.pnpmLog, "utf8")).toBe(`${spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: w.repo, encoding: "utf8" }).stdout.trim()} :: --filter cc-knowledge build\n`);

  w.git("add", "-A");
  w.git("commit", "-qm", "bump");
  w.append("| epsilon | another row |");
  const again = w.refresh("release", w.scratch);
  expect(again.status).toBe(0);
  expect(again.json.bumped).toBe(false);
  expect(again.json.version).toBe("1.0.1");
  expect(JSON.parse(readFileSync(w.pkg, "utf8")).version).toBe("1.0.1");
});

test("release leaves the description alone (no date stamp any more)", () => {
  const w = world();
  w.refresh("plan", "memory", w.scratch);
  w.append("| delta | added row |");
  expect(w.refresh("release", w.scratch).status).toBe(0);
  expect(JSON.parse(readFileSync(w.pkg, "utf8")).description).toBe("Fixture plugin.");
});

test("release exits 1 when the build fails", () => {
  const w = world({ pnpmFail: true });
  w.refresh("plan", "memory", w.scratch);
  w.append("| delta | added row |");
  const r = w.refresh("release", w.scratch);
  expect(r.status).toBe(1);
  expect(r.json.ok).toBe(false);
});

test("release exits 1 on a malformed version and writes nothing", () => {
  const w = world();
  w.refresh("plan", "memory", w.scratch);
  const bad = "{\n  \"name\": \"cc-knowledge\",\n  \"version\": \"1.0\",\n  \"description\": \"Fixture plugin.\"\n}\n";
  writeFileSync(w.pkg, bad);
  w.append("| delta | added row |");
  const r = w.refresh("release", w.scratch);
  expect(r.status).toBe(1);
  expect(readFileSync(w.pkg, "utf8")).toBe(bad);
  expect(existsSync(w.pnpmLog)).toBe(false);
});
