---
name: bughunt
description: Run a structured bug hunt on a plugin in this repository as a Workflow - rounds with one rotating hunt lens each and parallel read-only hunters per area, every finding confirmed by an independent verifier (opus) before a fixer (model chosen by the verifier) fixes it with a test that fails without the fix, round cap and no-finding counter, then simplify, code-review and a learnings pass. Use when the user asks for a bug hunt, a deep review, "find all bugs", an automated, repeated or looped hunt, or a final verification of a plugin before merge.
argument-hint: "<plugin-name> [maxRounds=10] [noFinding=3]"
---

# bughunt

Worked out on the dprint plugin (16 rounds, about 40 confirmed defects). The method matters more than the number of rounds. The first argument is the plugin directory name (stop with one line if `<plugin>/package.json` does not exist); optional `maxRounds` (default 10) and `noFinding` (default 3), both counted over the rounds of the whole hunt.

The user's request for this skill is the opt-in for the Workflow tool (load `workflow-authoring` first if it is not loaded).

## Pipeline

**Hunt** (read-only, `sonnet`) → **Verify** (one verifier per finding, `opus`/`medium` unless the hunter classified the finding with `verifyModel`/`verifyEffort`) → **Fix** (model and effort chosen by the verifier from the effort the fix needs).

- A hunter's finding is only a claim. It goes to Fix only after a verifier reproduced it independently and confirmed it; a refuted finding is dropped and stays in the "already found" list so no hunter reports it again.
- Verify also rates the fix: `sonnet` for a local, well-understood change; `opus` for a cross-cutting, subtle or risky one (concurrency, caches, protocol), with effort `low|medium|high`.
- **One lens per round.** The lenses rotate round by round; the hunters of a round are one per area, all on that round's lens, so a round costs as many hunt jobs as there are areas. A round counts as _no finding_ when no finding was confirmed by a verifier (empty report, all refuted, or a failed hunter or verifier); a confirmed finding resets the counter. The hunt ends after `noFinding` no-finding rounds in a row, after `maxRounds` rounds, or on a blocked fix.

## jev-api first

The skill and every workflow agent use the jev-api tools (`mcp__jev-api__batch`, `choice`, `noul`, `score`; load them via ToolSearch if deferred) before own reasoning for decisions that fit options, a rating or yes/no: hunters classify `severity`, `verifyModel` and `verifyEffort` and check whether a finding duplicates one already found (`noul`); verifiers rate the fix (`fixModel`, `fixEffort`) and whether a claim is a documented limit or style; fixers and the closer decide yes/no questions such as "is this test failure related to my change". Several questions about one text go in one `batch`. Own reasoning replaces the answer on low confidence or a failed call. jev-api never replaces a repro, a test run or reading the code: facts are measured, only classifications and yes/no go to jev-api.

## Start: worktree and branch

First action, before reading anything: check whether the session already is in a linked git worktree (`git rev-parse --git-dir` ends in `/worktrees/<name>`, or `--git-common-dir` differs from `--git-dir`). If not, call `EnterWorktree` (load it via ToolSearch if deferred) with `name: "bughunt-<plugin>"`, then `git switch -c fix/<plugin>-bughunt-<YYYY-MM-DD>` (one branch and one draft PR for the whole run). In an existing linked worktree only create that branch when the current one has no commits of its own. Never nest. Note the worktree's absolute path and today's date: both go into the workflow `args`. A pure review request stays read-only (pass `fix: false`: Hunt and Verify only, verified findings are reported), but the scratch files and the checkout still belong in the worktree.

## Scout (inline, before the Workflow)

Split the plugin into areas (protocol/server, core logic, scripts/skills, hooks wiring + docs; fewer for a small plugin) and note per area the files. The script cannot read the file system, so this goes into `args.areas` as `[{ name, files }]`.

