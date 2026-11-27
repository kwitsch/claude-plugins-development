/**
 * Held-out tasks, written after the tuning set (`corpus.ts`) had produced its first results and never used to choose a
 * wording. Same label rule as `corpus.ts`; `src: "synthetic"` marks tasks that are cross-cutting by definition.
 */

import type { Item } from "./size-calibration-corpus.ts";

const t = (label: Item["label"], id: string, src: string, text: string, ...subs: string[]): Item => ({ id, src, label, text, subs });

export const TEST: Item[] = [
  t("S", "ts1", "28a021a", "Add a test that a 2 MiB hook output is handled, and anchor the LOC_PATH_RE regex at the line start.", "universal-lint — LOC_PATH_RE and its tests"),
  t("S", "ts2", "a1201d2", "Document the WSL PATH pitfall for universal-lint in its docs.", "universal-lint — docs"),
  t("S", "ts3", "beb3fbe", "Close the open task F22 in universal-lint as docs-only and bump the version to 0.15.19.", "universal-lint — task list and version"),
  t("S", "ts4", "4aa2cd1", "Write down the cost model for Go and Rust linters in universal-lint's docs and close task F30.", "universal-lint — docs and task list"),
  t("S", "ts5", "0991640", "Measure how often the FileChanged echo race loses an event, record the numbers in the docs and close F32 without code.", "universal-lint — measurement notes"),
  t("S", "ts6", "synthetic", "Change the default timeout of the jev-api request tool from 30 to 20 seconds.", "jev-api — default timeout constant"),
  t("S", "ts7", "synthetic", "Fix a typo in the README of dprint: 'formater' should read 'formatter'.", "dprint — README"),
  t("S", "ts8", "synthetic", "Die Beschreibung im Frontmatter des changes-audit Skills enthält einen Tippfehler. Korrigiere ihn.", "taskflow — changes-audit SKILL.md frontmatter"),

  t("M", "tm1", "f26fd91", "Make the watch-list scope check in universal-lint cheaper: it runs on every FileChanged event and rescans.", "universal-lint — watch-list scope check", "universal-lint — tests"),
  t("M", "tm2", "893db6d", "universal-lint should persist the results of its onPath probes across hook processes instead of probing again in each one.", "universal-lint — onPath probe", "universal-lint — a small on-disk cache", "universal-lint — tests"),
  t("M", "tm3", "7ffa868", "In config walks under /mnt/ universal-lint does a stat per file. Do one readdir per directory instead.", "universal-lint — config walk", "universal-lint — tests"),
  t("M", "tm4", "e8a1886", "jevfort should re-check with jev-api on every turn and show an effort band for the result.", "jevfort — per-turn re-check", "jevfort — band UI", "jevfort — tests"),
  t("M", "tm5", "a5b4940", "jevfort's gate should only deny and allow writes to the session scratchpad.", "jevfort — gate hook", "jevfort — scratchpad path check", "jevfort — tests"),
  t("M", "tm6", "4a22a3d", "Calibrate jevfort's step effort estimate: a better question and new cut points, and turn step scoring off during a Jev outage.", "jevfort — step effort question and cuts", "jevfort — outage handling", "jevfort — tests"),
  t("M", "tm7", "aa263de", "dprint's MCP server should speak both protocol eras, 2025-11-25 initialize and 2026-07-28 server/discover.", "dprint — MCP server handshake", "dprint — tests", "repo — a rule file for dual-era servers"),
  t("M", "tm8", "synthetic", "Add a --dry-run option to the dprint skill's fmt action that lists the files it would change.", "dprint — skill script", "dprint — SKILL.md and tests"),

  t("L", "tl1", "8b4b580", "jevfort should estimate the effort of every turn with a new estimate_effort tool and use it to set the thinking effort.", "jevfort — the tool", "jevfort — turn hook using the estimate", "jevfort — settings and docs", "jevfort — tests"),
  t("L", "tl2", "29aee38", "Port the universal-lint plugin from the claude-plugins repository into this one with its tests and docs.", "universal-lint — sources, tests, hooks", "universal-lint — manifest and docs", "root — workspace registration"),
  t("L", "tl3", "8b4eb15", "universal-lint: add a settle window before reports, write the performance task list and run a bug hunt over the plugin.", "universal-lint — settle logic", "universal-lint — task list and docs", "universal-lint — bug fixes across the hook modules"),
  t("L", "tl4", "aeec1bf", "jevfort: write a performance task list of seven jobs and fix the bugs a hunt finds across the plugin.", "jevfort — hooks", "jevfort — UI modules", "jevfort — task list and docs", "jevfort — tests"),
  t("L", "tl5", "d1cf4ff", "Analyse the performance of jev-api and jevfort and apply the hardening it calls for in both.", "jev-api — request path", "jevfort — hooks", "both — tests", "both — docs"),
  t("L", "tl6", "618138e", "Migrate the cc-knowledge plugin into this repository with its skills, agents, reference files and tests.", "cc-knowledge — skills and agents", "cc-knowledge — reference data", "cc-knowledge — build and tests"),
  t("L", "tl7", "e2b855d", "Migrate universal-format into this repository, including its wasm assets, MCP server and tests.", "universal-format — MCP server", "universal-format — wasm bundles", "universal-format — tests and docs"),
  t("L", "tl8", "synthetic", "Give taskflow a new resume mode: persist the state of every build-task stage, add a resume script, handle stale state, and cover it with tests and docs.", "taskflow — state persistence in the scripts", "taskflow — resume script", "taskflow — skill and docs", "taskflow — tests"),

  t("XL", "tx1", "f171f6c", "Replace the command hooks of universal-lint with a mod and an MCP server, and adapt dprint, graphmind-helper and universal-format to the shared pieces this needs.", "universal-lint — mod and server", "dprint, graphmind-helper, universal-format — shared pieces", "development — shared source", "root and CI — config"),
  t("XL", "tx2", "synthetic", "Switch every plugin in the repository to the Node 28 target and update the build preset, CI images and docs accordingly.", "all plugins — build target", "ci — images", "root — engines and docs"),
  t("XL", "tx3", "synthetic", "Migrate the tests of all plugins from vitest to node:test, including the shared test kit and the CI jobs.", "development — the test kit", "all plugins — tests", "ci — jobs", "root — config"),
  t("XL", "tx4", "synthetic", "Add a license header check and fixer for all source files of all plugins, wired into lint, CI and the scaffold skill.", "all plugins — sources", "root — lint config", "ci — checks", "development — scaffold skill"),
  t("XL", "tx5", "synthetic", "Introduce a root-level release pipeline that versions and tags all plugins together, replacing the per-plugin bump rules.", "ci — release workflows", "all plugins — manifests", "root — scripts and docs"),
  t("XL", "tx6", "synthetic", "Alle Plugins sollen ein gemeinsames Logging bekommen: ein zentrales Modul in development/shared, Anbindung in jedem Plugin, Tests und Dokumentation.", "development — shared logging module", "all plugins — adoption", "root — docs and lint rules"),
  t("XL", "tx7", "synthetic", "Move the repository from pnpm workspaces to a different monorepo tool, touching every plugin's scripts, the CI and the docs.", "root — workspace and tooling", "all plugins — package scripts", "ci — workflows", "development — scripts"),
  t("XL", "tx8", "synthetic", "Rework how every plugin reads its configuration: one shared schema, validation at startup, and migration of every plugin's options.", "development — shared schema", "all plugins — options handling", "all plugins — tests and docs"),
];
