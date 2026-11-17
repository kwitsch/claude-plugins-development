# Bundled prettier, no resolver (do not "fix" without reading this)

Why exactly one prettier formats every prettier language, how its three plugins are loaded, what a project can still configure, and why `.prettierignore` is the only ignore source.

## One prettier, always the bundled one

- The vendored bundle `plugin/mcp/vendor/index.mjs` ([vendor-build.md](vendor-build.md)) holds the one prettier of the process. It formats every file of the thirteen prettier languages, unconditionally: no version lookup, no install step, no network.
- Removed on purpose, do not re-add: the project-local tier (`createRequire(cwd).resolve("prettier")`), the PATH tier, the copy under the plugin data directory, the `npx --yes prettier` safety net, and the prettier entries of the CLI registry.
- Accepted consequences:
  - a project's own prettier version does not win, so its CI `prettier --check` may disagree with what the plugin wrote; the escape hatch is `.prettierignore`;
  - removing prettier from a project does not opt out.
- The whole prettier package is bundled, all parsers: prettier hands embedded `html`, `graphql` and `css` blocks inside Markdown to those parsers, so trimming would break inputs it accepts today.
- A project's prettier config is honored in full: `formatInProcess` calls `resolveConfig(file, { editorconfig: true })`, so `.prettierrc*`, `prettier.config.*`, the `prettier` key of `package.json`/`package.yaml` and `.editorconfig` apply.

## Plugins a project's config names

- A bundled prettier resolves a `plugins` entry against the server process's cwd, not the session's: from a foreign cwd `format()` throws `Cannot find package '<name>'` (seen with prettier 3.x, former repository), which the handler would turn into "no formatting at all".
- `resolveConfigPlugins` therefore rewrites every non-absolute string entry to an absolute path with `createRequire(join(base, "package.json")).resolve(entry)`; non-strings and absolute paths pass through.
- If any entry cannot be resolved, the file is left unformatted. Rejected: dropping `plugins` silently (it writes output the project never asked for, and fails anyway for a plugin that provides the parser).
- The resolved config is copied before it is changed: prettier caches it, and a mutation would leak one call's plugins and printWidth into every later file with the same config.
- The bundled plugins come last in the `plugins` array, so a project config naming the same plugin cannot leave the bundled prettier without a parser (double registration is safe, checked in the former repository).

## The three bundled plugins

- `prettier-plugin-java`, `@prettier/plugin-php` and `prettier-plugin-sh` replaced the shell, java and php CLI chains outright; there is no CLI fallback. A plugin that cannot parse a file throws, the handler answers `{}`, the write proceeds unformatted (the precondition is tested: bad input throws instead of returning mangled output).
- Kotlin, Python, Go and Rust stay on CLIs by survey: Kotlin's only prettier plugin runs `java -jar` against a bundled JVM jar and needs prettier 1.x, Python's is a single 2018 release pinned to a prettier git SHA, and no usable prettier plugin formats Go or Rust.
- Never set a plugin option from this code (in particular never `experimentalWasm`): the project's prettier config is the only knob. A project that sets `experimentalWasm: true` gets prettier-plugin-sh's wasm parser (`main.wasm`, tested).
- `prettier-plugin-sh` is pinned to 0.16.1, its last release that bundles cleanly: 0.17.0 and later resolve their wasm outside the bundle's directory and needed about 540 lines of vendored TinyGo glue (checked with the bun bundler in the former repository; not re-checked with rolldown).

## Lazy loading

- Each plugin is behind a dynamic `import()` in the vendored entry and joins a format only when `bundledPluginsFor(lang, src)` names it:
  - java, php, shell: their own plugin;
  - Markdown: all three, because prettier formats fenced `java`, `php` and `sh` blocks through them;
  - JS/TS, HTML and Vue: all three too, but only when the source contains the word `md` or `markdown`. prettier formats Markdown embedded there (`md` tagged templates, `<script type="text/markdown">`, `lang="markdown"` blocks) and the fences inside it; a source naming neither word cannot embed any. A superset check: a stray variable `md` only loads them needlessly;
  - JSON, YAML, CSS, SCSS, LESS, GraphQL: none.
- Why: a server start evaluates none of them, which keeps mvdan-sh's GopherJS runtime and java's `Parser.init()` wasm load off the start path (about 60 to 120 ms and 10 MB RSS on the former single-file server, measured before 0.19.0), and a plain JS/TS/HTML/Vue file never pays the trio's first load (about 90 ms then; the first `.ts` format went from 80 to 180 ms while every JS/TS format loaded the trio).
- Do not make them eager, do not drop Markdown's trio (a fenced `sh` block inside a Markdown host silently stopped formatting between 0.18.0's lazy loading and the test that pins it), and do not drop the token check.
- `tests/build.test.ts` checks the behaviour in a child process: importing the built modules and formatting a plain TypeScript file reads no wasm file and adds no global; a shell and a java format do.

## The `unhandledRejection` guard

- prettier-plugin-java starts `Parser.init()` at module scope. With a missing or corrupt wasm file that promise rejects with nothing attached, which ends a node process (exit 1, seen in the former repository) and with it formatting for every language.
- `prettier.ts` therefore installs a process-level `unhandledRejection` handler at import that writes one stderr line (stdout is the JSON-RPC channel). The price: an unrelated unhandled rejection is reported instead of fatal, which is the right trade for a hook whose contract is to fail open. `tests/bundled-plugins.test.ts` asserts the handler is installed.

## `.prettierignore` is the only ignore source

- `prettier --write <file>` filters even a named file through `--ignore-path`, by default `[.gitignore, .prettierignore]`. `isPrettierIgnored` passes only `<base>/.prettierignore`.
- Deliberately no CLI parity: "not tracked by git" and "must not be reformatted" are different questions. A gitignored file that is not prettierignored (a `dist/` bundle, generated sources) is formatted on purpose. Do not restore `.gitignore`.
- `getFileInfo` does not discover ignore files by itself (no `ignorePath` gives `ignored: false`, checked in the former repository), so the path is passed, joined to the file's base; a missing file is tolerated and any error means "not ignored".
- prettier alone decides whether a path matches. Do not hand-roll a matcher: negation, `**`, anchoring, directory-only patterns and escapes would regress silently.
- `.prettierignore` opts out of the prettier languages only. For a CLI language the opt-out stays "do not install the tool", as it was when those ran after the write.
- Server-side template dialects that only look like HTML (Twig, Blade, ERB) are not HTML: the README points users at `.prettierignore` for them.