Scout also sets the hunter model and effort **per hunt lens** (the lenses are listed under Run), by how hard that lens is to hunt in this plugin: `sonnet` for lenses that are mostly reading and grepping (docs against code, fail-open paths in a small plugin), `opus` for those that need deep reasoning (races, cache invalidation, interactions between fixes); effort `medium` or `high`. Ask the jev-api tools first (`choice` for the model, `score` for the effort, one `batch` per lens). Pass them as `args.lenses = [{ lens, model, effort }]` using the lens texts below verbatim; a lens left out runs `sonnet`/`medium`.

## Run

`Workflow` with the script below, `args = { plugin, worktree, date, areas, lenses, maxRounds, noFinding, fix }`.

- **Hunt**: one read-only hunter per area in parallel, all on the round's lens (model and effort of that lens from Scout, default `sonnet`/`medium`), each with the lens, the keys and titles already found, and the rule "report only defects you reproduced, with the repro and its output". Brief hunters to use real tools (real dprint/git/node, the built `plugin/` output, the test stub) instead of reading alone, and "high bar: no style, speculation or documented limitations".
- **Verify**: one verifier per new finding, in parallel, model and effort from the finding's `verifyModel`/`verifyEffort` set by the hunter (default `opus`/`medium`); it re-runs the repro itself, reads the code, refutes documented limits and style, and rates the fix.
- **Fix** (sequential, one agent per confirmed finding, model and effort from the verifier): fix the root cause once in the shared code, add a test that fails without the fix (revert the line to check; a regression test that passes on the old code proves nothing), build, `pnpm lint`, plugin tests, commit and push. The first fix bumps `<plugin>/package.json` once per branch.
- **Lenses**, rotating in this order, one per round (the newest fix is the most likely place for the next defect: three rounds in a row found a regression of the previous fix): newest diff and the last fixes; interactions between fixes; TOCTOU, races and symlink swaps; caches keyed too coarsely, stale state, leaks; per-turn or per-session caches and buffers added for speed (every event that must drop or flush them, `.claude/rules/hook-caches-and-tests.md`); slow or unusual file systems, odd names and encodings; fail-open paths and missing error handling at trust boundaries; docs contradicting code and tests that cannot fail.
- **Close** (when anything was fixed): one agent runs `/simplify`, `/code-review high --fix`, build, lint, tests, then the learnings pass below; commit and push, clean tree, head equal to its upstream.

No agent narrates between tool calls (no human reads it); the structured results are all that comes back.

## Also do (inline, around the Workflow)

- **Tests audit**: revert each change one at a time in a scratch copy and see whether any test fails; add what is missing. Check temp dirs, env restore (`PATH`/`HOME`/other env in `finally`), leaked processes, timing thresholds (`>= 290` for a 300 ms timer), flakiness over 5 runs and `--sequence.shuffle`. A negative test whose cases all run in a world where an earlier gate already returns nothing cannot fail: give each case a world where only its own gate blocks. A selection rule (which of several candidates wins) needs a test with several candidates. Every flag on a regex (`m`, `i`) and every TTL or reset branch gets a test that fails without it. Isolate user-level config of external tools (`HOME`, `XDG_CONFIG_HOME`, tool env such as `YAMLLINT_CONFIG_FILE`): a test that passes in CI fails on a machine with `~/.config/<tool>`.
- **Randomized test** for the central invariant, seeded (mulberry32) so it is deterministic; run a bigger independent fuzz against the real tool once.
- **Docs audit**: every number, default, limit, env var and event name in README, rules and docs must match the source. A claim about what an external tool does ("never edits X", "writes only Y") is checked by running it under a temp `HOME` and `CLAUDE_CONFIG_DIR` and listing what it wrote; after any fix that changes a path or env var, grep the README for the old one.
- **Live checks** with the `live-verify` skill for the flows the tests cannot cover.
- **Final gate**: the repository's `/code-review high` on the whole branch (the Close step does it), then CI green on the head commit (`gh pr checks`).

## Close: learnings

At the end of the hunt, before the final report, check what the hunt taught that holds beyond this plugin:

