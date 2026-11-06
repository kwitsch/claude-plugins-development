// Converts a plugin's package.json (the only manifest source) into its Claude Code plugin manifest,
// plugin/.claude-plugin/plugin.json. Pure (no I/O): build-plugin.mts writes the result, tests import it.

/** Manifest keys package.json carries as top-level npm fields; `claudePlugin` must not repeat them. */
const TOP_LEVEL = ["name", "version", "description", "author", "keywords"] as const;

/**
 * Whether a value is a plain JSON object (not null, not an array).
 *
 * @param v - Any parsed JSON value.
 * @returns True for an object that is neither null nor an array.
 */
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Claude Code plugin manifest built from a plugin's package.json. Throws on invalid input.
 *
 * @remarks
 * Copies `name`, `version`, `description` (required non-empty strings), `author` (optional object with a
 * non-empty string `name`) and `keywords` (optional string array), then every key of the required
 * `claudePlugin` object (plugin-only manifest fields such as `userConfig`) verbatim. Other package.json keys
 * (`private`, `type`, `scripts`, `devDependencies`, …) are never copied. Absent optional keys are `undefined`,
 * which `JSON.stringify` drops.
 *
 * @param pkg - Parsed package.json of the plugin.
 * @returns The manifest, keys in the order name, version, description, author, keywords, then the
 *   `claudePlugin` keys in source order.
 */
export function pluginManifest(pkg: Record<string, unknown>): Record<string, unknown> {
  for (const k of ["name", "version", "description"] as const) {
    const v = pkg[k];
    if (typeof v !== "string" || v === "") throw new Error(`package.json: missing "${k}"`);
  }
  const { author, keywords, claudePlugin } = pkg;
  if (author !== undefined && !(isObject(author) && typeof author.name === "string" && author.name !== "")) {
    throw new Error("package.json: \"author\" must be an object with a \"name\"");
  }
  if (keywords !== undefined && !(Array.isArray(keywords) && keywords.every((k: unknown) => typeof k === "string"))) {
    throw new Error("package.json: \"keywords\" must be an array of strings");
  }
  // claudePlugin marks the package as a plugin (CI detects plugins by it), so it is required, `{}` at least
  if (!isObject(claudePlugin)) throw new Error("package.json: \"claudePlugin\" must be an object (`{}` at least)");
  const extra = claudePlugin;
  // one source per field: a manifest key lives either top-level or in claudePlugin, never both
  for (const k of TOP_LEVEL) {
    if (Object.hasOwn(extra, k)) throw new Error(`package.json: claudePlugin.${k} duplicates a top-level field`);
  }
  return { name: pkg.name, version: pkg.version, description: pkg.description, author, keywords, ...extra };
}
