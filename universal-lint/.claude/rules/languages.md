---
paths:
  - "src/hooks/**"
  - "tests/{checkstyle,core}.test.mts"
---

# Per-language notes

One rule file per language (each `paths:` `src/hooks/**` plus its tests):

- JS/TS (eslint vs oxlint, config selection): `lang-jsts.md`; the `tsc` pass: `typescript-check.md`.
- CSS/SCSS (`.scss` limitation, no stylelint config = no lint): `lang-css.md`.
- PHP (phpstan/psalm, the `vendor/bin` gap): `lang-php.md`.
- Rust (cargo clippy/check, manifest targeting, clippy-component gap, cost): `lang-rust.md`.
- Go (golangci-lint/go vet, package scope, cold GOCACHE): `lang-go.md`.
- YAML/Markdown line-length guard: `line-length-guard.md`.

## JSON: not covered (do not "fix" without reading this)

- `.json` is intentionally absent from `EXT_MAP` — not a bug.
- No standalone, actively-maintained JSON linter has a clean exit-code contract: `jsonlint` (npm) is dead since 2018; its successor `@prantlf/jsonlint` and `biome lint` return the same exit code (1) for "invalid JSON" and "crashed/misconfigured".
- A checkstyle-style output classifier for a tool whose own maintainers haven't separated this is unforced complexity.
- `universal-format` already rejects malformed JSON via its bundled prettier — format-only coverage is the honest answer.
