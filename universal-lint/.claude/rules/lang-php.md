---
paths:
  - "src/hooks/**"
  - "tests/php.test.mts"
---

# PHP: phpstan/psalm and the vendor/bin gap

- `phpstan` (chain[0]) and `psalm` (chain[1]) are file-scoped static analyzers — real-bug-catching, not style (like `tsc` vs `eslint`) — and PATH-only (Composer-distributed, no `npmSpec`).
- **phpstan:** only exit `0` is documented; any non-zero is `issues` (the same ambiguity accepted for `go vet`). Its default level 0 (no `phpstan.neon`/`.dist`) only catches unknown classes/functions and wrong argument counts, so a flawed file can go unreported — real, not a bug.
- **psalm:** documented 0 clean / 1 problem running Psalm / 2 real issues. A project without `psalm.xml` makes Psalm print "Could not locate a config XML file..." and exit `1` (Psalm's `CliUtils.php`) → the `skip` bucket, so a missing config never surfaces as a false finding.
- **Accepted gap:** no `vendor/bin/<tool>` discovery (the PHP analogue of `tsc`'s `node_modules/.bin` special case). Most PHP projects install these as local Composer dev-dependencies, so the chain silently no-ops there until a global/`PATH` install exists. Not solved: the `node_modules/.bin` lookup covers `tsc` and the npm chain tools only (`npx-and-local-bin.md`, user decision, F04, 0.15.3).
