// Types of the vendored bundle `plugin/mcp/vendor/index.mjs`, which `scripts/vendor.ts` builds from
// `scripts/vendor-entry.ts`. Sources import it as `./vendor/index.js`; this file is not built.

export * as prettier from "prettier";

/**
 * Loads prettier-plugin-java.
 *
 * @returns The plugin's module namespace.
 */
export declare const loadJava: () => Promise<unknown>;

/**
 * Loads `@prettier/plugin-php`.
 *
 * @returns The plugin's module namespace.
 */
export declare const loadPhp: () => Promise<unknown>;

/**
 * Loads prettier-plugin-sh together with the Go runtime its wasm parser needs.
 *
 * @returns The plugin's module namespace.
 */
export declare const loadShell: () => Promise<unknown>;
