---
id: F02
title: Format YAML Edits (range answer null no longer means already formatted)
status: done
priority: none
area: dprint/src/mcp/format.mts (formatPre), dprint/src/mcp/lsp.mts (DprintLsp.formatNow)
---

# F02 Format YAML Edits (range answer null no longer means already formatted)

## Status

Done by the F01 change (release dprint 0.8.0): the Edit path asks for whole-document `formatting`, so `null` from a plugin without range support can no longer be mistaken for "no change". Test: "rangeFormatting answering null (yaml plugin) -> Edit still formatted".

## Problem

`dprint-plugin-yaml` 0.6.0 answers `textDocument/rangeFormatting` with `result: null` (never a JSON-RPC error), but the old client only retried whole-document on RpcError. `formatNow` returned null, `changed(F, M)` null, `formatPre` returned `{}`: 100% of YAML Edits (this repo's workflows, dependabot, pnpm-workspace.yaml) landed unformatted. `file_written` then recorded the unformatted digest, so `file_changed` left it alone for the session. For range-capable plugins `null` meant "no change", so the two meanings were indistinguishable client-side (capabilities advertise `documentRangeFormattingProvider` globally).

## Evidence

Real dprint 0.64.3: yaml 50-line dirty file: range -> null, whole -> 126 edits; Edit on dirty a.yaml -> `{}` while Write a.yaml / Edit a.json / Edit a.ts returned `updatedInput`. Edit `runs-on:     ubuntu-24.04   ` in the repo's pr.yml -> `{}` before, formatted `runs-on: ubuntu-24.04` after. A prototype null->whole retry cost +0-4 ms per no-change Edit at <= 500 lines (+90-140 ms at 20k); F01 avoids even that.

## Code locations

- `formatPre` Edit branch (`lsp.format(uri, M)` whole, `changed`)
- `DprintLsp.formatNow` (only `textDocument/formatting`)
- `tests/mcp-server.test.mts`: stub mode `range-null` (rangeFormatting answers null, formatting answers edits), test "rangeFormatting answering null (yaml plugin) -> Edit still formatted", and "Edit whose trim would drop the deleted repeated line -> {}" (also uses `range-null`)

## Approach

Implemented by F01 alone; no separate code. Rejected alternative: in `formatNow` treat a null rangeFormatting as unsupported and retry whole (`.then(r => r ?? whole(), ...)`), costing one extra full-document request on every no-change Edit of range-capable plugins.

## Verification

`pnpm --filter dprint build && pnpm --filter dprint test` (the range-null test fails on pre-0.8.0 code, passes now). Manual: Edit a dirty `.yaml` in a project with the yaml plugin and confirm `updatedInput` is returned.

## Constraints

Edit `src/`, not `plugin/**/*.mjs`; zero-dep node builtins; fail open; TSDoc on every symbol; version bump in `dprint/plugin.json` AND `dprint/package.json`.

## Related

F01 (the fix), F03 (verification skip on top), F10 (whole-document cost).
