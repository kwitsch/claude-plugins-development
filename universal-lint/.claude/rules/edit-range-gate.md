---
paths:
  - "src/hooks/**"
  - "plugin/hooks/**"
  - "tests/{core,registry,tsc,yaml}.test.ts"
---

# Edit-range gate (do not "fix" without reading this)

- After an `Edit` the hook exits 2 only when a diagnostic is not proven to sit in the edited file outside the edited lines. No registered tool (shellcheck, checkstyle, ktlint, eslint, oxlint, ruff check, golangci-lint, go vet, yamllint, markdownlint(-cli2), stylelint, phpstan, psalm, cargo clippy/check) nor `tsc` has a line-range check mode (`golangci-lint --new-from-rev`/`psalm --diff` are git-based; `ruff format --line-range` is not a check), so the scan stays file/project-scoped and `gateFinding` filters the raw text afterwards. `buildArgv`/`classifyExit` are unchanged.
- **Range source:** the Edit `tool_response.structuredPatch` hunks (`editRanges`, inclusive 0-based lines): each run of `+` lines; a run of only `-` lines (pure deletion) gives the two lines around the deletion point, so deletions are linted too. `\ No newline at end of file` is not a line.
- **Whole file:** `Write`, any non-`Edit` tool, a missing/malformed `structuredPatch`, or a file holding a line break jsdiff does not count (lone `\r`, U+0085 NEL, U+2028/U+2029; `hasForeignLineBreak`; root `claude-code-tool-hook-facts.md`), so the gate and the settle window (`rec = null`, also for FileChanged) are off for that lint. An empty patch (nothing changed) returns `{}` without linting.
- **Location extraction**, per line after stripping `ANSI_SGR_RE`; a code-frame gutter line (`CODE_FRAME_RE`, `4 |     v.push(1);`) is never a location (its `v.push(1` would read as a foreign path); otherwise first match wins:
  - A `LOC_PATH_RE` `<path>.<ext>[:(]<line>`: ruff, ktlint, golangci-lint, go vet, checkstyle `[WARN] /abs/A.java:3:`, markdownlint `a.md:12`, psalm, oxlint `,-[src/a.ts:3:7]`, cargo `--> src/a.rs:12:5`, tsc `a.ts(12,5)`/`a.ts:12:5` (match anchored at a token start by a lookbehind; the unanchored form was quadratic on a long line, F27)
  - B `LOC_ROW_RE` `  <line>:<col>  ` rows (path-less, own file): eslint stylish, stylelint stylish, yamllint standard.
  - C `LOC_SHELLCHECK_RE` `In <file> line <n>:` (path-less, own file): shellcheck's default tty format. For a `shellcheck` finding this is the only location rule except for `-f gcc` lines (`a.sh:3:6: note: `, `SHELLCHECK_GCC_RE`, located by A): its tty output echoes the source line and the fix with no gutter, so `curl 127.0.0.1:8080` would read as a foreign path. Residual: golangci-lint's tab-indented source echo and psalm's snippet lines can still read as foreign locations (kept, reported).
- **Base directory** (`Finding.base`, set in `runChainLint`/`runTypeCheck`): cargo → directory of the `--manifest-path` Cargo.toml; golangci-lint/go vet (`targetsDir`) → the edited file's directory; tsc and every other tool → the spawn cwd: the payload `cwd`, or the directory holding the selected local `node_modules`.
- **Path matching (user decision):** (1) `path.resolve(base, p) === resolved` → own file; (2) else, only for a relative `p` whose base-resolved path does not exist, a path-segment suffix match (`resolved.endsWith(sep + p)`) → own file (covers cargo workspace-root paths, cwd-relative go paths); (3) else **foreign**: kept and reportable. Diagnostics in other files (e.g. tsc errors elsewhere) therefore still exit 2.
- **Filtering** by blank-line paragraphs: a paragraph without a located line is kept but not reportable (headers, summaries); otherwise it is split into segments at located lines (each carries the unlocated lines after it, so tsc continuation lines stay with their diagnostic; earlier lines are the preamble). Own-file misses are dropped, hits and foreign segments kept; a paragraph whose segments are all dropped loses its preamble. Exact lines, no context slack.
- **Result:** no located line at all → finding unchanged (fail open = report: phpstan's table format); nothing reportable left → finding dropped; exit 2 only when at least one finding survives. The gate runs before `truncate()`.
- **Parse errors are always kept:** an own-file miss whose segment or paragraph preamble matches `PARSE_ERROR_RE` (parse/syntax error wording, `unclosed`, `unterminated`, `end of file`, rustc's unnumbered `error: expected` header (not a bare `expected '...'`, which eslint eqeqeq and rustc E0308 also print), tsc `TS1xxx`, shellcheck `SC1xxx`) stays reportable, since an edit-caused parse error is often reported away from the edit (unclosed brace → EOF). Other own-file diagnostics outside the edit (e.g. a tsc call-site error in the same file) are dropped by design.
- **Residuals:**
  - a parse error phrased outside `PARSE_ERROR_RE` is gated
  - a path containing a space is not matched and counts as foreign (kept)
  - a same-named file reached only by the suffix fallback can be mistaken for the edited file
  - a format the regexes miss is reported unchanged
