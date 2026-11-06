---
paths:
  - "src/hooks/**"
  - "tests/{php,rust,stylelint,go,checkstyle,core,oxlint}.test.mts"
---

# Per-language notes: JS/TS, SCSS, PHP, Rust, JSON

## `.scss` limitation (accepted)

- `stylelint` runs with `args: []`, so no `customSyntax` and its default CSS-only parser (v14 dropped by-extension syntax inferral). SCSS needs e.g. `postcss-scss` (usually via `stylelint-config-standard-scss`), which this plugin can't bundle without a dependency the target may lack.
- Without an SCSS-aware `customSyntax`, ordinary SCSS (`//` comments, `$variables`, `&`-nesting, `#{...}`) can surface as bogus `CssSyntaxError` "issues". `.css` is unaffected.

## PHP: phpstan/psalm and the vendor/bin gap

- `phpstan` (chain[0]) and `psalm` (chain[1]) are file-scoped static analyzers — real-bug-catching, not style (like `tsc` vs `eslint`) — and PATH-only (Composer-distributed, no `npmSpec`).
- **phpstan:** only exit `0` is documented; any non-zero is `issues` (the same ambiguity accepted for `go vet`). Its default level 0 (no `phpstan.neon`/`.dist`) only catches unknown classes/functions and wrong argument counts, so a flawed file can go unreported — real, not a bug.
- **psalm:** documented 0 clean / 1 problem running Psalm / 2 real issues. A project without `psalm.xml` makes Psalm print "Could not locate a config XML file..." and exit `1` (Psalm's `CliUtils.php`) → the `skip` bucket, so a missing config never surfaces as a false finding.
- **Accepted gap:** no `vendor/bin/<tool>` discovery (the PHP analogue of `tsc`'s `node_modules/.bin` special case). Most PHP projects install these as local Composer dev-dependencies, so the chain silently no-ops there until a global/`PATH` install exists. Not solved; `tsc`'s special case is deliberately not generalized to other tools.

## Rust: cargo clippy/check, manifest targeting, and the clippy-component gap

- `.rs` routes to `cargo-clippy` (chain[0], richer) → `cargo check` (chain[1], compile-only fallback). Both are `manifestPath` tools and PATH-only (rustup-distributed; no valid npx equivalent, so no `npmSpec`).
- **Probe `cargo-clippy`, not `cargo clippy`:** `onPath("cargo-clippy")` is true iff the clippy rustup component is installed. A bare `cargo` on `PATH` without the component makes `cargo clippy` exit non-zero ("no such command: clippy"), which the coarse contract would misreport as a finding. Probing the shim makes selection fall through cleanly to `cargo check`.
- **`spawnAs` differs from the probed `name`:** the standalone `cargo-clippy` driver rejects `--manifest-path` (clap usage error, misreported as a finding on **every** edit), so the clippy entry carries `spawnAs: { name: "cargo", args: ["clippy"] }` — `onPath`/`selectLintTool` still probe `cargo-clippy`, `runLintTool` spawns `cargo clippy <args>`. No other chain entry uses `spawnAs`.
- **`-- -D warnings`:** clippy lints default to `warn` and plain `cargo clippy` exits 0 with warnings (the same pitfall as `eslint`/`yamllint`); `-D warnings` after `--` promotes them so the exit code is a trustworthy signal. Additive, non-mutating, doesn't match the banned-flag regex.
- **`manifestPath` + `resolveCargoManifest`, not `targetsDir`:** cargo takes no positional file/dir target (it works on the crate/workspace from `Cargo.toml`), but `buildArgv` normally appends one, which cargo rejects.
  - `manifestPath` emits `--manifest-path <nearest Cargo.toml>` (found walking up to `cwd`, existence-only) inserted **before** any `--` so it stays a cargo option, not a rustc arg; it targets the right crate in a multi-crate workspace.
  - A `.rs` file outside any Cargo project is a silent no-op, gated in `runChainLint` before spawning.
  - Inserting before `--` also breaks `runLintTool`'s "`tool.args` is a leading prefix of `argv`" slice, so cargo tools skip the `rtk` path.
- **Coarse contract:** `classifyExit`'s shared `cargo-clippy`/`cargo` case is `0` clean, any non-zero `issues` (101 on a compile error), as for `go`/`phpstan` — a tool malfunction isn't separable from a finding by exit code (accepted). `status === null` (timeout/signal) skips before the switch.
- `CARGO_SPAWN_TIMEOUT_MS` is a separate, larger budget (they compile the crate). A cold first build may exceed it and skip silently (fail-open); warm/incremental runs are fast.

## JS/TS: eslint vs oxlint

- `.js .jsx .mjs .cjs .ts .tsx .mts .cts` run `REGISTRY.jsts` (eslint) or the alternate chain `REGISTRY.oxlint` (not in `EXT_MAP`); `lintFileHandler` picks the key via `resolveOxlintConfig`.
- Config names: eslint = `eslint.config.{js,mjs,cjs,ts,mts,cts}`, `.eslintrc`, `.eslintrc.{js,cjs,json,yaml,yml}`; oxlint = `.oxlintrc.json`, `.oxlintrc.jsonc`, `oxlint.config.ts` (probed on oxlint 1.91.0; `oxlint.config.js`/`.mjs` were not picked up).
- The nearest directory with any config wins; within one directory eslint names are checked first, so eslint wins a same-dir tie (no `eslint-plugin-oxlint` co-existence: only eslint runs). No config at all = eslint (pre-oxlint behavior).
- The walk goes from the file's dir up to `cwd` inclusive (`walkUpToCwd`, like the checkstyle/cargo/tsconfig resolvers); configs above `cwd` are ignored.
- Selection is by file name only (`existsSync`), never by content or `package.json#eslintConfig`: this repo's own `.oxlintrc.json` lists `"plugins": ["eslint", ...]`, so content-based selection would misfire.
- `--no-error-on-unmatched-pattern` is passed because a file excluded by the project's oxlint `ignorePatterns` otherwise exits 1 ("No files found to lint"), which would be a false finding.
- oxlint exit contract (1.91.0): 0 clean or warnings only, 1 errors / config parse failure / type errors. A broken oxlint config therefore surfaces as a finding carrying oxlint's parse error — accepted.
- No `-c` is passed (oxlint finds the nearest config itself) and no type-aware flags (`--type-aware`/`--type-check`) are forced; the project's config decides. Selected but unavailable oxlint (no PATH, no npx) = no lint, never an eslint fallback.

## JSON: not covered (do not "fix" without reading this)

- `.json` is intentionally absent from `EXT_MAP` — not a bug.
- No standalone, actively-maintained JSON linter has a clean exit-code contract: `jsonlint` (npm) is dead since 2018; its successor `@prantlf/jsonlint` and `biome lint` return the same exit code (1) for "invalid JSON" and "crashed/misconfigured".
- A checkstyle-style output classifier for a tool whose own maintainers haven't separated this is unforced complexity.
- `universal-format` already rejects malformed JSON via its bundled prettier — format-only coverage is the honest answer.
