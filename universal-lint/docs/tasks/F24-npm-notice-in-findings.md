---
id: F24
title: Keep npm notice lines out of npx-run findings
status: open
priority: low
area: universal-lint/src/hooks/lint-file.mts (runLintTool npx branch, runChainLint)
---

# F24 Keep npm notice lines out of npx-run findings

## Status

Open. bench-other-langs finding (confirmed, low; cold cache only, never seen in real sessions).

## Problem

npx writes `npm notice New major version of npm available ...` to stderr. `runChainLint` concatenates stdout and stderr into the findings text, so the notice reaches Claude as part of a lint finding (3 extra lines per rewake).

## Evidence

Fresh `npm_config_cache`, stylelint-config fixture: the first hook run (2865 ms) ends its finding with `npm notice\nnpm notice New major version of npm available! 11.19.1 -> 12.2.2\nnpm notice Changelog: ...`; warm runs (946-1016 ms) have none. Across 2915 transcripts 0 findings contain "npm notice". `npm_config_update_notifier=false` timing: 819 vs 860 ms (noise).

## Code locations

`runLintTool` (`spawnSync("npx", …)` inherits `process.env`); `runChainLint` (`text = stdout + "\n" + stderr`).

## Approach

On the npx spawn only, pass `env: { ...process.env, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" }`. Consider `npm_config_loglevel: "error"` only if it does not hide install errors that matter (they already lead to skip or no output).

## Verification

Stub-npx test asserting the env vars reach the child; cold-cache bench: no "npm notice" in the finding.

## Constraints

npx path only. Version bump.

## Related

F09 (direct bin path avoids npm entirely on warm runs), F02.
