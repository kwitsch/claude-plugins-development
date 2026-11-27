/**
 * Labelled tasks for the size calibration run. Labels come from the merged diff of the commit in `src`, never from how
 * the text reads: S = one place, at most ~10 files and ~120 lines; M = one plugin, ~10-20 files or up to ~1000 lines;
 * L = one plugin above ~1000 lines, or two plugins; XL = five or more plugins or repository-wide infrastructure.
 * Texts are written as a user would type a `build-task` argument (no size words); `subs` are the `<name> — <focus>`
 * lines the explore script would return.
 */

import type { Size } from "../src/hooks/size.ts";

export type { Size };

export type Item = {
  id: string;
  /** Commit the label was taken from. */
  src: string;
  label: Size;
  text: string;
  subs: string[];
};

const S = (id: string, src: string, text: string, ...subs: string[]): Item => ({ id, src, label: "S", text, subs });
const M = (id: string, src: string, text: string, ...subs: string[]): Item => ({ id, src, label: "M", text, subs });
const L = (id: string, src: string, text: string, ...subs: string[]): Item => ({ id, src, label: "L", text, subs });
const X = (id: string, src: string, text: string, ...subs: string[]): Item => ({ id, src, label: "XL", text, subs });

export const CORPUS: Item[] = [
  S("s01", "d5f0b3d", "universal-lint: markdownlint should be started with --no-globs so file names containing glob characters are not expanded.", "universal-lint — markdownlint invocation in the lint runner"),
  S("s02", "84f9b2f", "The universal-lint hook sometimes loses its input with EAGAIN when stdin is a pipe. Read stdin until EOF instead of a single read.", "universal-lint — hook stdin reading"),
  S("s03", "24fcebc", "universal-lint loads node:crypto at start of every hook process although only the digest needs it. Load it lazily.", "universal-lint — digest helper imports"),
  S("s04", "55c80fc", "gateFinding calls existsSync repeatedly for the same path within one call. Memoize it per call.", "universal-lint — gateFinding path checks"),
  S("s05", "dabc51b", "Fix the label of the Jevfort band button: it should read Jevfort with the check or cross emoji depending on state.", "jevfort — band button label"),
  S("s06", "96c323a", "dprint exposes two MCP tools that only hooks use. Hide them from the model's tool list.", "dprint — MCP server tool registration"),
  S("s07", "3209a51", "Let CI auto-merge every Dependabot update except major version bumps.", "ci — the Dependabot auto-merge workflow"),
  S("s08", "b7bc30f", "The install fence in the rc-enhancement README has no language and trips markdownlint MD040. Mark it as text.", "rc-enhancement — README install section"),
  S("s09", "f8a7b6f", "npm prints notices that end up in the findings of linters run through npx. Keep them out of the findings.", "universal-lint — npx runner output handling"),
  S("s10", "7f8dc11", "Re-check on Claude Code 2.1.321 whether watchPaths is capped, and record the result in the docs.", "universal-lint — watchPaths notes in the wiki"),
  S("s11", "1de244e", "Document how the hook timeout budget is split in universal-lint and close the open task for it.", "universal-lint — timeout documentation and task list"),
  S("s12", "5d2309d", "jev-solver: the triage in solve should apply a minimum size so tiny tasks do not get the full workflow.", "jev-solver — solve skill triage section"),

  M("m01", "a414db5", "universal-lint should skip the JS/TS lint chain when the project has no eslint or oxlint config, instead of running with defaults.", "universal-lint — chain selection for JS/TS", "universal-lint — config discovery", "universal-lint — tests for the chain"),
  M("m02", "5454614", "Use project-local linter binaries (node_modules/.bin) before falling back to npx in universal-lint.", "universal-lint — binary resolution", "universal-lint — runner and tests"),
  M("m03", "26ba277", "Skip stylelint for CSS and SCSS files when the project has no stylelint config, and cover it with tests.", "universal-lint — stylelint step", "universal-lint — config detection"),
  M("m04", "50604c5", "Many FileChanged events start many lints at once. Cap the number of concurrent lints with slot files shared between hook processes.", "universal-lint — FileChanged hook", "universal-lint — a cross-process slot mechanism", "universal-lint — tests"),
  M("m05", "fbc33df", "Run npx's cached bin directly instead of going through npx every time, and refresh the cache daily.", "universal-lint — npx cache lookup", "universal-lint — runner"),
  M("m06", "54fe7a7", "Whole-project checks such as tsc run once per file in a FileChanged burst. Deduplicate them per burst.", "universal-lint — FileChanged burst handling", "universal-lint — whole-project checks", "universal-lint — perf harness and tests"),
  M("m07", "9e388b4", "The lint skill driver should batch its lint runs instead of calling the linter file by file.", "universal-lint — skill driver", "universal-lint — batch runner", "universal-lint — tests"),
  M("m08", "377ef28", "Run oxlint for JS/TS files when the project has an oxlint config, next to the existing eslint support.", "universal-lint — JS/TS chain", "universal-lint — config detection", "universal-lint — tests and fixtures"),
  M("m09", "0f347ae", "Add a stepEffort option to jevfort that estimates the effort of each agent step, off by default.", "jevfort — options and manifest", "jevfort — per-step estimate in the hook", "jevfort — tests"),
  M("m10", "8e34d5a", "jevfort's done check should run on turn.complete because the classic Stop hook is skipped.", "jevfort — turn.complete hook", "jevfort — done check", "jevfort — tests"),
  M("m11", "1d445ee", "Remove the mode selector and the Bash gate from jevfort; they are no longer used.", "jevfort — mode selector and gate", "jevfort — settings and docs", "jevfort — tests"),
  M("m12", "33c4f65", "jevfort: compact the session at the end of a task from 80% context, and force it from 95%.", "jevfort — compaction trigger", "jevfort — context accounting", "jevfort — tests"),

  L("l01", "8f19652", "jevfort: show a cache countdown, summarize with Haiku when compacting, and auto-compact when the context gets full.", "jevfort — cache countdown UI", "jevfort — Haiku compaction", "jevfort — auto-compact trigger", "jevfort — tests and docs"),
  L("l02", "74f4465", "jevfort should estimate turn effort from a calibrated Jev question with measured cut points, and show it as a band.", "jevfort — effort question and cuts", "jevfort — band UI", "jevfort — evaluation data and tests"),
  L("l03", "49daaff", "universal-lint: findings should go to the editing agent, an edit burst is reported once, and a sweep runs at turn end.", "universal-lint — report routing to the agent", "universal-lint — burst aggregation", "universal-lint — turn-end sweep", "universal-lint — tests"),
  L("l04", "52005d0", "universal-lint should also lint files changed outside Write and Edit, reacting to the FileChanged event.", "universal-lint — FileChanged hook", "universal-lint — watch list", "universal-lint — tests and docs"),
  L("l05", "ca6b468", "Port the jev-pilot plugin into this repository as a mod that talks to a JEV_URL endpoint.", "jevfort — new mod entry and hooks", "jevfort — endpoint client", "jevfort — manifest, tests, docs"),
  L("l06", "bdc3c42", "jev-api: route HTTP through a bundled MCP server so requests get a real timeout and can be cancelled.", "jev-api — HTTP transport", "jev-api — new MCP server", "jev-api — build config", "jev-api — tests"),
  L("l07", "e583886", "jev-api: handle oversized states by measuring the token budget and cutting or refusing instead of sending doomed requests.", "jev-api — size estimation", "jev-api — request path", "jev-api — settings and memory docs", "jev-api — tests"),
  L("l08", "85e7caa", "Merge jev-api's tools into a single request tool and remove estimate_effort; jevfort must call the new tool.", "jev-api — tool registration and types", "jevfort — callers of the old tools", "jev-api — tests and docs"),
  L("l09", "b61170b", "jevfort should ask Jev through a jev-api batch call; jev-api gets a batch tool.", "jev-api — batch tool", "jevfort — Jev client", "jev-api — tests"),
  L("l10", "71c5595", "jev-api: add the System One tools noul, choice and score with calibrated answers.", "jev-api — new tools", "jev-api — answer handling", "jev-api — tests and docs"),
  L("l11", "340b8c6", "Refactor jev-api based on a bug hunt: fix the confirmed bugs across the hook modules and add the missing tests.", "jev-api — hook modules", "jev-api — tests", "jev-api — docs"),
  L("l12", "7ad8ac8", "graphmind-helper: setup hooks should run as a mod on the graphmind MCP tools, with an init command and an MCP server.", "graphmind-helper — hooks", "graphmind-helper — MCP server", "graphmind-helper — init command and tests"),

  X("x01", "8b2faa9", "Build every plugin in the repository with tsdown instead of the custom build, and remove the old build mechanism.", "development — old build scripts", "all plugins — build config and manifests", "root — package and vitest config", "ci — build steps"),
  X("x02", "1fc5932", "Introduce one workspace-wide lint and test config on oxc for all packages, replacing the per-plugin configs.", "root — tsconfig, oxlint, vitest", "all plugins — per-plugin configs", "ci — lint jobs", "development — shared test engine"),
  X("x03", "957b12c", "Create a shared source layer for plugins: plan, build mechanism, scope helpers and an MCP core, used by dprint, jev-api, jevfort and the universal plugins.", "development — shared source", "dprint, jev-api, jevfort, universal-format, universal-lint — adopting the layer", "root — workspace config"),
  X("x04", "3e14f6e", "Make package.json the single manifest source of every plugin and generate plugin.json from it.", "root — scripts and workspace", "all plugins — manifests", "development — build and check scripts", "ci — layout check"),
  X("x05", "5eeac42", "Stop committing the plugin/ build output of all plugins; CI and the sync workflow build it.", "all plugins — gitignore and layout", "ci — workflows and scripts", "root — CLAUDE.md and rules"),
  X("x06", "c2d8ebb", "Add a knowledge wiki for the repository and slim every plugin's memory files down to constraints, moving the reasoning into the wiki.", "development — wiki pages and lint", "all plugins — CLAUDE.md and rules", "root — CLAUDE.md", "ci — wiki check"),
  X("x07", "ed7fda3", "Move seven plugins to the tsdown preset, one build config per plugin.", "cc-knowledge, dprint, graphmind-helper, jev-api — build", "jevfort, rc-enhancement, universal-format, universal-lint — build", "root — lockfile and CI"),
  X("x08", "eb6ecae", "jevfort: reduce routing to a boolean, remove model routing, done check, classifier, step measurement and the status line; touches every plugin that referenced them, plus perf and bug-hunt fixes.", "jevfort — hooks and options", "jev-api, jev-solver — consumers", "dprint, graphmind-helper, universal-lint — docs and rules", "ci and root docs"),
  X("x09", "d1859da", "Introduce a tsdown plugin build standard for the repository and convert graphmind-helper to it.", "development — build tooling", "graphmind-helper — build", "root — workspace, tsconfig, dprint", "ci — workflows"),
  X("x10", "db32938", "Move every plugin's docs/ folder into the central wiki and fix the links, CI checks and rules that referenced it.", "development — wiki", "all plugins — docs folders", "ci — checks", "root — CLAUDE.md"),
  X("x11", "9edf8bc", "Migrate the TypeScript sources of jev-api and development/ to .ts and update every plugin's references, lint config and CI.", "jev-api, development — sources", "all other plugins — config references", "root — tsconfig and oxlint", "ci"),
  X("x12", "7ee251e", "Move universal-format to the tsdown preset and delete the old build from the whole repository, including docs and CI.", "universal-format — build", "development — old build removal", "root — workspace and tsconfig", "ci — workflows"),
];
