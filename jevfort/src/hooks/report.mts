/**
 * `/jev report` as Markdown tables: a summary, Jev vs Claude step by step, the take threshold, then effort routing and the
 * other decisions. Pure, so tests can feed it entries directly.
 *
 * @packageDocumentation
 */
import { head } from "./context.mjs";
import type { Entry } from "./log.mjs";

/** The take thresholds the threshold table shows. */
const THRESHOLDS = [0.6, 0.7, 0.8, 0.85, 0.9, 0.95];
/** How many compare rows the step table shows. */
const STEP_ROWS = 15;

/**
 * `n` of `of` as a percentage.
 *
 * @param n - The part.
 * @param of - The whole.
 * @returns `NN%`, or `—` when `of` is 0.
 */
const pct = (n: number, of: number): string => (of ? `${Math.round((n / of) * 100)}%` : "—");
/**
 * `v` when it is a number.
 *
 * @param v - Any value.
 * @returns The number or `undefined`.
 */
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
/**
 * `v` when it is a string.
 *
 * @param v - Any value.
 * @returns The string or `undefined`.
 */
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
/**
 * A probability with two decimals.
 *
 * @param v - The number.
 * @returns `0.00`, or `—` when undefined.
 */
const p2 = (v: number | undefined): string => (v === undefined ? "—" : v.toFixed(2));
/**
 * Escapes pipes for a GFM table cell; backslashes right before a pipe are doubled, else `\|` becomes `\\|`, an escaped backslash plus a column separator.
 *
 * @param s - The text.
 * @returns The text with every pipe escaped.
 */
export const escapePipes = (s: string): string => s.replace(/(\\*)\|/g, "$1$1\\|");
/**
 * A table cell: one line, pipes escaped, cut to `max`.
 *
 * @param s - The text.
 * @param max - The maximum length.
 * @returns The cell text.
 */
const cell = (s: string, max = 48): string => {
  const one = escapePipes(s.replace(/\s+/g, " ")).trim();
  return one.length > max ? `${head(one, max - 1)}…` : one;
};
/**
 * A text bar of `n` of `of`.
 *
 * @param n - The part.
 * @param of - The whole.
 * @param width - The bar width.
 * @returns The bar.
 */
const bar = (n: number, of: number, width = 10): string => {
  const filled = of ? Math.round((n / of) * width) : 0;
  return "█".repeat(filled) + "░".repeat(width - filled);
};

/**
 * `n` as two digits.
 *
 * @param n - The number.
 * @returns Zero-padded.
 */
const pad = (n: number): string => String(n).padStart(2, "0");
/**
 * The local calendar day of `d`.
 *
 * @param d - The date.
 * @returns `YYYY-MM-DD`.
 */
const day = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Local `HH:MM`, with `MM-DD` in front when not on the same day as `latest`.
 *
 * @param at - The entry's time.
 * @param latest - The newest entry's time.
 * @returns The time cell.
 */
