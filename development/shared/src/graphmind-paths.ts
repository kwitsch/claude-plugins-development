/**
 * Where graphmind-helper looks for the graphmind binary.
 *
 * @packageDocumentation
 */

/**
 * The directories to look for the graphmind binary in, as the setup scripts do: absolute PATH entries, then
 * `~/.graphmind/bin`, `~/.local/bin` and `/usr/local/bin`. Shared by the module and the MCP wrapper.
 *
 * @param pathVar - The PATH value.
 * @param home - The home directory, `undefined` when unknown.
 * @param delimiter - The PATH delimiter.
 * @returns The directories without a trailing slash.
 */
export function binaryDirs(pathVar: string | undefined, home: string | undefined, delimiter = ":"): string[] {
  const dirs = (pathVar ?? "").split(delimiter).filter((d) => d.startsWith("/"));
  if (home) dirs.push(`${home}/.graphmind/bin`, `${home}/.local/bin`);
  dirs.push("/usr/local/bin");
  return dirs.map((d) => d.replace(/(.)\/+$/, "$1")); // keep "/" itself: "" would make the binary path relative
}
