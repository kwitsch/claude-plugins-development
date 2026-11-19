// Structural checks of the built cc-knowledge plugin: manifest, the cc-reference skill and its reference files, the
// three agents, the cc-review / cc-author / memory-audit skills, README rows. Ported from the first part of the old
// bats suite; line matches there ran over the whole file, so the regexes here use the `m` flag on the whole text.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PKG, PLUGIN, readPlugin, readPluginJson, REFS, SKILL } from "./support/plugin.ts";

const skillMd = (name: string): string => readPlugin(`skills/${name}/SKILL.md`);
const agentMd = (name: string): string => readPlugin(`agents/${name}.md`);

describe("manifest", () => {
  const manifest = readPluginJson(".claude-plugin/plugin.json");
  const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));

  test("plugin.json is valid JSON with name cc-knowledge", () => {
    expect(manifest.name).toBe("cc-knowledge");
  });

  // Merges the bats "declares a version", "version was bumped" and "semver triple" cases: no number is pinned, the
  // release script edits it.
  test("version is semver in package.json and plugin.json carries the same", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.version).toBe(pkg.version);
  });

  // Replaces the "description mentions X" cases: the description is one short sentence by the repo rule.
  test("description is one short sentence starting with a verb, same in package.json", () => {
    const d: string = manifest.description;
    expect(d.length).toBeLessThanOrEqual(200);
    expect(d).toMatch(/^[A-Z][a-z]+s\s/);
    expect(d.replace(/\.$/, "")).not.toMatch(/[.!?]\s/);
    expect(manifest.description).toBe(pkg.description);
  });
});

