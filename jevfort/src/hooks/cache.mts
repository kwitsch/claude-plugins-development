/**
 * Prompt-cache countdown and the auto-compact decision (ported from HeyCubit/effortless). Pure: the timer, the
 * usage read and the `/compact` run live in `register.mts`.
 *
 * @packageDocumentation
 */

/** How long the prompt cache stays warm after the last request, by write lifetime. */
export const CACHE_TTL = { "5m": 5 * 60_000, "1h": 60 * 60_000 } as const;
/** A cache write lifetime. */
export type CacheTtl = keyof typeof CACHE_TTL;
/** The countdown turns yellow at this many minutes shown or fewer. */
export const CACHE_YELLOW_MIN = 20;
/** The countdown turns red at this many minutes shown or fewer. */
export const CACHE_RED_MIN = 5;

/** The usage fields of a response this module reads. */
type CacheUsage = {
  input_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
};

/**
 * The cache lifetime a response's writes got, when it says.
 *
 * @param usage - The response usage.
 * @returns `"1h"`, `"5m"`, or `undefined` when it wrote nothing or does not say.
 */
export function cacheTtlOf(usage: unknown): CacheTtl | undefined {
  const c = (usage as CacheUsage | null)?.cache_creation;
  if ((c?.ephemeral_1h_input_tokens ?? 0) > 0) return "1h";
  if ((c?.ephemeral_5m_input_tokens ?? 0) > 0) return "5m";
  return undefined;
}

/**
 * Whether most of the prompt came from the cache (it was still warm).
 *
 * @param usage - The response usage.
 * @returns True when more than half the prompt was read from the cache.
 */
export function mostlyCached(usage: unknown): boolean {
  const u = (usage ?? {}) as CacheUsage;
  const read = u.cache_read_input_tokens ?? 0;
  const all = read + (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  return all > 0 && read / all > 0.5;
}

/**
 * The lifetime a response implies, given the one known so far.
 *
 * @param usage - The response usage.
 * @param known - The lifetime assumed until now.
 * @param sinceLast - Milliseconds since the previous response, when there was one.
 * @returns The lifetime to use from now on.
 */
export function nextTtl(usage: unknown, known: CacheTtl, sinceLast: number | undefined): CacheTtl {
  // Read back after more than 5 minutes means the cache is the 1 hour one.
  const ttl = cacheTtlOf(usage) ?? (sinceLast !== undefined && sinceLast > CACHE_TTL["5m"] && mostlyCached(usage) ? "1h" : undefined);
  // A reply that wrote only a short 5-minute tail still reads the rest from the 1-hour cache: 5m never lowers 1h.
  return ttl && !(ttl === "5m" && known === "1h" && mostlyCached(usage)) ? ttl : known;
}

/**
 * Whole minutes left, rounded up: 1 means under a minute, 0 means cold.
 *
 * @param expires - When the cache goes cold (`0`: no response seen yet).
 * @param now - The time now.
 * @returns The minutes, or `null` before the first response.
 */
export function minutesLeft(expires: number, now: number): number | null {
  if (expires <= 0) return null;
  const left = expires - now;
  return left <= 0 ? 0 : Math.ceil(left / 60_000);
}

/**
 * The band's words for the time left.
 *
 * @param minutes - From {@link minutesLeft}, never `null`.
 * @returns `"cache 58m"`, `"cache <1m"` or `"cache cold"`.
 */
export function cacheLabel(minutes: number): string {
  return minutes <= 0 ? "cache cold" : minutes === 1 ? "cache <1m" : `cache ${minutes - 1}m`;
}

/**
 * The countdown's colour: none while there is time, yellow at 20 minutes or fewer, red at 5 or fewer, cyan once cold.
 *
 * @param minutes - From {@link minutesLeft}, never `null`.
 * @returns A colour name, or `undefined` for the dim default.
 */
export function cacheColor(minutes: number): string | undefined {
  if (minutes <= 0) return "cyan";
  const shown = minutes - 1;
  return shown > CACHE_YELLOW_MIN ? undefined : shown <= CACHE_RED_MIN ? "red" : "yellow";
}

/**
 * Whether the idle chat should be compacted now: auto-compact is on, the cache is cold (a compaction then rewrites
 * the cache anyway), the context is full enough, and it was not done for this cold period yet.
 *
 * @param minutes - From {@link minutesLeft}.
 * @param percent - The context fill in percent.
 * @param threshold - The `autoCompactPercent` option; 0 disables.
 * @param done - Whether this cold period was already compacted.
 * @returns True to run `/compact`.
 */
export function shouldAutoCompact(minutes: number | null, percent: number, threshold: number, done: boolean): boolean {
  return threshold > 0 && minutes === 0 && !done && percent >= threshold;
}
