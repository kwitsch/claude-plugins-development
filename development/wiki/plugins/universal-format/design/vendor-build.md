# Vendored prettier bundle

How prettier and its plugins get into `plugin/`, why they are bundled at all, and what the build must keep true.

## Why a bundle

- A plugin runs from a versioned cache copy without `node_modules` above it and without an install step. prettier and its java, php and shell plugins (with their `web-tree-sitter` and `sh-syntax` wasm bindings) are therefore shipped inside the plugin.
- Rejected: bare-specifier imports (fail to start for every real user), a full `node_modules` under `mcp/` (larger and drifts), a runtime `pnpm install` (breaks the zero-install start). Reopen only if Claude Code ever provisions `node_modules` for a plugin.
- The repository rule "runtime code is zero-dependency" has this one exception, a user decision of 2026-11-17: [repo-tooling.md](../../../decisions/repo-tooling.md), "Vendored third-party bundles".

## Layout

- Own code (`src/mcp/*.ts`, the skill driver) is built by tsdown into two self-contained outputs, `plugin/mcp/server.mjs` and `plugin/skills/universal-format/format-files.mjs` (since 0.19.3).
- Third-party code is `plugin/mcp/vendor/*.mjs`, built since 0.19.5 by the preset's `bundles: { "mcp/vendor": "src/mcp/vendor/index.ts" }` (preset 0.3.0; minified, `comments: false`, content-hashed chunks `[name]-[hash].mjs`). Before 0.19.5 `scripts/vendor.ts` bundled `scripts/vendor-entry.ts` with rolldown.
- `src/mcp/prettier.ts` imports `./vendor/index.js`, which resolves to the bundle source `src/mcp/vendor/index.ts` (types and vitest included); the build keeps the import external.
- The build is one `tsdown` run; the preset empties `plugin/` first, so no stale chunk or wasm file survives.
- The output must not depend on the machine: no comments (they would carry module paths of the package store), content-hashed chunk names. CI builds on every PR that touches the plugin and Sync builds what ships, so the output must be reproducible; `tests/build.test.ts` checks that no checkout or store path is embedded.

## Wasm files

- Three files, each where its plugin looks at runtime:
  - `mcp/vendor/web-tree-sitter.wasm` and `mcp/vendor/tree-sitter-java_orchard.wasm`: prettier-plugin-java and web-tree-sitter load theirs with `new URL(<name>, import.meta.url)`, that is, beside the chunk;
  - `mcp/main.wasm`: sh-syntax reads `path.resolve(<its module directory>, "../main.wasm")`, one directory above the chunk.
- A bundler cannot emit them (runtime lookups), so the preset's `files` option copies them from the installed packages with a fixed mode 0644 (0.3.0; 0.2.0 kept the source mode, and the pnpm store holds two of them executable: preset issue #11); the emptied `plugin/` leaves no orphan when a grammar is renamed.
- They are listed under `pluginBuild.assets` in `package.json`, the opt-in list of the layout check; `.gitattributes` marks `*.wasm` binary.
- `main.wasm` is used only when a project sets `experimentalWasm: true`; the default shell parser is mvdan-sh, pure JS.
- sh-syntax needs Go's `wasm_exec` runtime on `globalThis`. Its own side-effect import of `vendors/wasm_exec.cjs` is tree-shaken, because its `package.json` lists only `vendors/wasm_exec.js` as side-effectful; the vendored entry imports the exported subpath itself. Without it every wasm format failed with "Go is not defined" (seen with the bun bundler, kept for rolldown; the `experimentalWasm` test covers it).
- The `sh-syntax` devDependency must equal the version prettier-plugin-sh resolves (it declares a `^` range): otherwise the Go runtime and `main.wasm` would come from different versions (tested).

## Measured (2026-11-17, node 24.22.2, WSL2, median of 7 starts, two runs)

|                                              | former single-file bundle (bun build, not minified)                     | this build |
| -------------------------------------------- | ----------------------------------------------------------------------- | ---------- |
| `mcp/` on disk                               | 12.4 MB                                                                 | 8.8 MB     |
| server start to the `initialize` answer      | 188 ms (about 100 ms with node's compile cache, measured before 0.19.0) | 53 ms      |
| first `.ts` format                           | 47 ms                                                                   | 59 ms      |
| second `.ts` format                          | 2.9 ms                                                                  | 3.2 ms     |
| first `.java` format                         | 23 ms                                                                   | 18 ms      |
| first `.md` format (loads all three plugins) | 95 ms                                                                   | 97 ms      |

- The start is faster because prettier's parsers are separate chunks loaded on first use; the first format of a language pays for its chunk instead.

## What went with the launcher

- Until 0.18.0 `.mcp.json` started `bin/mjs-launch.sh`, which preferred bun over node, appended `~/.local/bin` and `~/.bun/bin` to PATH and, for node, exported `NODE_COMPILE_CACHE` under `CLAUDE_PLUGIN_DATA` (it cut the node start of the 9 MB single file from about 220 ms to about 100 ms). The server turned SIGINT and SIGTERM into `process.exit(0)` so node wrote that cache.
- User decision 2026-11-17: node only, `command: "node"` like dprint. Gone with it: bun detection and the startup line's runtime name, the compile cache and the signal handlers, the build fingerprint banner and its test (CI's rebuild replaced both), the canonicalisation of bun's path comments, the patch of sh-syntax's `__dirname` (bun baked in the build machine's path; rolldown takes sh-syntax's ESM build, which uses `import.meta.url`).
- bun was not faster anyway: warm p50 equal within noise for every language, node about 60 ms slower cold without its compile cache, bun's first start after a rebuild about 500 ms slower (measured 2026-10-19, former repository).
- The PATH append moved into `onPath` ([cli-formatters.md](cli-formatters.md)).

## Bumping a bundled package

- Change the exact pin in `package.json`, `pnpm install`, `pnpm --filter universal-format build`, run the tests, bump the plugin version, commit the sources. Dependabot ignores the five packages for that reason.
- The lockfile here resolves `tslib` 2.9.1 for sh-syntax where the former repository had 2.8.1; nothing else differs (compared 2026-11-17).