export function when(at: number, latest: number): string {
  const d = new Date(at);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return day(d) === day(new Date(latest)) ? time : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

/** How one compared step went. */
export type Verdict = "match" | "differ" | "missed" | "both-claude";

/**
 * How one compared step went, at a given take threshold:
 * - Jev would take its action → `match` when Claude made the same call, else `differ`.
 * - Jev leaves it to Claude → `both-claude` when Claude used none of the listed actions (agreement), `missed` when
 *   Claude did use one.
 *
 * @param e - A `compare` entry.
 * @param threshold - The take threshold.
 * @returns The verdict.
 */
export function verdict(e: Entry, threshold: number): Verdict {
  const bestP = num(e.data?.bestP) ?? 0;
  const wouldTake = str(e.data?.best) !== undefined && bestP >= threshold;
  if (wouldTake) return e.data?.agree === true ? "match" : "differ";
  return e.data?.claudeUsedCandidate === true ? "missed" : "both-claude";
}

/** The mark of each verdict. */
const MARK: Record<Verdict, string> = { match: "✓ same", "both-claude": "✓ Claude", differ: "✗ differ", missed: "⚠ missed" };

/**
 * What Claude did, from the compare entry (short form for older entries).
 *
 * @param e - A `compare` entry.
 * @returns The summary cell.
 */
function claudeDid(e: Entry): string {
  const summary = str(e.data?.claudeSummary);
  if (summary) return summary;
  const tools = (e.data?.claude as string[] | undefined) ?? [];
  if (!tools.length) return "replied";
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(", ");
}

/**
 * The `/jev report` Markdown.
 *
 * @param log - Every logged entry, oldest first.
 * @param threshold - The take threshold in force.
 * @returns The report.
 */
export function buildReport(log: readonly Entry[], threshold: number): string {
  if (!log.length) return "**Jev pilot report:** the log is empty. Use Claude for a while and run `/jev report` again.";
  const of = (kind: Entry["kind"]) => log.filter((e) => e.kind === kind);
  const out: string[] = [];
  // Local time, like the table rows (`when`).
  const first = new Date(log[0].at);
  const since = `${day(first)} ${pad(first.getHours())}:${pad(first.getMinutes())}`;

  const takes = of("take");
  const taken = takes.filter((e) => e.applied);
  const compares = of("compare");
  const verdicts = compares.map((e) => verdict(e, threshold));
  const agreed = verdicts.filter((v) => v === "match" || v === "both-claude").length;
  const errored = of("outcome").filter((e) => e.data?.isError === true);
  // The route and the take of one step-0 batch carry the same request's time: count it once.
  const routed = new Set(of("route").map((e) => `${e.turnId}:${e.ms}`));
  const timed = log.filter((e) => !(e.kind === "take" && routed.has(`${e.turnId}:${e.ms}`))).map((e) => e.ms).filter((m): m is number => typeof m === "number");
  const avgMs = timed.length ? Math.round(timed.reduce((a, b) => a + b, 0) / timed.length) : undefined;

  out.push("## Jev pilot report");
  out.push(`_${log.length} log entries since ${since} · take threshold **${threshold}**_`);
  out.push("");
  out.push("| | |");
  out.push("|---|---|");
  out.push(`| Steps Jev took itself | **${taken.length}** (≈ ${taken.length} Claude requests saved${errored.length ? `, ${errored.length} failed` : ""}) |`);
  const bypassed = of("bypass").filter((e) => e.applied);
  out.push(`| Turns answered without Claude | **${bypassed.length}** (Jev's action + ${bypassed.length ? "Haiku" : "a small model"} summary) |`);
  out.push(`| Agreement with Claude | **${agreed} / ${compares.length}** (${pct(agreed, compares.length)}) |`);
  out.push(`| Jev latency | ${avgMs === undefined ? "—" : `${avgMs} ms average`} over ${timed.length} calls · ${of("error").length} errors |`);

  // Jev vs Claude, step by step.
  if (compares.length) {
    out.push("", `### Jev vs Claude, step by step${compares.length > STEP_ROWS ? ` (last ${STEP_ROWS})` : ""}`);
    const latest = log[log.length - 1].at;
    out.push("| Time | Request | Jev would | p | Claude did | |");
    out.push("|---|---|---|---|---|---|");
    compares.slice(-STEP_ROWS).forEach((e) => {
      const v = verdict(e, threshold);
      const best = str(e.data?.best);
      const jev = v === "match" || v === "differ" ? best! : `leave to Claude${best ? ` _(best: ${best})_` : ""}`;
      const p = num(e.data?.bestP);
      out.push(`| ${when(e.at, latest)} | ${cell(str(e.data?.request) ?? "—", 40)} | ${cell(jev, 56)} | ${p2(p)} | ${cell(claudeDid(e), 40)} | ${MARK[v]} |`);
    });
    out.push("", "_✓ same: Jev would make the same call · ✓ Claude: both leave it to Claude · ✗ differ: Jev would act differently · ⚠ missed: Claude used an action Jev had listed_");
  }

  // Take threshold.
  const scored = compares.filter((e) => num(e.data?.bestP) !== undefined);
  if (scored.length) {
    out.push("", "### Take threshold");
    out.push("| Threshold | Would take | Same call as Claude | |");
    out.push("|---|---|---|---|");
    for (const t of THRESHOLDS) {
      const hit = scored.filter((e) => num(e.data?.bestP)! >= t);
      const ok = hit.filter((e) => e.data?.agree === true).length;
      const current = Math.abs(t - threshold) < 1e-9;
      out.push(`| ${current ? `**${t.toFixed(2)} ← current**` : t.toFixed(2)} | ${hit.length} | ${pct(ok, hit.length)} | \`${bar(ok, hit.length)}\` |`);
    }
  }

  // Effort routing and the other decisions.
  const routes = of("route");
  const effortScores = routes.map((e) => num(e.data?.effortScore)).filter((s): s is number => s !== undefined);
  const avgOf = (xs: number[]) => (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2);
  const lowered = routes.filter((e) => e.data?.lowered === true);
  const raised = routes.filter((e) => e.data?.raised === true);
  out.push("", "### Decisions");
  out.push("| Decision | Checked | Result |");
  out.push("|---|---|---|");
  out.push(`| Effort routing | ${routes.length} turns | ${effortScores.length ? `avg effort score ${avgOf(effortScores)} (0 mechanical … 4 hardest)` : "avg effort score —"} · ${lowered.length} lowered, ${raised.length} raised, ${new Set([...lowered, ...raised].filter((e) => e.applied)).size} applied |`);
  const classified = of("classify");
  if (classified.length) {
    const kinds = new Map<string, number>();
    for (const e of classified) kinds.set(str(e.data?.kind) ?? "?", (kinds.get(str(e.data?.kind) ?? "?") ?? 0) + 1);
    const hinted = classified.filter((e) => (num(e.data?.hints) ?? 0) > 0);
    out.push(`| Prompt classifier | ${classified.length} prompts | ${[...kinds].map(([k, n]) => `${n} ${k}`).join(" · ")} · ${hinted.length} hinted, ${hinted.filter((e) => e.applied).length} applied |`);
  }
  const agents = of("agent");
  if (agents.length) {
    const switched = agents.filter((e) => e.data?.switched === true);
    out.push(`| Subagent type | ${agents.length} spawns | ${agents.filter((e) => e.data?.agree === true).length} agreed with Claude · ${switched.length} switched, ${switched.filter((e) => e.applied).length} applied |`);
  }
  const compacts = of("compact");
  if (compacts.length) {
    const sum = (k: string) => compacts.reduce((a, e) => a + (num(e.data?.[k]) ?? 0), 0);
    out.push(`| Compaction | ${compacts.length} runs | ${sum("items")} results scored · ${sum("keep")} kept in detail · ${sum("drop")} marked droppable |`);
  }

  const aborted = of("turn").filter((e) => e.data?.reason === "aborted").length;
  if (aborted) out.push("", `_${aborted} interrupted turn(s)._`);
  return out.join("\n");
}
