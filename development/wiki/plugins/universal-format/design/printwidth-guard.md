# JSON and YAML line-length guard (do not "fix" without reading this)

Why JSON and YAML get no line-length limit when a project has none of its own, and how "has none" is decided.

- prettier's default `printWidth` of 80 wraps JSON and YAML arrays and flow mappings in projects that never asked for an 80-column limit. prettier already honors a project's own config, so the guard covers only the absent-config case: no project config means no limit.
- `shouldOverridePrintWidth(file, base)` (JSON and YAML only) checks `hasPrettierProjectConfig`, then the `max_line_length` of `resolveEditorconfig`; only when both are empty does `formatInProcess` set `printWidth` to 99999 (never `Infinity`: prettier rejects it).
- `hasPrettierProjectConfig` is an existence check of prettier's own config file names (`.prettierrc*`, `prettier.config.*`) plus a top-level `prettier` key in `package.json` (parsed, `Object.hasOwn` on the top level only: an entry under `devDependencies` does not count) or `package.yaml` (a line-anchored regex: no YAML parser is bundled into the own code). Cached per directory, cleared with prettier's config cache ([caches.md](caches.md)).
- Both walks are unbounded, from the file's directory to the filesystem root, like prettier's own config search (its searcher has no stop directory, read from prettier 3.x's source in the former repository) and its `editorconfig: true` lookup. Stopping at the base, as the tool-native-config walks of the CLI formatters correctly do, would call a prettier config above the project root (a workspace, a monorepo) "absent" and override a config the plugin never saw.
- `normalizeProps` drops an explicit `max_line_length = off`, so it counts as "not set" and the override applies. Same result (no limit), not a bug.
- Markdown is left alone: prettier's default `proseWrap` is `preserve`, so there is no default-line-length problem, and a `printWidth` would change other decisions inside a Markdown file (how a fenced `json` block wraps).
- CSS, SCSS, LESS, HTML, Vue, GraphQL, Shell, Java and PHP are not guarded either: only JSON and YAML were reported as a problem. Without a preference they get prettier's 80 columns.
- The tests assert the policy on the produced content (`tests/languages.test.ts`: a long array or flow sequence stays on one line, or wraps with a config).
