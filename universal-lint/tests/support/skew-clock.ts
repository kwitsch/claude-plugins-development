// Preloaded into a test's lint server (`node --import`): `Date.now()` runs ahead by the number of milliseconds in the file
// `$SKEW_FILE`, so a test ends a quiet-time hold by moving the clock instead of waiting for it (no wall-clock thresholds).
import { readFileSync } from "node:fs";

const file = process.env["SKEW_FILE"];
// the server's linter children must not load this preload (and their own `Date.now` stays real)
delete process.env["NODE_OPTIONS"];
if (file) {
  const real = Date.now.bind(Date);
  /**
   * The current offset in ms: the file's number, 0 while it is missing or empty.
   *
   * @returns The offset.
   */
  const skew = (): number => {
    try {
      return Number(readFileSync(file, "utf8")) || 0;
    } catch {
      return 0;
    }
  };
  Date.now = (): number => real() + skew();
}
