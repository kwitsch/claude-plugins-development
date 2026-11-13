---
name: bughunt-loop
description: Run the bughunt method of this repository as a Workflow loop on one plugin - rounds of parallel read-only reviewers with a new lens each round, every finding triaged and fixed with a failing-first test, commit and push per fix, until several rounds in a row find nothing new (or a round cap), then simplify, code-review and a learnings pass. Use when the user asks for an automated, repeated or looped bug hunt of a plugin.
argument-hint: "<plugin-name> [dryRounds=3] [maxRounds=20]"
---

# bughunt-loop

The loop form of the `bughunt` skill (`.claude/skills/bughunt/SKILL.md`): read it first, its method, rules and "What to claim" apply unchanged. The first argument is the plugin directory name (stop with one line if `<plugin>/package.json` does not exist); optional `dryRounds` (default 3) and `maxRounds` (default 20).

The user's request for this skill is the opt-in for the Workflow tool (load `workflow-authoring` first if it is not loaded).

## Start: worktree and branch

First action, before reading anything: check whether the session already is in a linked git worktree (`git rev-parse --git-dir` ends in `/worktrees/<name>`, or `--git-common-dir` differs from `--git-dir`). If not, call `EnterWorktree` (load it via ToolSearch if deferred) with `name: "bughunt-<plugin>"` to switch into a new one, then `git switch -c fix/<plugin>-bughunt-<YYYY-MM-DD>` (one branch and one draft PR for the whole run). In an existing linked worktree only create that branch when the current one has no commits of its own. Never nest. Note the worktree's absolute path and today's date: both go into the workflow `args`.

## Scout (inline, before the Workflow)

Split the plugin into areas as in `bughunt` (protocol/server, core logic, scripts/skills, hooks wiring + docs; fewer for a small plugin) and note per area the files. The script cannot read the file system, so this goes into `args.areas` as `[{ name, files }]`.

## Run

`Workflow` with the script below, `args = { plugin, worktree, date, areas, dryRounds, maxRounds }`.

- **Round**: one read-only reviewer per area in parallel (`opus`/`high`), each with the round's lens, the list of keys and titles already found, and the rule "report only CONFIRMED defects with a repro and its output". The lenses rotate: newest diff first, then interactions between fixes, TOCTOU, coarse cache keys, slow file systems and odd names/encodings, resource leaks, fail-open paths, docs contradicting code, tests that cannot fail.
- **Fix** (sequential, one agent per new finding, `opus`/`high`): re-run the repro, refute or fix the root cause once in the shared code, a test that fails without the fix, build, `pnpm lint`, plugin tests, then commit and push. The first fix bumps `<plugin>/package.json` once per branch.
- **Stop**: `dryRounds` rounds in a row without a confirmed new finding (refuted claims do not count as new), or `maxRounds`, or a blocked fix. The reason is returned and reported; a clean stop is never reported as "no bugs".
- **Close** (when anything was fixed): one agent runs `/simplify`, `/code-review high --fix`, build, lint, tests, then the learnings pass of `bughunt` ("Close: learnings"); commit and push, clean tree, head equal to its upstream.

No agent narrates between tool calls (no human reads it); the structured results are all that comes back.

## Finish

`gh pr view` first; when the branch has no PR, `gh pr create --draft`, title `<plugin>: bug hunt (<n> fixes, <r> rounds)`, body = per-round table (lens, findings, fixed, refuted) and what stayed unexercised. No attribution lines. Report the PR URL, the stop reason and the limits of the hunt.

## Workflow script

