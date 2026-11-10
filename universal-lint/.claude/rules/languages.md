---
paths:
  - "src/hooks/**"
  - "tests/{php,rust,stylelint,go,checkstyle,core,oxlint}.test.mts"
---

# Per-language notes: JS/TS, CSS/SCSS, PHP, Rust, Go, JSON

## `.scss` limitation (accepted)

- `stylelint` runs with `args: []`, so no `customSyntax` and its default CSS-only parser (v14 dropped by-extension syntax inferral). SCSS needs e.g. `postcss-scss` (usually via `stylelint-config-standard-scss`), which this plugin can't bundle without a dependency the target may lack.
- Without an SCSS-aware `customSyntax`, ordinary SCSS (`//` comments, `$variables`, `&`-nesting, `#{...}`) can surface as bogus `CssSyntaxError` "issues". `.css` is unaffected.

## CSS/SCSS: no stylelint config = no lint (F07, 0.15.6)

- `.css`/`.scss` run `REGISTRY.css` (stylelint) only when `hasStylelintConfig` finds a config; otherwise `lintResolved` runs no chain lint (no PATH probe, no `node_modules/.bin` lookup, no `npx --yes stylelint`): stylelint without a config only exits 78 (skip) after about 1 s.
- Search places = stylelint 18.0.0's (cosmiconfig 10 defaults, verified in its source): `STYLELINT_CONFIG_FILENAMES` (`.stylelintrc`, `.stylelintrc.{json,yaml,yml,js,ts,cjs,mjs}`, `.config/stylelintrc`, `.config/stylelintrc.{json,yaml,yml,js,ts,cjs,mjs}`, `stylelint.config.{js,ts,cjs,mjs}`) or a `package.json` with a non-null top-level `stylelint` key, from the file's dir up to `/`, and again from the payload cwd up to `/` (stylelint falls back to searching its cwd, which a symlinked file path can leave off the first walk) (`walkToRoot`; stylelint's own walk stops at `$HOME`, so this is a superset), else an existing stylelint global config dir (`$XDG_CONFIG_HOME/stylelint` or `~/.config/stylelint`, `~/Library/Preferences/stylelint`; stylelint reads `config`/`config.{json,yaml,yml,js,ts,cjs,mjs}` in it, the hook only checks that the directory exists). Update the list when stylelint's search places change: a missed name silently skips a configured project.
- `package.json` is parsed (`devDependencies.stylelint` does not count); an unreadable or invalid one counts as a config (fail open). Unlike `package.json#eslintConfig` (F03), stylelint honours its key.
- Accepted: names count by existence only (an empty `.stylelintrc`, which stylelint ignores, still costs the run that exits 78), and so does a global config dir without a config file in it; `.cts`/`.mts` names are not stylelint search places and do not count; a cosmiconfig meta config (`.config/config.*` or a `package.json` `cosmiconfig` key adding search places) and the Windows global dir are not checked.

## PHP: phpstan/psalm and the vendor/bin gap

- `phpstan` (chain[0]) and `psalm` (chain[1]) are file-scoped static analyzers — real-bug-catching, not style (like `tsc` vs `eslint`) — and PATH-only (Composer-distributed, no `npmSpec`).
- **phpstan:** only exit `0` is documented; any non-zero is `issues` (the same ambiguity accepted for `go vet`). Its default level 0 (no `phpstan.neon`/`.dist`) only catches unknown classes/functions and wrong argument counts, so a flawed file can go unreported — real, not a bug.
- **psalm:** documented 0 clean / 1 problem running Psalm / 2 real issues. A project without `psalm.xml` makes Psalm print "Could not locate a config XML file..." and exit `1` (Psalm's `CliUtils.php`) → the `skip` bucket, so a missing config never surfaces as a false finding.
- **Accepted gap:** no `vendor/bin/<tool>` discovery (the PHP analogue of `tsc`'s `node_modules/.bin` special case). Most PHP projects install these as local Composer dev-dependencies, so the chain silently no-ops there until a global/`PATH` install exists. Not solved: the `node_modules/.bin` lookup covers `tsc` and the npm chain tools only (`hook-design.md` "Local `node_modules/.bin` and npx fallback", user decision, F04, 0.15.3).

## Rust: cargo clippy/check, manifest targeting, and the clippy-component gap

- `.rs` routes to `cargo-clippy` (chain[0], richer) → `cargo check` (chain[1], compile-only fallback). Both are `manifestPath` tools and PATH-only (rustup-distributed; no valid npx equivalent, so no `npmSpec`).
- **Probe `cargo-clippy`, not `cargo clippy`:** `onPath("cargo-clippy")` is true iff the clippy rustup component is installed. A bare `cargo` on `PATH` without the component makes `cargo clippy` exit non-zero ("no such command: clippy"), which the coarse contract would misreport as a finding. Probing the shim makes selection fall through cleanly to `cargo check`.
- **`spawnAs` differs from the probed `name`:** the standalone `cargo-clippy` driver rejects `--manifest-path` (clap usage error, misreported as a finding on **every** edit), so the clippy entry carries `spawnAs: { name: "cargo", args: ["clippy"] }` — `onPath`/`selectLintTool` still probe `cargo-clippy`, `runLintTool` spawns `cargo clippy <args>`. No other chain entry uses `spawnAs`.
- **`-- -D warnings`:** clippy lints default to `warn` and plain `cargo clippy` exits 0 with warnings (the same pitfall as `eslint`/`yamllint`); `-D warnings` after `--` promotes them so the exit code is a trustworthy signal. Additive, non-mutating, doesn't match the banned-flag regex.
- **`manifestPath` + `resolveCargoManifest`, not `targetsDir`:** cargo takes no positional file/dir target (it works on the crate/workspace from `Cargo.toml`), but `buildArgv` normally appends one, which cargo rejects.
  - `manifestPath` emits `--manifest-path <nearest Cargo.toml>` (found walking up to `cwd`, existence-only) inserted **before** any `--` so it stays a cargo option, not a rustc arg; it targets the right crate in a multi-crate workspace.
  - A `.rs` file outside any Cargo project is a silent no-op, gated in `runChainLint` before spawning.
- **Coarse contract:** `classifyExit`'s shared `cargo-clippy`/`cargo` case is `0` clean, any non-zero `issues` (101 on a compile error), as for `go`/`phpstan` — a tool malfunction isn't separable from a finding by exit code (accepted). `status === null` (timeout/signal) skips before the switch.
- `CARGO_SPAWN_TIMEOUT_MS` (45 s) is a separate, larger budget (they compile the crate). A cold build can exceed it: the first leaf-crate lint after a fresh clone or `cargo clean` took 45,068 ms through the hook (single run, 0.14.0 analysis of 2026-11-07; F29 doc), was killed and skipped silently (fail-open: a timeout is `status === null`, and the selected tool is not retried as `cargo check`), so that edit's clippy finding is lost; the next run took 13,664 ms and reported normally (a cold core crate: 6.8 s). A first-run budget or warmup would be a code follow-up.
- **Scope: one crate, dependents unchecked.** `--manifest-path` names only the nearest `Cargo.toml` (`resolveCargoManifest`) and `buildArgv` passes no `-p`/`--workspace`, so cargo checks that package and its dependencies, never the crates that depend on it. An edit to a core crate that breaks a dependent is reported only when a file of that dependent is linted.
- **Warm cost and concurrency** (0.14.0 analysis of 2026-11-07, 8-crate workspace copy, one machine under load, see `docs/TASKS.md`): warm no-change hook run 185-329 ms (`cargo clippy` alone 130-307 ms); leaf-crate edit 770-925 ms; core `lib.rs` edit 630-712 ms median, 4,880 ms max (the first edit that invalidates the dependents); alternating `cargo check` and `cargo clippy` on one target dir rebuilds once (3.9 s, then 0.4 s). Concurrent cargo runs on one target dir block on cargo's own build-directory lock, not on a hook lock: a core and a leaf edit at once took 0.79 s and 2.5-2.7 s (the leaf run waits, then re-checks the dependent chain).
- **Bursts:** PostToolUse `Write`/`Edit` takes no slot and no lock (no debounce, user decision), so N edits in one crate run N full cargo invocations (burst of 4: 910-985 ms each, same analysis). FileChanged coalesces them: `coalesceProjectCheck` (F13, 0.15.12) serializes per `Cargo.toml` key before cargo's lock and skips a run already covered by a completed one (`hook-design.md` "Project-check lock"); different crates sharing one target dir still serialize only inside cargo.

## Go: golangci-lint/go vet, package scope, and cold GOCACHE

- `.go` routes to `golangci-lint run` (first entry of the go chain) → `go vet` (second entry), both `targetsDir` and PATH-only. `selectLintTool` takes the first one on `PATH`, so with golangci-lint installed `go vet` never runs.
- **Scope: one package.** `buildArgv` appends the edited file's directory, so each lint checks that whole package and only it: importing and sibling packages are not checked. Same-package edits are one coalescing key under FileChanged (`<tool>:<package dir>`).
- **Cost** (0.14.0 analysis of 2026-11-07, 14.6k-line module, `go vet` with golangci-lint absent, one machine under load): warm hook run 495-546 ms (`go vet` alone 338-381 ms); cold `GOCACHE` 8.7-9.4 s for `go vet`, inside `SPAWN_TIMEOUT_MS` (30 s, the go chain's budget; only cargo gets `CARGO_SPAWN_TIMEOUT_MS`). A cold `golangci-lint` run is unmeasured and gets the same 30 s; a timeout is `status === null`, skipped silently and not retried as `go vet`. The hook neither sets nor clears `GOCACHE`; the go tool's own cache decides. On WSL about 95 ms of each `go vet` is its gccgo PATH scan (F28, `hook-design.md`).
- **Bursts:** PostToolUse `Write`/`Edit` runs every edit (no debounce): 4 concurrent same-package edits ran 4 `go vet`s, 690-790 ms each (same analysis). FileChanged coalesces them via `coalesceProjectCheck` (F13: go20 burst, 20 `go vet` spawns down to 1).

## JS/TS: eslint vs oxlint

- `.js .jsx .mjs .cjs .ts .tsx .mts .cts` run `REGISTRY.jsts` (eslint), the alternate chain `REGISTRY.oxlint` (not in `EXT_MAP`), or no chain lint; `lintResolved` decides via `resolveOxlintConfig` and the eslint-name walk.
- Config names: eslint = `eslint.config.{js,mjs,cjs,ts,mts,cts}`, `.eslintrc`, `.eslintrc.{js,cjs,json,yaml,yml}`; oxlint = `.oxlintrc.json`, `.oxlintrc.jsonc`, `oxlint.config.ts` (probed on oxlint 1.91.0; `oxlint.config.js`/`.mjs` were not picked up).
- The nearest directory with any config wins; within one directory oxlint names are checked first, so oxlint wins a same-dir tie (user decision: a project adding oxlint next to an existing eslint config is migrating; only oxlint runs, no co-existence). No eslint and no oxlint config = no JS/TS chain lint (user decision, F03, 0.15.2): eslint without a config only exits 2 (skip) after an npx/PATH run of about 0.8 s. `tsc` still runs for `.ts`/`.tsx`/`.mts`/`.cts`.
- The oxlint/eslint walk goes from the file's dir up to `cwd` inclusive (`walkUpToCwd`, like the checkstyle/cargo/tsconfig resolvers) and oxlint configs above `cwd` are ignored; when it finds nothing, eslint names alone are checked further up to `/` (`walkToRoot`, like eslint's own lookup and the markdownlint/yamllint walkers), so an eslint config above `cwd` (monorepo root, `$HOME`) still runs eslint.
- Which binary runs is a separate lookup (`localBin`, see `hook-design.md` "Local `node_modules/.bin` and npx fallback"): a local eslint/oxlint runs from the package root holding its `node_modules` (residual in `hook-design.md`).
- Selection is by file name only (`existsSync`), never by content or `package.json#eslintConfig`: this repo's own `.oxlintrc.json` lists `"plugins": ["eslint", ...]`, so content-based selection would misfire. Legacy `.eslintrc*` names count by name only: eslint 10 (what `npx --yes eslint` resolves) ignores them and still exits 2 (skip); accepted. A project configured only through `package.json#eslintConfig` gets no JS/TS chain lint.
- `--no-error-on-unmatched-pattern` is passed because a file excluded by the project's oxlint `ignorePatterns` otherwise exits 1 ("No files found to lint"), which would be a false finding.
- oxlint exit contract (1.91.0): 0 clean or warnings only, 1 errors / config parse failure / type errors. A broken oxlint config therefore surfaces as a finding carrying oxlint's parse error — accepted.
- `-c <detected config>` is appended (`lintResolved`), making it oxlint's root config. Probed on 1.91.0: without it oxlint ignores a nested `oxlint.config.ts` and rejects `options.typeAware` in a nested config ("only supported in the root config"). No type-aware flags (`--type-aware`/`--type-check`) are forced; the project's config decides. Selected but unavailable oxlint (no PATH, no local `node_modules/.bin/oxlint`, no npx) = no lint, never an eslint fallback.

## JSON: not covered (do not "fix" without reading this)

- `.json` is intentionally absent from `EXT_MAP` — not a bug.
- No standalone, actively-maintained JSON linter has a clean exit-code contract: `jsonlint` (npm) is dead since 2018; its successor `@prantlf/jsonlint` and `biome lint` return the same exit code (1) for "invalid JSON" and "crashed/misconfigured".
- A checkstyle-style output classifier for a tool whose own maintainers haven't separated this is unforced complexity.
- `universal-format` already rejects malformed JSON via its bundled prettier — format-only coverage is the honest answer.
