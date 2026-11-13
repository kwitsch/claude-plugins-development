# dprint performance tasks

Source: performance analysis of the dprint MCP server (findings F01-F28). One detail document per task in `tasks/`; read it before working on the task. Release carrying the finished work: dprint 0.8.0 (PR #19); F09, F10, F18, F25, F27 and part of F28: dprint 0.12.1; F04, F12: dprint 0.13.0.

Legend: `[x]` finished (done, or closed without code: status `closed` in the task document). `[ ]` not finished; tag = `open` (not started), `partial` (some of it shipped, remainder described in the task), `docs-only` (no code change intended; the remaining action is a documentation sentence).

## Done

- [x] [F01](tasks/F01-edit-range-request-redundant.md) Drop the rangeFormatting request from the Edit path
- [x] [F02](tasks/F02-yaml-edit-range-null-skipped.md) Format YAML Edits (range answer null no longer means already formatted)
- [x] [F03](tasks/F03-edit-verify-skip-when-trim-lossless.md) Skip the Edit verification formats when the trim reproduces dprint's output
- [x] [F05](tasks/F05-fc-pending-cap-drops-silently.md) FileChanged burst handling without silent drops
- [x] [F06](tasks/F06-fc-two-git-spawns-merge.md) One git spawn per FileChanged event
- [x] [F08](tasks/F08-large-unformatted-edit-wasted-formats.md) Large not-yet-formatted files make every Edit slow (documented only)
- [x] [F13](tasks/F13-fc-burst-saturates-loop.md) Bound FileChanged burst load on the MCP server event loop
- [x] [F14](tasks/F14-lsp-timeout-no-backoff-offline-plugin.md) Back off after an lsp request timeout
- [x] [F15](tasks/F15-find-dprint-missing-wsl-path-rescan.md) Negative cache for a missing dprint binary
- [x] [F16](tasks/F16-lineof-quadratic-replace-all.md) One-pass line counter for replace_all offsets
- [x] [F17](tasks/F17-trim-widening-quadratic.md) Cap trimToEdit uniqueness widening
- [x] [F19](tasks/F19-stale-stdout-after-dispose-race.md) Ignore stdout of a replaced dprint child
- [x] [F18](tasks/F18-lsp-ondata-quadratic-concat.md) Linear frame accumulation in DprintLsp.onData `open` priority:low
- [x] [F25](tasks/F25-watch-paths-sessionstart-cost.md) Cut watch-paths SessionStart/CwdChanged cost on large repos `open` priority:low
- [x] [F27](tasks/F27-stat-heavy-guards-on-9p.md) Cache findConfig results to cut stat latency on 9P repos `open` priority:low
- [x] [F09](tasks/F09-dprint-lsp-heavy-change-cost.md) dprint lsp formatting cost scales with the amount of change (dprint-side) `docs-only` priority:low
- [x] [F10](tasks/F10-edit-no-change-full-document-format.md) Even a no-change TS Edit formats the whole document (dprint-side sizing) `docs-only` priority:low
- [x] [F04](tasks/F04-lsp-child-rss-high-water.md) Bound dprint lsp child memory for large documents
- [x] [F12](tasks/F12-server-rss-growth-inflates-spawn-cost.md) Bound MCP server RSS growth from multi-MB payloads

## Remaining

- [ ] [F24](tasks/F24-watch-list-static-per-file.md) Make the FileChanged watch list survive new files and git checkout `open` priority:high
- [ ] [F28](tasks/F28-tests-miss-perf-paths.md) Test the performance-relevant server paths `partial` priority:low

## Closed without code (decided 2026-11-13: not worth doing, or measurement record)

- [x] [F07](tasks/F07-format-pre-git-check-ignore-serial.md) Overlap or drop the git check-ignore spawn in formatPre
- [x] [F11](tasks/F11-lsp-mutex-serializes-second-child.md) Do not replace the per-client format queue or the second file_changed child
- [x] [F20](tasks/F20-unhandled-stream-error-exits-server.md) Optional no-op error listeners on server stdout/stderr
- [x] [F21](tasks/F21-file-written-hook-fold-into-format-pre.md) Evaluate folding the file_written hook into format_pre
- [x] [F22](tasks/F22-per-write-hook-overhead-breakdown.md) Per-Write/Edit hook overhead breakdown (measurement baseline)
- [x] [F23](tasks/F23-cc-side-gap-after-updated-input.md) Re-verify the apparent Claude-side gap after format_pre updatedInput
- [x] [F26](tasks/F26-watch-paths-stdout-size-cap.md) Check whether Claude Code's hook stdout cap truncates huge watchPaths JSON

## Notes

- F24 stays open: it needs a live Claude Code prototype (see its Status).
- Finding ids match the headings of the original analysis; file names are `<id>-<slug>.md`.
