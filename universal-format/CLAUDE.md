# universal-format

Formats the content of every `Write` and `Edit` before it lands: one PreToolUse `mcp_tool` hook calls the tool `format_pre` of the plugin's MCP server `universal-format-hooks`, which hands the formatted content back as `updatedInput`. Thirteen languages go through the bundled prettier in-process (JS/TS, JSON, YAML, Markdown, CSS, SCSS, LESS, HTML, Vue, GraphQL, Shell, Java, PHP), Kotlin, Python, Go and Rust through the first CLI formatter on PATH, fed on stdin. Nothing runs after the write.

## Parts

Two layers. The path-scoped rules in `.claude/rules/` load with matching files and hold the constraints only. The design pages in `development/wiki/plugins/universal-format/design/` hold the reasons, measurements, residuals and what was removed on purpose; they are not loaded by themselves. Do not "fix" a behaviour of an area without reading its design page first.

- Hook, server and handler (`plugin/hooks/hooks.json`, `plugin/.mcp.json`, `src/mcp/`): rule `hooks-and-server.md`.
- Vendored prettier bundle (`scripts/vendor.mts`, `scripts/vendor-entry.mts`, `src/mcp/vendor/index.d.ts`, `plugin/mcp/vendor/`): rule `vendor-build.md`.
- Skill `universal-format` (`plugin/skills/universal-format/`, driver `src/skills/universal-format/format-files.ts`): rule `skill-driver.md`.
- Tests: rule `tests.md`.

## Source layout (`src/mcp/`)

Import graph, no cycle at runtime: `util` ← `editorconfig` ← `prettier` ← `registry` ← `handlers` ← `server` (`editorconfig` imports a type from `registry`, erased by the build).

- `server.ts`: the MCP stdio loop, dual-era, one tool.
- `handlers.ts`: `formatPre`, the base directory (`resolveBase`), path exclusions, the dprint gate, the Edit swap (`applyEdit`, `shrinkSwap`), the pending config refreshes, the stdin run of a CLI formatter.
- `prettier.ts`: the bundled prettier and its three lazily loaded plugins, the printWidth guard, the project-config and ignore caches.
- `registry.ts`: extension map and the CLI formatter chains. `editorconfig.ts`: `.editorconfig` resolver and its mapping to CLI flags. `util.ts`: the upward walk and the PATH lookup.

## No `userConfig` (deliberate, permanent)

`package.json` has `"claudePlugin": {}`: the hook is the whole plugin, so disabling it equals uninstalling it. The opt-outs are `.prettierignore` for the prettier languages and not installing the tool for a CLI language. The dprint deferral is detected at runtime, not a toggle. `tests/manifest.test.ts` asserts that no `userConfig` exists.