describe("cc-reference skill", () => {
  const md = skillMd("cc-reference");

  test("SKILL.md exists", () => {
    expect(existsSync(join(SKILL, "SKILL.md"))).toBe(true);
  });

  test("SKILL.md has name and description frontmatter", () => {
    expect(md).toMatch(/^name:\s*cc-reference/m);
    expect(md).toMatch(/^description:/m);
  });

  test("allowed-tools includes Read, Grep, and WebFetch fallback", () => {
    for (const t of ["Read", "Grep", "WebFetch"]) expect(md).toMatch(new RegExp(`^allowed-tools:.*${t}`, "m"));
  });

  test("documents a live-doc fallback", () => {
    expect(md).toMatch(/Live-doc|WebFetch/i);
  });

  test("is model-invocable (no disable-model-invocation)", () => {
    expect(md).not.toMatch(/^disable-model-invocation:\s*true/m);
  });

  test("has no executable !-injection trigger", () => {
    // `!` + backtick runs at skill load; such examples belong only in the reference files.
    expect(md).not.toMatch(/!`/);
  });

  test("reference files live in the references/ subfolder, not the skill root", () => {
    expect(statSync(REFS).isDirectory()).toBe(true);
    const stray = readdirSync(SKILL).filter((f) => f.endsWith(".md") && f !== "SKILL.md");
    expect(stray).toEqual([]);
  });

  test("skill has no context-mode reference", () => {
    expect(md).not.toContain("context-mode");
  });

  test("points reference paths at the references/ subfolder", () => {
    expect(md).toContain("${CLAUDE_SKILL_DIR}/references/claude-code-skills.reference.md");
  });
});

describe("reference files", () => {
  const refFiles = [
    "claude-code-skills.reference.md",
    "claude-code-agents.reference.md",
    "claude-code-hooks.reference.md",
    "hook-handler-selection.reference.md",
    "claude-code-mcp-tool-hooks.reference.md",
    "claude-code-commands.reference.md",
    "claude-code-mcp.reference.md",
    "claude-code-mcp-managed.reference.md",
    "claude-code-plugins.reference.md",
    "claude-code-plugins-lsp.reference.md",
    "claude-code-plugins-marketplace.reference.md",
    "claude-code-memory.reference.md",
    "claude-code-settings.reference.md",
  ];
  const index = skillMd("cc-reference");
  const ref = (f: string): string => readPlugin(`skills/cc-reference/references/${f}`);

  for (const f of refFiles) {
    test(`${f} exists and is non-empty`, () => {
      expect(statSync(join(REFS, f)).size).toBeGreaterThan(0);
    });
    test(`${f} has at least one '## ' heading`, () => {
      expect(ref(f)).toMatch(/^## /m);
    });
    test(`${f} header carries a verified date`, () => {
      expect(ref(f)).toMatch(/verified/i);
    });
    test(`SKILL.md routing/section index names ${f}`, () => {
      expect(index).toContain(f);
    });
  }

  test("mcp-tool-hooks reference documents the plugin server-name namespacing gotcha", () => {
    const t = ref("claude-code-mcp-tool-hooks.reference.md");
    expect(t).toContain("plugin:<plugin-name>:<server-key>");
    expect(t).toMatch(/not connected/i);
  });

  test("skill-folder-structure convention file exists and documents the references/ rule", () => {
    const t = ref("skill-folder-structure.reference.md");
    expect(t).toMatch(/^## /m);
    expect(t).toContain("references/");
    expect(index).toContain("skill-folder-structure.reference.md");
  });
});

describe("agents", () => {
  const noWrite = /^tools:.*(Write|Edit|NotebookEdit|Bash)/m;
  const rows = [
    { name: "claude-code-expert", model: /^model:/m, tools: ["Skill", "Read", "Grep"] },
    { name: "cc-reviewer", model: /^model:\s*haiku/m, tools: ["Skill", "Read", "Grep", "Glob"] },
    { name: "cc-author-planner", model: /^model:\s*haiku/m, tools: ["Skill", "Read", "Grep"] },
  ];

  for (const c of rows) {
    const md = agentMd(c.name);
    test(`${c.name} agent has name and description`, () => {
      expect(md).toMatch(new RegExp(`^name:\\s*${c.name}`, "m"));
      expect(md).toMatch(/^description:/m);
    });
    test(`${c.name} declares a model and cc-reference tools (${c.tools.join(", ")})`, () => {
      expect(md).toMatch(c.model);
      for (const t of c.tools) expect(md).toMatch(new RegExp(`^tools:.*${t}`, "m"));
    });
    test(`${c.name} has no write or Bash tools`, () => {
      expect(md).not.toMatch(noWrite);
    });
  }

  for (const name of ["cc-reviewer", "cc-author-planner"]) {
    test(`${name} is cc-reference-only and never answers from training memory`, () => {
      const md = agentMd(name);
      expect(md).toContain("cc-reference");
      expect(md).toMatch(/never.*training memory|not.*training memory/i);
    });
  }

  test("cc-reviewer documents the structured findings output contract", () => {
    const md = agentMd("cc-reviewer");
    expect(md).toMatch(/suggested_fix/i);
    expect(md).toMatch(/severity/i);
  });

  test("cc-author-planner documents the structured output contract (files + uncovered)", () => {
    const md = agentMd("cc-author-planner");
    expect(md).toContain("full_content");
    expect(md).toContain("uncovered");
  });

  for (const name of ["claude-code-expert", "cc-author-planner", "cc-reviewer"]) {
    test(`${name} agent has no context-mode reference`, () => {
      expect(agentMd(name)).not.toContain("context-mode");
    });
  }
});

describe("cc-review skill", () => {
  const md = skillMd("cc-review");

  test("SKILL.md exists", () => {
    expect(existsSync(join(PLUGIN, "skills/cc-review/SKILL.md"))).toBe(true);
  });
  test("SKILL.md has name and argument-hint frontmatter", () => {
    expect(md).toMatch(/^name:\s*cc-review/m);
    expect(md).toMatch(/^argument-hint:/m);
  });
  test("runs inline (not context: fork, needs Agent + Edit/Write)", () => {
    expect(md).not.toMatch(/^context:\s*fork/m);
  });
  test("dispatches the cc-reviewer agent", () => {
    expect(md).toContain("cc-reviewer");
  });
  test("gates application through AskUserQuestion", () => {
    expect(md).toContain("AskUserQuestion");
  });
  test("detection is runtime Bash, not a load-time !-injection", () => {
    expect(md).not.toMatch(/!`/);
  });
  test("skill has no context-mode reference", () => {
    expect(md).not.toContain("context-mode");
  });
});

