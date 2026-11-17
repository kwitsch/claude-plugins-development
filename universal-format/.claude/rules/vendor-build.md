---
paths:
  - "scripts/**"
  - "src/mcp/vendor/**"
  - "src/mcp/prettier.ts"
  - "plugin/mcp/vendor/**"
  - "package.json"
---

# Vendored bundle: what must hold

- The build is `node ../development/scripts/build-plugin.ts && node scripts/vendor.mts`, in that order: the standard build removes every `.mjs` it did not write, the chunks included.
- Own code never goes into the bundle: `scripts/vendor-entry.mts` exports only prettier and the three plugin loaders. Sources import it as `./vendor/index.js`, typed by `src/mcp/vendor/index.d.ts`; a new export needs both files changed.
- The plugin loaders stay dynamic `import()`s (a static import evaluates the plugin at every server start; `tests/build.test.ts` checks it).
- `prettier`, `prettier-plugin-java`, `@prettier/plugin-php`, `prettier-plugin-sh` and `sh-syntax` are pinned exactly in `package.json`; `sh-syntax` equals the version `prettier-plugin-sh` resolves. Do not bump `prettier-plugin-sh` past 0.16.1 without checking the bundle. Dependabot ignores all five (`.github/dependabot.yml`): a bump changes `plugin/` and needs a plugin release.
- rolldown is a root devDependency with an exact pin; its output must be the same on every machine (`minify`, `comments: false`, content-hashed chunk names): CI rebuilds and compares.
- Three wasm files ship, listed under `pluginBuild.assets`: the two of prettier-plugin-java beside its chunk in `mcp/vendor/`, sh-syntax's `main.wasm` in `mcp/`, one directory above the chunks. `vendor.mts` copies them with mode 0644 and removes every other wasm file.
- Never edit `plugin/mcp/vendor/*` or a wasm file by hand.

Design: [vendor-build.md](../../../development/wiki/plugins/universal-format/design/vendor-build.md).
