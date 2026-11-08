---
paths:
  - "src/hooks/**"
  - "tests/{tsc,registry,oxlint}.test.mts"
---

# TypeScript type-checking (`tsc`)

- `.ts`/`.tsx`/`.mts`/`.cts` get a **second, independent** whole-project `tsc --noEmit` beyond the JS/TS chain (eslint or oxlint); plain `.js`/`.jsx`/`.mjs`/`.cjs` never trigger it. Both findings surface in one `additionalContext`, each truncated independently at `MAX_CONTEXT_CHARS`, then the joined whole once more.
- `tsc` has no single-file mode with project context (it ignores `tsconfig.json` when files are passed), so it runs `-p <nearest tsconfig.json>`, found by walking up to `cwd` (`resolveTsconfig`).
- **Solution-style tsconfigs are skipped** (`looksLikeSolutionStyleTsconfig`: `"references"` present, `"include"` absent, `"files"` absent or `[]`): they compile nothing and exit `0` even with a real error in the referenced project, which would misreport "clean". `"files": []` is the TS handbook's own way to author one, so an empty array must not disqualify it.
  - Detection is a pattern regex over comment-stripped text (`stripJsonComments`), not a JSON parse: tsconfig allows comments and trailing commas, and a comment like `// see project references` would otherwise false-match.
  - Deliberately unanchored, so it matches compact and pretty-printed JSON alike. Accepted residual: a string value containing the literal `"references":`.
- **Skipped for oxlint type-checking:** tsc does not run when oxlint was selected by a `.oxlintrc.json`/`.oxlintrc.jsonc` whose parsed `options.typeCheck === true` (`oxlintConfigTypeChecks`: `stripJsonComments` + string-aware `stripTrailingCommas` + `JSON.parse`; any read/parse failure keeps tsc), so the same type errors aren't reported twice. `oxlint.config.ts` always keeps tsc (it can't be read without executing it); only the selecting file is read (no `extends`). The skip also requires that oxlint actually ran to a clean/issues verdict (`runChainLint`'s `ran`): oxlint unavailable or a skip verdict keeps tsc. A missing `oxlint-tsgolint` makes oxlint exit 1 ("Failed to find tsgolint executable"), which surfaces as an oxlint finding. Residual: a file excluded by oxlint's `ignorePatterns` exits 0 and still skips tsc.
- Repeat checks run `--incremental --tsBuildInfoFile <cache>` under `${CLAUDE_PLUGIN_DATA}` (fallback: OS temp dir, never `cwd` — "never writes into the repo" holds either way), named by a hash of the tsconfig realpath (`tsBuildInfoPathFor`).
- **Exit contract: trust live exit codes, not the documented `ExitStatus` enum.** `classifyExit`'s `"tsc"` case is 0 clean / 1-or-2 issues / else skip, verified empirically, and it has already flipped once across a `tsc` major version (the version-by-version evidence lives in that case's comment). Re-verify whenever the installed `tsc` major changes materially and findings stop surfacing.
  - Under the native compiler, exit `1` is also used for project/config-loading failures (broken `extends`, invalid option value, missing tsconfig), so `runTypeCheck` adds a content pass for exit `1`: `tscOutputHasSourceDiagnostic` (after stripping ANSI colors) requires a diagnostic anchored to a real `.ts`/`.tsx`/`.mts`/`.cts` location.
  - A config failure alongside a real source diagnostic still surfaces the finding (one true location suffices). Exit `2` always meant a real diagnostic and skips the extra check.
- **Discovery:** `tsc` on `PATH` first, else `<cwd>/node_modules/.bin/tsc`, both spawned directly with `--noEmit --incremental`.
- **No `npx` fallback:** the `typescript` package ships two bins (`tsc`, `tsserver`), neither named like the package, so the single-positional `npx --yes <npmSpec>` idiom isn't guaranteed to resolve `tsc`.
- Overlapping hook processes in one project share the same `--tsBuildInfoFile` and could interleave writes — accepted: it's a performance cache, not a correctness input; corruption means a silent full rebuild or a non-`0`/`2` exit (skip) — a missed finding, never a wrong one. Write/Edit (PostToolUse) and the skill driver still overlap; FileChanged lints of one tsconfig serialise `tsc` under the F13 project-check lock, so a burst writes the buildinfo from one process at a time.
