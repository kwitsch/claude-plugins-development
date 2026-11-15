# Log

Append-only; newest entry last. One entry per ingest or lint pass (`grep '^## \[' log.md` lists them).

## [2026-11-15] ingest | First fill from the machine-local memory

Source: the 217 entries of the graphmind project memory and the 8 auto-memory files, written by sessions between 2026-10-31 and 2026-11-15, plus this day's work on universal-lint F40. Every entry was treated as a claim; nothing was copied unchecked.

- **Cross-plugin knowledge** went into the pages of this wiki: nine `facts/` pages, `decisions/repo-tooling.md`, three `methods/` pages, two `pitfalls/` pages. Facts keep the stamp of how they were established at the time (live, binary read, typings, docs); they were not re-verified in this pass, except where noted below.
- **Plugin-specific notes** were checked against each plugin's current code and documents and, where still true and not yet written down, added to that plugin's own files:
  - jev-api (45 notes): 18 already documented, 4 added (`jev-api/CLAUDE.md`, `hooks-source.md`, `http-mcp-server.md`), 2 outdated, 21 general.
  - jevfort (53): 17 already documented, 6 added (a "Standing user decisions" section in `jevfort/CLAUDE.md`; `effort-routing.md`, `cache-compact.md`, `register-hooks.md`), 8 outdated, 22 general.
  - universal-lint (54): 35 already documented, 2 added (`hook-design.md`), 11 outdated, 4 general, 2 left open.
  - dprint and inline-headroom (31): 12 already documented, 4 added (`dprint/CLAUDE.md`, dprint `mcp-server.md`, inline-headroom `register-hooks.md`), 4 outdated, 11 general.
- **Not filed:** personal preferences of the user and facts about one machine's environment (they stay in the machine-local memory); notes about the marketplace repository's own files; claims nobody could verify.
- **Re-verified live in this pass** (2.1.325, headless): the working directory a hook sees in a session started from a symlinked directory. The older note was right (the payload carries the real path), the rule `hook-file-safety.md` was wrong on that point and was corrected.
- **Corrected while filing:** `universal-lint/docs/design/hook-design.md` said findings appear in transcripts as `hook_blocking_error` attachments; that holds for headless runs only.
- **Found and left open** (outside the scope of an ingest, reported to the user):
  - `jev-api`: `logOutage` passes `$.ui.log` a text that starts with the plugin name, which the engine adds as well; not verified live.
  - `universal-lint/docs/README.md` says to move a finished task to the "Done" section of `TASKS.md`; `TASKS.md` closes tasks in place. The same file and the `TASKS.md` notes still say "F01-F39".
  - `inline-headroom`: README and `policy-dedup-elider.md` say a compaction empties the dedup corpus; the `session.compact` hook that does it is bypassed on 2.1.325.
  - `dprint/tests/mcp-format.test.ts` leaves one temp directory behind; dprint `skill-scripts.md` lists `README.md` under `paths:`, which matches nothing.
  - `jevfort/docs/TASKS.md` cites a known limit that no longer exists.

## [2026-11-15] ingest | Memory files slimmed to constraints: root rules and universal-lint

Source: a measurement of on-demand memory loads in the transcripts of ten days and the user's decision of the same day (`decisions/repo-tooling.md`, "Memory files hold constraints only").

- **Moved into the wiki:** the rule `shell-port-pitfalls.md` as `pitfalls/porting-shell-to-node.md`; the protocol detail of `mcp-dual-era.md` as `facts/mcp-protocol-eras.md`; the explanations and evidence of `claude-code-hook-facts.md` into the four `facts/mods-engine-*.md` pages. The rules keep the constraints and link to the pages.
- **Paths narrowed:** `lint-config.md` (config files only), `src-typescript.md` (`.mts` files and the conversion skill), `hook-file-safety.md` (no tests), `mcp-dual-era.md` (no `hooks.json`). Build-script notes moved from `plugin-src.md` and `hooks-lib-bundle.md` to `development/CLAUDE.md`.
- **universal-lint:** its 13 hook rule files moved unchanged (frontmatter removed) to `universal-lint/docs/design/`; the new rule `universal-lint/.claude/rules/lint-file.md` holds the constraints per area and names each design page. References in 28 markdown files were repointed.
- **Check:** `wiki-check.ts` now also fails on a dead relative link in any `CLAUDE.md` or rule file.
- **Left open:** comments in `universal-lint/src/` still name the design pages as `.claude/rules/<name>.md` (a comment-only source change would force a release); the other plugins' rule files are not slimmed yet.