describe("cc-author skill", () => {
  const md = skillMd("cc-author");

  test("SKILL.md exists", () => {
    expect(existsSync(join(PLUGIN, "skills/cc-author/SKILL.md"))).toBe(true);
  });
  test("SKILL.md has name and argument-hint frontmatter", () => {
    expect(md).toMatch(/^name:\s*cc-author/m);
    expect(md).toMatch(/^argument-hint:/m);
  });
  test("runs inline (not context: fork, needs Agent + Write)", () => {
    expect(md).not.toMatch(/^context:\s*fork/m);
  });
  test("allowed-tools include Agent, Write, AskUserQuestion", () => {
    for (const t of ["Agent", "Write", "AskUserQuestion"]) expect(md).toMatch(new RegExp(`^allowed-tools:.*${t}`, "m"));
  });
  test("dispatches the cc-author-planner agent", () => {
    expect(md).toContain("cc-author-planner");
  });
  test("surfaces uncovered points and gates via AskUserQuestion", () => {
    expect(md).toContain("uncovered");
    expect(md).toContain("AskUserQuestion");
  });
  test("is model-invocable (no disable-model-invocation)", () => {
    expect(md).not.toMatch(/^disable-model-invocation:\s*true/m);
  });
  test("has no load-time !-injection trigger", () => {
    expect(md).not.toMatch(/!`/);
  });
  test("is cc-reference-grounded", () => {
    expect(md).toContain("cc-reference");
  });
});

describe("memory-audit skill", () => {
  const md = skillMd("memory-audit");
  const wf = readPlugin("skills/memory-audit/analysis-workflow.reference.md");

  test("SKILL.md exists", () => {
    expect(existsSync(join(PLUGIN, "skills/memory-audit/SKILL.md"))).toBe(true);
  });
  test("SKILL.md has name and argument-hint frontmatter", () => {
    expect(md).toMatch(/^name:\s*memory-audit/m);
    expect(md).toMatch(/^argument-hint:/m);
  });
  test("runs inline (not context: fork)", () => {
    expect(md).not.toMatch(/^context:\s*fork/m);
  });
  test("reuses cc-reviewer with component_type memory", () => {
    expect(md).toContain("cc-reviewer");
    expect(md).toMatch(/component_type:\s*memory/);
  });
  test("SKILL.md points at analysis-workflow.reference.md", () => {
    expect(md).toContain("${CLAUDE_SKILL_DIR}/analysis-workflow.reference.md");
  });
  test("gates application through AskUserQuestion", () => {
    expect(md).toContain("AskUserQuestion");
  });
  test("discovery is runtime Bash, not load-time !-injection", () => {
    expect(md).not.toMatch(/!`/);
  });
  test("is model-invocable (no disable-model-invocation)", () => {
    expect(md).not.toMatch(/^disable-model-invocation:\s*true/m);
  });
  test("is cc-reference-grounded", () => {
    expect(md).toContain("cc-reference");
  });
  test("argument-hint carries --fix", () => {
    expect(md).toContain("argument-hint: [--fix]");
  });
  test("--fix branch is additive (auto-apply branch coexists with AskUserQuestion)", () => {
    for (const s of ["--fix", "$FIX", "AskUserQuestion"]) expect(md).toContain(s);
  });
  test("eligibility predicate survives in SKILL.md gate/apply prose", () => {
    expect(md).toContain("uncovered: false");
    expect(md).toContain("suggested_fix");
  });
  test("analysis-workflow dispatch prompt asks reviewer for leanness/split findings", () => {
    for (const s of ["leanness", "splittab", ".claude/rules/", "uncovered: false"]) expect(wf).toContain(s);
    expect(wf).toMatch(/\bpaths:/);
    expect(wf.toLowerCase()).toContain("never `high`");
  });
  test("report has claude-md-improver-style summary + per-file blocks", () => {
    expect(md).toContain("### Summary");
    expect(md).toContain("Recommended actions");
    expect(md.toLowerCase()).toContain("files needing update");
  });
  test("default scope discovers CLAUDE.md and .claude/rules files", () => {
    expect(md).toContain("name CLAUDE.md -o -path '*/.claude/rules/*.md'");
    expect(md).toContain(".claude/rules/*.md");
  });
  test("skill has no context-mode reference", () => {
    expect(md).not.toContain("context-mode");
  });

  test("analysis-workflow.reference.md exists and is non-empty", () => {
    expect(statSync(join(PLUGIN, "skills/memory-audit/analysis-workflow.reference.md")).size).toBeGreaterThan(0);
  });
  test("analysis-workflow defines the Workflow script (Analyze + Aggregate phases, schemas, computeGrade backfill)", () => {
    for (const s of ["phase('Analyze')", "phase('Aggregate')", "FINDINGS_SCHEMA", "AGGREGATE_SCHEMA", "computeGrade"]) {
      expect(wf).toContain(s);
    }
    expect(wf.toLowerCase()).toContain("agent-tool fallback");
  });
  test("analysis-workflow pins both agent() call sites to sonnet", () => {
    expect(wf).toContain("schema: FINDINGS_SCHEMA, model: 'sonnet'");
    expect(wf).toContain("schema: AGGREGATE_SCHEMA, model: 'sonnet'");
  });
  test("analysis-workflow backfill keeps manual to-dos and computes summary in code", () => {
    for (
      const s of [
        "recommendedActions: covered.map(f => f.recommendation)",
        "const filesNeedingUpdate =",
        "const filesFailed =",
        "label: 'aggregate:retry'",
      ]
    ) expect(wf).toContain(s);
  });
});

describe("README", () => {
  const readme = readPlugin("README.md");
  for (const s of ["memory-audit", "cc-compress"]) {
    test(`README lists ${s} in the Skills table`, () => {
      expect(readme).toContain(`\`${s}\``);
    });
  }
});
