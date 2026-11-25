---
paths:
  - "src/mcp/vendor/**"
  - "src/mcp/prettier.ts"
  - "plugin/mcp/vendor/**"
  - "package.json"
  - "tsdown.config.ts"
---

# Vendored bundle: what must hold

- The build is plain `tsdown`. `tsdown.config.ts` declares `bundles: { "mcp/vendor": "src/mcp/vendor/index.ts" }`: the preset builds `plugin/mcp/vendor/index.mjs` plus content-hashed chunks (minified, no comments) and keeps every import of the bundle source external (`./vendor/index.mjs` in `server.mjs`, the matching relative path in the skill driver).
- Own code never goes into the bundle: `src/mcp/vendor/index.ts` exports only prettier and the three plugin loaders. Sources import it as `./vendor/index.js`; the types come from that file.
- The plugin loaders stay dynamic `import()`s (a static import evaluates the plugin at every server start; `tests/build.test.ts` checks it).
- `prettier`, `prettier-plugin-java`, `@prettier/plugin-php`, `prettier-plugin-sh` and `sh-syntax` are pinned exactly in `package.json`; `sh-syntax` equals the version `prettier-plugin-sh` resolves. Do not bump `prettier-plugin-sh` past 0.16.1 without checking the bundle. Dependabot ignores all five (`.github/dependabot.yml`): a bump is a build-input change (`package.json`) and needs a version bump in the same PR.
- The bundle output must be the same on every machine (minified, no comments, content-hashed chunk names): CI and Sync build it fresh, so it must be reproducible.
- Three wasm files ship, copied by `files` in `tsdown.config.ts` from the installed packages and listed under `pluginBuild.assets`: the two of prettier-plugin-java beside its chunk in `mcp/vendor/`, sh-syntax's `main.wasm` in `mcp/`, one directory above the chunks. They must stay mode 0644 (preset 0.3.0 `files` writes a fixed non-executable mode; a mode change is a preset bug to report).
- Never edit `plugin/mcp/vendor/*` or a wasm file by hand.

Design: [vendor-build.md](../../../development/wiki/plugins/universal-format/design/vendor-build.md).
