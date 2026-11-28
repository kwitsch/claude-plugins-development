# dprint performance tasks

Source: performance analysis of the dprint MCP server (findings F01-F28) and the re-evaluation of plugin 0.13.0, re-run on 0.13.2, in [EVALUATION-2026-11-13.md](evaluations/EVALUATION-2026-11-13.md) (current numbers, comparison with the task documents and between the two versions, bug hunt, finding F29). One detail document per task in `tasks/`; read it before working on the task. Release carrying the finished work: dprint 0.8.0 (PR #19); F09, F10, F18, F25, F27 and part of F28: dprint 0.12.1; F04, F12: dprint 0.13.0.

Entry format and sections: `.claude/rules/plugin-docs-tasks.md`; `wiki-check.ts` checks them against the `tasks/` frontmatter.

## Remaining

None.

## Done

- [x] [F01](tasks/F01-edit-range-request-redundant.md) `done` none: Drop the rangeFormatting request from the Edit path
- [x] [F02](tasks/F02-yaml-edit-range-null-skipped.md) `done` none: Format YAML Edits (range answer null no longer means already formatted)
- [x] [F03](tasks/F03-edit-verify-skip-when-trim-lossless.md) `done` none: Skip the Edit verification formats when the trim reproduces dprint's output
- [x] [F04](tasks/F04-lsp-child-rss-high-water.md) `done` medium: Bound dprint lsp child memory for large documents
- [x] [F05](tasks/F05-fc-pending-cap-drops-silently.md) `done` none: FileChanged burst handling without silent drops
- [x] [F06](tasks/F06-fc-two-git-spawns-merge.md) `done` none: One git spawn per FileChanged event
- [x] [F08](tasks/F08-large-unformatted-edit-wasted-formats.md) `done` low: Large not-yet-formatted files make every Edit slow (documented only)
- [x] [F09](tasks/F09-dprint-lsp-heavy-change-cost.md) `done` low: dprint lsp formatting cost scales with the amount of change (dprint-side)
- [x] [F10](tasks/F10-edit-no-change-full-document-format.md) `done` low: Even a no-change TS Edit formats the whole document (dprint-side sizing)
- [x] [F12](tasks/F12-server-rss-growth-inflates-spawn-cost.md) `done` low: Bound MCP server RSS growth from multi-MB payloads
- [x] [F13](tasks/F13-fc-burst-saturates-loop.md) `done` none: Bound FileChanged burst load on the MCP server event loop
- [x] [F14](tasks/F14-lsp-timeout-no-backoff-offline-plugin.md) `done` none: Back off after an lsp request timeout
- [x] [F15](tasks/F15-find-dprint-missing-wsl-path-rescan.md) `done` none: Negative cache for a missing dprint binary
- [x] [F16](tasks/F16-lineof-quadratic-replace-all.md) `done` none: One-pass line counter for replace_all offsets
- [x] [F17](tasks/F17-trim-widening-quadratic.md) `done` none: Cap trimToEdit uniqueness widening
- [x] [F18](tasks/F18-lsp-ondata-quadratic-concat.md) `done` low: Linear frame accumulation in DprintLsp.onData
- [x] [F19](tasks/F19-stale-stdout-after-dispose-race.md) `done` none: Ignore stdout of a replaced dprint child
- [x] [F24](tasks/F24-watch-list-static-per-file.md) `done` medium: Make the FileChanged watch list survive new files and git checkout
- [x] [F25](tasks/F25-watch-paths-sessionstart-cost.md) `done` low: Cut watch-paths SessionStart/CwdChanged cost on large repos
- [x] [F27](tasks/F27-stat-heavy-guards-on-9p.md) `done` low: Cache findConfig results to cut stat latency on 9P repos
- [x] [F28](tasks/F28-tests-miss-perf-paths.md) `done` low: Test the performance-relevant server paths
- [x] [F29](tasks/F29-bash-finished-stat-scan.md) `done` low: Bound the per-Bash watch-list mtime scan in bash_finished
- [x] [F30](tasks/F30-skip-git-operation-changes.md) `done` medium: Skip files changed by git operations in FileChanged and bash_finished

## Closed without code

- [x] [F07](tasks/F07-format-pre-git-check-ignore-serial.md) `closed` low: Overlap or drop the git check-ignore spawn in formatPre
- [x] [F11](tasks/F11-lsp-mutex-serializes-second-child.md) `closed` none: Do not replace the per-client format queue or the second file_changed child
- [x] [F20](tasks/F20-unhandled-stream-error-exits-server.md) `closed` none: Optional no-op error listeners on server stdout/stderr
- [x] [F21](tasks/F21-file-written-hook-fold-into-format-pre.md) `closed` low: Evaluate folding the file_written hook into format_pre
- [x] [F22](tasks/F22-per-write-hook-overhead-breakdown.md) `closed` none: Per-Write/Edit hook overhead breakdown (measurement baseline)
- [x] [F23](tasks/F23-cc-side-gap-after-updated-input.md) `closed` none: Re-verify the apparent Claude-side gap after format_pre updatedInput
- [x] [F26](tasks/F26-watch-paths-stdout-size-cap.md) `closed` none: Check whether Claude Code's hook stdout cap truncates huge watchPaths JSON

## Notes

- F24 is done as an opt-in (`DPRINT_WATCH_DIRECTORIES=1`, live-validated); the default stays on files because directory watches deliver every event below them.
- Finding ids match the headings of the original analysis; file names are `<id>-<slug>.md`.
