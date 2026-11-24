// Entry of the vendored bundle `plugin/mcp/vendor/index.mjs` (`bundles` in tsdown.config.ts): the one prettier of the
// server and its three third-party plugins. Sources import it as `./vendor/index.js`; the build keeps that import external.

export * as prettier from "prettier";

/**
 * Loads prettier-plugin-java (and its two wasm files beside the chunk).
 *
 * @returns The plugin's module namespace.
 */
export const loadJava = (): Promise<unknown> => import("prettier-plugin-java");

/**
 * Loads `@prettier/plugin-php`.
 *
 * @returns The plugin's module namespace.
 */
export const loadPhp = (): Promise<unknown> => import("@prettier/plugin-php");

/**
 * Loads prettier-plugin-sh. sh-syntax needs Go's `wasm_exec` runtime on `globalThis`; its own side-effect import is
 * tree-shaken (its `sideEffects` list names another file), so the exported subpath is imported here.
 *
 * @returns The plugin's module namespace.
 */
export const loadShell = (): Promise<unknown> => Promise.all([import("sh-syntax/vendors/wasm_exec.cjs"), import("prettier-plugin-sh")]).then(([, ns]) => ns);
