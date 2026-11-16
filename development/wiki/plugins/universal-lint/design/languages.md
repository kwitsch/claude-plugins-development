# JSON: not covered (do not "fix" without reading this)

- `.json` is intentionally absent from `EXT_MAP` — not a bug.
- No standalone, actively-maintained JSON linter has a clean exit-code contract: `jsonlint` (npm) is dead since 2018; its successor `@prantlf/jsonlint` and `biome lint` return the same exit code (1) for "invalid JSON" and "crashed/misconfigured".
- A checkstyle-style output classifier for a tool whose own maintainers haven't separated this is unforced complexity.
- `universal-format` already rejects malformed JSON via its bundled prettier — format-only coverage is the honest answer.