1. List the confirmed defect classes and the Claude Code / tool behaviours you verified (compare with `.claude/rules/hook-file-safety.md`, `.claude/rules/claude-code-hook-facts.md`, `.claude/rules/plugin-docs-tasks.md` and the other rules and skills).
2. For each, decide: new general fact or defect class, correction of an existing rule or skill, or plugin-specific (stays in the plugin's `docs/` and rules). Only what other plugins of this repository can use, written generally (no plugin names in the rule text except as the source), goes into `.claude/rules/*.md` (with `paths:`) or `.claude/skills/`.
3. Apply the additions and corrections in the same PR, say in one line which rules or skills changed (or that nothing new qualified).

## Finish

`gh pr view` first; when the branch has no PR (and `fix` is not false), `gh pr create --draft`, title `<plugin>: bug hunt (<n> fixes, <r> rounds)`, body = per-round table (lens, found, confirmed, refuted, fixed), the stop reason and what stayed unexercised. No attribution lines. Bump the version once per PR. Report the PR URL, the stop reason and the limits of the hunt.

## What to claim

Never claim "no bugs". A stop after clean rounds only means those rounds found nothing; earlier clean rounds were repeatedly followed by new defects. Report: what was checked, what was fixed, which limits stay unexercised and why (for example a downloaded installer that auto mode will not run, a mount that was not available).

## Session mechanics learned

- A worktree-isolated session refuses compound commands (`cd x && git ...`, long pipelines, heredocs with git): put multi-step edits into a small node/python script under the scratchpad and run it with one plain command; run git/pnpm from the worktree root.
- Edit big literal blocks with a node script that throws when the anchor text is missing (`replace` silently doing nothing is the failure mode).
- Agents that run `claude` with `--dangerously-skip-permissions` are denied by auto mode; run nested `claude -p` yourself with `--allowedTools` narrowed instead.
- Do not run a downloaded script that auto mode refuses, and do not work around the refusal; read downloaded scripts first (the dprint installer runs `pkill -9 dprint`).

## Workflow script

```js
export const meta = {
  name: 'bughunt',
  description: 'Bug hunt on one plugin: one rotating lens per round, hunters per area, verifier per finding, fixer chosen by the verifier, round and no-finding caps',
  phases: [
    { title: 'Hunt', detail: 'read-only hunters per area for the round lens, parallel' },
    { title: 'Verify', detail: 'one verifier per finding, parallel' },
    { title: 'Fix', detail: 'one fixer per confirmed finding, sequential' },
    { title: 'Close', detail: 'simplify, code-review, learnings' },
  ],
}

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: { key: { type: 'string' }, title: { type: 'string' }, severity: { enum: ['high', 'medium', 'low'] }, verifyModel: { enum: ['sonnet', 'opus'] }, verifyEffort: { enum: ['low', 'medium', 'high'] }, repro: { type: 'string' }, fix: { type: 'string' } },
        required: ['key', 'title', 'repro'],
      },
    },
    checked: { type: 'string' },
  },
  required: ['findings', 'checked'],
}
const VERIFY = {
  type: 'object',
  properties: {
    verdict: { enum: ['confirmed', 'refuted'] },
    reason: { type: 'string' },
    fixModel: { enum: ['sonnet', 'opus'] },
    fixEffort: { enum: ['low', 'medium', 'high'] },
  },
  required: ['verdict', 'reason'],
}
const FIX = { type: 'object', properties: { verdict: { enum: ['fixed', 'refuted', 'blocked'] }, commit: { type: 'string' }, summary: { type: 'string' } }, required: ['verdict', 'summary'] }
const CLOSE = { type: 'object', properties: { status: { enum: ['clean', 'fixed', 'blocked'] }, summary: { type: 'string' } }, required: ['status', 'summary'] }
const { plugin, worktree, areas } = args
const maxRounds = args.maxRounds ?? 10
const noFinding = args.noFinding ?? 3
const doFix = args.fix !== false
const LENSES = [
  'the newest diff of this branch and the history of the last fixes',
  'interactions between earlier fixes and regressions they introduced',
  'TOCTOU, races and symlink swaps',
  'caches keyed too coarsely, stale state, resource leaks',
  'per-turn or per-session caches and buffers added for speed: every event that must drop or flush them',
  'slow or unusual file systems, odd file names and encodings',
  'fail-open paths and missing error handling at trust boundaries',
  'docs, README and rules contradicting the code; tests that cannot fail',
]

// No human reads the agents' text: no narration between tool calls, only the structured result.
const QUIET = '\n\nNo narration: no text between tool calls, no plans, no progress notes, no recap. Call tools silently and end with the structured result only.'
// Classifications and yes/no go to the jev-api tools first; facts (repro, tests, code) are measured, never asked.
const JEV = '\n\nFor decisions that fit options, a rating or yes/no (severity, effort, duplicate of an already found finding, documented limit or style, test failure unrelated to your change) call the jev-api tools first (mcp__jev-api__batch for several questions about one text; load them via ToolSearch if deferred) and use your own reasoning only on low confidence or a failed call. Never use them instead of a repro, a test run or reading the code.'
const run = (prompt, opts) => agent(prompt + JEV + QUIET, opts)

const huntPrompt = (a, lens, seen) => `Bug hunt on plugin "${plugin}", area "${a.name}" (files: ${a.files}), in the git worktree ${worktree}. READ-ONLY on the repository; scratch files go under the session scratchpad. Stay in the worktree.
Lens of this round: ${lens}. Read .claude/skills/bughunt/SKILL.md and ${plugin}/CLAUDE.md first.
Already found (do not report again): ${seen.length ? seen.map((s) => `${s.key} (${s.title})`).join('; ') : 'none yet'}.
Use real tools (the built plugin/ output, real git/node, the test stub) instead of reading alone. Report ONLY defects you reproduced: each with a stable key (file:symbol:short-slug), title, severity, verifyModel and verifyEffort (classify the verify job: sonnet/low for a simple, local repro; opus/high for subtle, concurrent or cross-cutting ones), the repro and its output, and a minimal fix. High bar: no style, speculation or documented limitations. A verifier will re-run every repro independently. If nothing is reproduced return an empty list and say in "checked" what you checked.`

const verifyPrompt = (f) => `Verify this claimed defect of plugin "${plugin}" in the git worktree ${worktree}. READ-ONLY on the repository; scratch files go under the session scratchpad. Stay in the worktree.
Finding ${f.key}: ${f.title}. Severity ${f.severity ?? 'n/a'}. Repro: ${f.repro}. Suggested fix: ${f.fix ?? 'none'}.
Re-run the repro yourself and read the code around it. Verdict refuted: not reproducible, a documented limit, style or speculation. Verdict confirmed: reproduced and a real defect.
For a confirmed finding rate the fix: fixModel sonnet for a local, well-understood change, opus for a cross-cutting, subtle or risky one (concurrency, caches, protocol, many callers); fixEffort low, medium or high by the work the fix and its test need.`

const fixPrompt = (f, first) => `Fix this verified defect of plugin "${plugin}" in the git worktree ${worktree} (stay there; run git and pnpm from its root).
Finding ${f.key}: ${f.title}. Repro: ${f.repro}. Suggested fix: ${f.fix ?? 'none'}. A verifier confirmed it: ${f.reason}.
1. Re-run the repro. If it does not reproduce after all: verdict refuted, change nothing.
2. Fix the root cause once in ${plugin}/src (shared code, after grepping every caller), never in plugin/**/*.mjs. Add a test that fails without the fix (revert the line to check).
3. \`pnpm --filter ${plugin} build\`, \`pnpm lint\`, \`pnpm --filter ${plugin} test\` until green; read the output.
${first ? `4. First fix of the branch: bump ${plugin}/package.json version once (only if \`git diff origin/main -- ${plugin}/package.json\` shows none), then rebuild.\n` : ''}5. \`git add\` what you changed, commit ("${plugin}: fix ${f.key}", no Co-Authored-By), \`git push -u origin HEAD\`.
Return verdict fixed|refuted|blocked (blocked: cannot be made green; commit nothing broken), the commit sha and one sentence.`

const closePrompt = () => `Close the bug hunt of plugin "${plugin}" in the git worktree ${worktree} (stay there).
1. Skill "simplify" once on the branch changes, apply its fixes. 2. Skill "code-review" with args "high --fix" (never max). 3. \`pnpm --filter ${plugin} build\`, \`pnpm lint\`, \`pnpm --filter ${plugin} test\` until green.
4. Learnings pass: follow "Close: learnings" in .claude/skills/bughunt/SKILL.md for the defect classes of this hunt: ${args.summary}. Only general facts go into .claude/rules/*.md (with paths:) or .claude/skills/.
5. \`git add\`, commit ("${plugin}: bug hunt review and learnings", no Co-Authored-By), \`git push\`; then \`git status --short\` must be empty and \`git rev-parse HEAD\` equal \`git rev-parse @{u}\`, else commit and push again.
Return status clean|fixed|blocked and one sentence.`

const seen = []
const lenses = LENSES.map((lens) => ({ model: 'sonnet', effort: 'medium', ...(args.lenses ?? []).find((x) => x.lens === lens), lens }))
const rounds = []
let fixed = 0
let blocked = false
let dry = 0
let stop = `maxRounds ${maxRounds}`

for (let round = 1; round <= maxRounds; round++) {
  // One lens per round, rotating; the areas hunt in parallel.
  const l = lenses[(round - 1) % lenses.length]
  const hunts = await parallel(areas.map((a) => () => run(huntPrompt(a, l.lens, seen), { label: `r${round}:${a.name}`, phase: 'Hunt', model: l.model, effort: l.effort, schema: FINDINGS })))
  const fresh = []
  for (const f of hunts.filter(Boolean).flatMap((r) => r.findings)) {
    if (seen.some((s) => s.key.toLowerCase() === f.key.toLowerCase())) continue
    seen.push({ key: f.key, title: f.title })
    fresh.push(f)
  }
  // Verify: one verifier per new finding, in parallel.
  const verdicts = await parallel(fresh.map((f) => () => run(verifyPrompt(f), { label: `r${round}:v:${f.key}`, phase: 'Verify', model: f.verifyModel ?? 'opus', effort: f.verifyEffort ?? 'medium', schema: VERIFY })))
  const confirmedNow = fresh.flatMap((f, i) => (verdicts[i]?.verdict === 'confirmed' ? [{ ...f, ...verdicts[i] }] : []))
  // Fix: sequential, model and effort chosen by the verifier.
  let roundFixed = 0
  if (doFix) {
    for (const f of confirmedNow) {
      const r = await run(fixPrompt(f, fixed === 0), { label: `r${round}:${f.key}`, phase: 'Fix', model: f.fixModel ?? 'sonnet', effort: f.fixEffort ?? 'medium', schema: FIX })
      if (!r || r.verdict === 'blocked') { blocked = true; log(`${f.key}: blocked`); break }
      if (r.verdict === 'fixed') { roundFixed++; fixed++ }
    }
  }
  rounds.push({ round, lens: l.lens, found: fresh.length, confirmed: confirmedNow.length, refuted: fresh.length - confirmedNow.length, fixed: roundFixed })
  log(`round ${round}: ${fresh.length} new, ${confirmedNow.length} confirmed, ${roundFixed} fixed`)
  if (blocked) { stop = 'blocked fix'; break }
  // No verifier-confirmed finding (empty report, all refuted, failed agent) is a no-finding round.
  dry = confirmedNow.length ? 0 : dry + 1
  if (dry >= noFinding) { stop = `${noFinding} rounds without a confirmed finding`; break }
}

let close = null
if (fixed > 0 && !blocked) {
  args.summary = seen.map((s) => s.title).join('; ')
  close = await run(closePrompt(), { label: 'close', phase: 'Close', model: 'sonnet', effort: 'medium', schema: CLOSE })
}
return { stop, rounds, fixed, close, seen }
```
