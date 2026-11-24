# graphmind-helper on the published preset

How the pilot moved from the repo-local build (`pluginConfig`) to `@kwitsch/tsdown-preset-claude-code` (0.1.0, then 0.1.2; plugin 0.2.4 to 0.2.5), what the output comparison showed, and what the next plugin migrations can rely on.
All plugins moved to the preset on 2026-11-24: [tsdown-plugin-build](../../../decisions/tsdown-plugin-build.md#superseded-by-the-published-preset-2026-11-24).

## Setup

- `tsdown.config.ts` imports only the preset; entries come from `hooks.template.json` (`{ "mod": "./src/hooks/register.ts" }`) and `mcp.template.json` (server `graphmind`, command `./src/bin/mcp.ts`). `assets/README.md` is copied to `plugin/README.md`. The preset empties `plugin/` before each build, so `hooks/hooks.json`, `.mcp.json` and `bin/` are no longer hand-kept.
- `overrides.alias` maps `@shared` to `development/shared/src`; the helper is inlined as before (measured 2026-11-22).
- The package keeps its `claudePlugin` key: CI and tests find plugins by it.
- The preset is installed from npmjs without a token or an `.npmrc` (0.1.2, exact). 0.1.0 was published to GitHub Packages only; the pilot first used it from there, which needed `read:packages` and a user-level `pnpm config set` token because pnpm 11 ignores credentials in a project `.npmrc` ("environment variables are not expanded in registry credentials from a project .npmrc"). The packages moved to npmjs with 0.1.1 (npm trusted publishing with provenance from 0.1.2), so those parts are gone again. `minimumReleaseAgeExclude: ["@kwitsch/*"]` stays for fresh releases (decided 2026-11-22).
- Root `rolldown` went from 1.2.16 to 1.3.3 first, in its own pull request. Rebuilding all eight plugins with the old build changed only `universal-format` (vendor chunk file names), which got a patch bump (measured 2026-11-22).

## Output comparison (measured 2026-11-22, preset 0.1.0, rolldown 1.3.3, 0.2.4 against 0.2.5; rebuilt with 0.1.2 on 2026-11-22: no byte changes)

| File                           | Result                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `.claude-plugin/plugin.json`   | same fields in the same order; only `version` differs                                               |
| `hooks/hooks.json`             | same content; the array spans several lines (`JSON.stringify(..., null, 2)`)                        |
| `.mcp.json`                    | `args` points to `mcp/mcp.mjs`; array spans several lines                                           |
| `README.md`                    | one line differs: it names the wrapper `mcp/mcp.mjs` instead of `bin/mcp.mjs` (edited in `assets/`) |
| `hooks/register.js`            | byte-identical, although the target went from es2022 to node26                                      |
| `bin/mcp.mjs` to `mcp/mcp.mjs` | moved, byte-identical (shebang kept, mode 0755)                                                     |

- No extra files in `plugin/`, no external import left, no mangled identifiers in `register.js`.
- A second build changes nothing.
- `claude plugin validate --strict plugin` passes; it prints one informational line that the README has no marketplace install line, the same as for 0.2.4.
- `pnpm --filter graphmind-helper test` (87 tests), `test:plugin` (6 tests), root `pnpm lint` and `pnpm -r test` pass. The root manifest test and the layout check accept the generated `plugin/` including `mcp/`.

## For the next migrations

- A command in a template must be a relative `.ts` path; the preset builds it to `mcp/<name>.mjs` (MCP) or `hooks/<name>.mjs` (command hooks) and rewrites the command to `node ${CLAUDE_PLUGIN_ROOT}/...`.
- Only `universal-format` needs more: its vendor directory is not supported by the preset 0.1.x.
- CI installs the preset with a plain `pnpm install --frozen-lockfile`; Dependabot resolves `@kwitsch/*` on npmjs without a registry entry (CI of the pilot pull request, measured 2026-11-22).