```js
export const meta = {
  name: 'bughunt-loop',
  description: 'Looped bug hunt on one plugin: reviewers per area, fix per finding, stop after rounds without new findings',
  phases: [
    { title: 'Hunt', detail: 'read-only reviewers per area, parallel' },
    { title: 'Fix', detail: 'one fixer per new finding, sequential' },
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
        properties: { key: { type: 'string' }, title: { type: 'string' }, severity: { enum: ['high', 'medium', 'low'] }, repro: { type: 'string' }, fix: { type: 'string' } },
        required: ['key', 'title', 'repro'],
      },
    },
    checked: { type: 'string' },
  },
  required: ['findings', 'checked'],
}
const FIX = { type: 'object', properties: { verdict: { enum: ['fixed', 'refuted', 'blocked'] }, commit: { type: 'string' }, summary: { type: 'string' } }, required: ['verdict', 'summary'] }
const CLOSE = { type: 'object', properties: { status: { enum: ['clean', 'fixed', 'blocked'] }, summary: { type: 'string' } }, required: ['status', 'summary'] }
const { plugin, worktree, date, areas } = args
const dryRounds = args.dryRounds ?? 3
const maxRounds = args.maxRounds ?? 20
const LENSES = [
  'the newest diff of this branch and the history of the last fixes',
  'interactions between earlier fixes and regressions they introduced',
  'TOCTOU, races and symlink swaps',
  'caches keyed too coarsely, stale state, resource leaks',
  'slow or unusual file systems, odd file names and encodings',
  'fail-open paths and missing error handling at trust boundaries',
  'docs, README and rules contradicting the code; tests that cannot fail',
]

// No human reads the agents' text: no narration between tool calls, only the structured result.
const QUIET = '\n\nNo narration: no text between tool calls, no plans, no progress notes, no recap. Call tools silently and end with the structured result only.'
const run = (prompt, opts) => agent(prompt + QUIET, opts)

const huntPrompt = (a, lens, seen) => `Bug hunt on plugin "${plugin}", area "${a.name}" (files: ${a.files}), in the git worktree ${worktree}. READ-ONLY on the repository; scratch files go under the session scratchpad. Stay in the worktree.
Lens of this round: ${lens}. Read .claude/skills/bughunt/SKILL.md and ${plugin}/CLAUDE.md first.
Already found (do not report again): ${seen.length ? seen.map((s) => `${s.key} (${s.title})`).join('; ') : 'none yet'}.
Use real tools (the built plugin/ output, real git/node, the test stub) instead of reading alone. Report ONLY CONFIRMED defects: each with a stable key (file:symbol:short-slug), title, severity, the repro and its output, and a minimal fix. High bar: no style, speculation or documented limitations. If nothing is confirmed return an empty list and say in "checked" what you checked.`

const fixPrompt = (f, first) => `Triage and fix this reported defect of plugin "${plugin}" in the git worktree ${worktree} (stay there; run git and pnpm from its root).
Finding ${f.key}: ${f.title}. Repro: ${f.repro}. Suggested fix: ${f.fix ?? 'none'}.
1. Re-run the repro yourself. Not reproducible or a documented limit: verdict refuted, change nothing.
2. Otherwise fix the root cause once in ${plugin}/src (shared code, after grepping every caller), never in plugin/**/*.mjs. Add a test that fails without the fix (revert the line to check).
3. \`pnpm --filter ${plugin} build\`, \`pnpm lint\`, \`pnpm --filter ${plugin} test\` until green; read the output.
${first ? `4. First fix of the branch: bump ${plugin}/package.json version once (only if \`git diff origin/main -- ${plugin}/package.json\` shows none), then rebuild.\n` : ''}5. \`git add\` what you changed, commit ("${plugin}: fix ${f.key}", no Co-Authored-By), \`git push -u origin HEAD\`.
Return verdict fixed|refuted|blocked (blocked: cannot be made green; commit nothing broken), the commit sha and one sentence.`

const closePrompt = () => `Close the bug hunt of plugin "${plugin}" in the git worktree ${worktree} (stay there).
1. Skill "simplify" once on the branch changes, apply its fixes. 2. Skill "code-review" with args "high --fix" (never max). 3. \`pnpm --filter ${plugin} build\`, \`pnpm lint\`, \`pnpm --filter ${plugin} test\` until green.
4. Learnings pass: follow "Close: learnings" in .claude/skills/bughunt/SKILL.md for the defect classes of this hunt: ${args.summary}. Only general facts go into .claude/rules/*.md (with paths:) or .claude/skills/.
5. \`git add\`, commit ("${plugin}: bug hunt review and learnings", no Co-Authored-By), \`git push\`; then \`git status --short\` must be empty and \`git rev-parse HEAD\` equal \`git rev-parse @{u}\`, else commit and push again.
Return status clean|fixed|blocked and one sentence.`

const seen = []
const rounds = []
let dry = 0
let fixed = 0
let stop = 'maxRounds'
for (let round = 1; round <= maxRounds; round++) {
  const lens = LENSES[(round - 1) % LENSES.length]
  const reports = await parallel(areas.map((a) => () => run(huntPrompt(a, lens, seen), { label: `r${round}:${a.name}`, phase: 'Hunt', model: 'opus', effort: 'high', schema: FINDINGS })))
  const fresh = []
  for (const f of reports.filter(Boolean).flatMap((r) => r.findings)) {
    if (seen.some((s) => s.key.toLowerCase() === f.key.toLowerCase())) continue
    seen.push({ key: f.key, title: f.title })
    fresh.push(f)
  }
  let roundFixed = 0
  let blocked = false
  for (const f of fresh) {
    const r = await run(fixPrompt(f, fixed === 0), { label: `r${round}:${f.key}`, phase: 'Fix', model: 'opus', effort: 'high', schema: FIX })
    if (!r || r.verdict === 'blocked') { blocked = true; log(`${f.key}: blocked`); break }
    if (r.verdict === 'fixed') { roundFixed++; fixed++ }
  }
  rounds.push({ round, lens, found: fresh.length, fixed: roundFixed })
  log(`round ${round}: ${fresh.length} new, ${roundFixed} fixed`)
  if (blocked) { stop = 'blocked fix'; break }
  dry = roundFixed === 0 ? dry + 1 : 0
  if (dry >= dryRounds) { stop = `${dryRounds} rounds without a confirmed new finding`; break }
}

let close = null
if (fixed > 0 && stop !== 'blocked fix') {
  args.summary = seen.map((s) => s.title).join('; ')
  close = await run(closePrompt(), { label: 'close', phase: 'Close', model: 'opus', effort: 'high', schema: CLOSE })
}
return { stop, rounds, fixed, close, seen }
```
