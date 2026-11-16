---
name: bughunt
description: Run a structured bug hunt on a plugin in this repository as a Workflow - parallel read-only hunt jobs per lens and area, one dedupe job that merges the findings and keeps the lenses that found each, one verify job per finding that checks it per lens and picks the fix model, fix jobs from a queue with a parallel review job per finished fix (a rejected fix is queued again with the review notes), then simplify, code-review and a learnings pass. Use when the user asks for a bug hunt, a deep review, "find all bugs", an automated bug hunt, or a final verification of a plugin before merge.
argument-hint: "<plugin-name>"
---

# bughunt

Worked out on the dprint plugin (16 hand-run rounds, about 40 confirmed defects). The method matters more than the number of jobs. The argument is the plugin directory name (stop with one line if `<plugin>/package.json` does not exist). There are no rounds: the hunt runs once through the pipeline below.

The user's request for this skill is the opt-in for the Workflow tool (load `workflow-authoring` first if it is not loaded).

## Pipeline

**Hunt** (parallel) → **Dedupe** (one job) → **Verify** (parallel, one per finding) → **Fix** (queue, one job at a time) with a **Review** per finished fix (parallel to the next fix job).

- **Hunt**: one read-only hunter per lens and area, all in parallel. A hunter's finding is only a claim.
- **Dedupe**: when all hunt jobs are done, one job merges findings that describe the same defect. Every merged finding keeps the list of lenses that found it (computed by the script from the merged members, never by the model).
- **Verify**: one verifier per deduplicated finding, in parallel. It re-runs the repro of every lens that reported the finding and says per lens whether the finding is valid; it also decides whether the fix is done by `sonnet` or `haiku` (and the effort) by the work the fix needs. A finding with no valid lens is dropped.
- **Fix**: one fix job per finding with at least one valid lens, from a queue, one at a time (they share one worktree and one branch), with the model the verifier chose.
- **Review**: when a fix job is done, a review job (`opus`) examines that fix while the next fix job already runs. It approves, or rejects with notes; a rejected finding gets a new fix job with the notes at the **end** of the fix queue. A finding is rejected at most twice, then the fix is kept and reported as unresolved (a limit, so a reviewer and a fixer cannot loop forever).

## jev-api first

The skill and every workflow agent use the jev-api tools (`mcp__jev-api__batch`, `choice`, `noul`, `score`; load them via ToolSearch if deferred) before own reasoning for decisions that fit options, a rating or yes/no: hunters classify `severity`, `verifyModel` and `verifyEffort`; the dedupe job asks whether two findings describe the same defect (`noul`); verifiers rate the fix model and effort and whether a claim is a documented limit or style; fixers and the closer decide yes/no questions such as "is this test failure related to my change". Several questions about one text go in one `batch`. Own reasoning replaces the answer on low confidence or a failed call. jev-api never replaces a repro, a test run or reading the code: facts are measured, only classifications and yes/no go to jev-api.

## Start: worktree and branch

First action, before reading anything: check whether the session already is in a linked git worktree (`git rev-parse --git-dir` ends in `/worktrees/<name>`, or `--git-common-dir` differs from `--git-dir`). If not, call `EnterWorktree` (load it via ToolSearch if deferred) with `name: "bughunt-<plugin>"`, then `git switch -c fix/<plugin>-bughunt-<YYYY-MM-DD>` (one branch and one draft PR for the whole run). In an existing linked worktree only create that branch when the current one has no commits of its own. Never nest. Note the worktree's absolute path and today's date: both go into the workflow `args`. A pure review request stays read-only (pass `fix: false`: Hunt, Dedupe and Verify only, verified findings are reported), but the scratch files and the checkout still belong in the worktree.

## Scout (inline, before the Workflow)

Split the plugin into areas (protocol/server, core logic, scripts/skills, hooks wiring + docs; fewer for a small plugin) and note per area the files. The script cannot read the file system, so this goes into `args.areas` as `[{ name, files }]`.

Scout also picks the hunt lenses and sets the hunter model and effort **per lens** (the lens list is under Run), by how hard that lens is to hunt in this plugin: `sonnet` for lenses that are mostly reading and grepping (docs against code, fail-open paths in a small plugin), `opus` for those that need deep reasoning (races, cache invalidation, interactions between fixes); effort `medium` or `high`. Leave out a lens that cannot apply (no caches, no file system access). Ask the jev-api tools first (`choice` for the model, `score` for the effort, one `batch` per lens). Pass them as `args.lenses = [{ lens, model, effort }]` using the lens texts below verbatim; without `args.lenses` all lenses run `sonnet`/`medium`. The number of hunt jobs is lenses times areas, so a small plugin gets few areas.

## Run

`Workflow` with the script below, `args = { plugin, worktree, date, areas, lenses, fix }`.

- **Hunt**: one read-only hunter per lens and area, in parallel (model and effort of the lens from Scout), each with the lens and the rule "report only defects you reproduced, with the repro and its output". Brief hunters to use real tools (real dprint/git/node, the built `plugin/` output, the test stub) instead of reading alone, and "high bar: no style, speculation or documented limitations".
- **Dedupe**: one `sonnet` job gets all findings and returns groups of finding indexes that describe the same defect with one merged title, repro and fix; the script computes each group's lenses from its members and adds any finding the job left out as its own group.
- **Verify**: one verifier per deduplicated finding, in parallel, model and effort as the hunters classified the verify job (strongest of the merged findings, default `opus`/`medium`); for every lens of the finding it re-runs that lens's repro itself, reads the code and refutes documented limits and style; then it rates the fix (`sonnet` for a local, well-understood change, `haiku` for a mechanical one; effort `low|medium|high`, not passed to `haiku`).
- **Fix** (queue, sequential): re-run the repro, fix the root cause once in the shared code, add a test that fails without the fix (revert the line to check; a regression test that passes on the old code proves nothing), build, `pnpm lint`, plugin tests, commit and push. The first fix bumps `<plugin>/package.json` once per branch. A blocked fix is reported and the queue goes on.
- **Review** (`opus`, parallel to the next fix): read-only on the checkout, it reads the fix commit (`git show <sha>`), checks root cause versus symptom, that the test fails without the fix, other callers and regressions; to run something it uses a scratch copy outside the worktree. Approve or reject with concrete notes.
- **Lenses** (hunters run before any fix of this run, so these two read the branch's earlier commits): newest diff and the last fixes; interactions between fixes; TOCTOU, races and symlink swaps; caches keyed too coarsely, stale state, leaks; per-turn or per-session caches and buffers added for speed (every event that must drop or flush them, `.claude/rules/hook-caches-and-tests.md`); slow or unusual file systems, odd names and encodings; fail-open paths and missing error handling at trust boundaries; docs contradicting code and tests that cannot fail.
- **Close** (when anything was fixed): the fix jobs report the files they changed, and one agent works only on those files. It first checks (jev-api `noul`) whether the code changes are too small or too simple for a simplifier (only documentation, or about 30 changed code lines or fewer without new logic): then `/simplify` and `/code-review` are both skipped, otherwise `/simplify` runs on the changed code files and `/code-review <level> --fix` on them, the level (`low`, `medium`, `high`, `xhigh`, never `max`) chosen from the size and risk of those changes, not fixed at `high`. Build, lint and tests only when one of them changed something; then the learnings pass below; commit and push, clean tree, head equal to its upstream.

No agent narrates between tool calls (no human reads it); the structured results are all that comes back.

## Also do (inline, around the Workflow)

- **Tests audit**: revert each change one at a time in a scratch copy and see whether any test fails; add what is missing. Check temp dirs, env restore (`PATH`/`HOME`/other env in `finally`), leaked processes, timing thresholds (`>= 290` for a 300 ms timer), flakiness over 5 runs and `--sequence.shuffle`. A negative test whose cases all run in a world where an earlier gate already returns nothing cannot fail: give each case a world where only its own gate blocks. A selection rule (which of several candidates wins) needs a test with several candidates. Every flag on a regex (`m`, `i`) and every TTL or reset branch gets a test that fails without it. Isolate user-level config of external tools (`HOME`, `XDG_CONFIG_HOME`, tool env such as `YAMLLINT_CONFIG_FILE`): a test that passes in CI fails on a machine with `~/.config/<tool>`.
- **Randomized test** for the central invariant, seeded (mulberry32) so it is deterministic; run a bigger independent fuzz against the real tool once.
- **Docs audit**: every number, default, limit, env var and event name in README, rules and the plugin's wiki section (`development/wiki/plugins/<plugin>/`: index, TASKS.md, evaluations, design, notes) must match the source. A claim about what an external tool does ("never edits X", "writes only Y") is checked by running it under a temp `HOME` and `CLAUDE_CONFIG_DIR` and listing what it wrote; after any fix that changes a path or env var, grep the README for the old one.
- **Live checks** with the `live-verify` skill for the flows the tests cannot cover.
- **Final gate**: the repository's `/code-review high` on the whole branch (the Close step does it), then CI green on the head commit (`gh pr checks`).

## Close: learnings

At the end of the hunt, before the final report, check what the hunt taught that holds beyond this plugin:

1. List the confirmed defect classes and the Claude Code / tool behaviours you verified (compare with `.claude/rules/hook-file-safety.md`, `.claude/rules/claude-code-hook-facts.md`, `.claude/rules/claude-code-tool-hook-facts.md`, `.claude/rules/claude-code-skill-facts.md`, `.claude/rules/plugin-docs-tasks.md` and the other rules and skills).
2. For each, decide: new general fact or defect class, correction of an existing rule or skill, or plugin-specific (stays in the plugin's wiki section `development/wiki/plugins/<plugin>/`: a task in `tasks/` and `TASKS.md`, reasons in `design/`, other records in `notes/`, each listed in its `index.md`; format in `.claude/rules/plugin-docs-tasks.md`; and in its rules). Only what other plugins of this repository can use, written generally (no plugin names in the rule text except as the source), goes into `.claude/rules/*.md` (with `paths:`) or `.claude/skills/`.
3. Apply the additions and corrections in the same PR, say in one line which rules or skills changed (or that nothing new qualified).

## Finish

`gh pr view` first; when the branch has no PR (and `fix` is not false), `gh pr create --draft`, title `<plugin>: bug hunt (<n> fixes)`, body = per-finding table (key, lenses that found it, lenses verified, fix model, fix result, review result) and what stayed unexercised. No attribution lines. Bump the version once per PR. Report the PR URL and the limits of the hunt.

## What to claim

Never claim "no bugs". A hunt without confirmed findings only means these lenses found nothing in this pass; earlier clean passes were repeatedly followed by new defects. Report: what was checked (lenses and areas), what was fixed, which fixes stay unresolved after two rejections, which limits stay unexercised and why (for example a downloaded installer that auto mode will not run, a mount that was not available).

## Session mechanics learned

- A worktree-isolated session refuses compound commands (`cd x && git ...`, long pipelines, heredocs with git): put multi-step edits into a small node/python script under the scratchpad and run it with one plain command; run git/pnpm from the worktree root.
- Edit big literal blocks with a node script that throws when the anchor text is missing (`replace` silently doing nothing is the failure mode).
- Agents that run `claude` with `--dangerously-skip-permissions` are denied by auto mode; run nested `claude -p` yourself with `--allowedTools` narrowed instead.
- Do not run a downloaded script that auto mode refuses, and do not work around the refusal; read downloaded scripts first (the dprint installer runs `pkill -9 dprint`).

## Workflow script

```js
export const meta = {
  name: 'bughunt',
  description: 'Bug hunt on one plugin: parallel hunters per lens and area, dedupe, parallel verifiers, fix queue with a review per fix',
  phases: [
    { title: 'Hunt', detail: 'read-only hunters per lens and area, parallel' },
    { title: 'Dedupe', detail: 'merge findings, keep the lenses of each' },
    { title: 'Verify', detail: 'one verifier per finding, valid per lens, fix model', },
    { title: 'Fix', detail: 'fix queue, one job at a time, review per fix in parallel' },
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
const DEDUPE = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: { members: { type: 'array', items: { type: 'integer' } }, key: { type: 'string' }, title: { type: 'string' }, repro: { type: 'string' }, fix: { type: 'string' } },
        required: ['members', 'key', 'title', 'repro'],
      },
    },
  },
  required: ['groups'],
}
const VERIFY = {
  type: 'object',
  properties: {
    lenses: { type: 'array', items: { type: 'object', properties: { lens: { type: 'integer' }, valid: { type: 'boolean' }, reason: { type: 'string' } }, required: ['lens', 'valid', 'reason'] } },
    fixModel: { enum: ['sonnet', 'haiku'] },
    fixEffort: { enum: ['low', 'medium', 'high'] },
  },
  required: ['lenses'],
}
const FIX = { type: 'object', properties: { verdict: { enum: ['fixed', 'refuted', 'blocked'] }, commit: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } }, required: ['verdict', 'summary'] }
const REVIEW = { type: 'object', properties: { verdict: { enum: ['approve', 'reject'] }, notes: { type: 'string' } }, required: ['verdict', 'notes'] }
const CLOSE = { type: 'object', properties: { status: { enum: ['clean', 'fixed', 'blocked'] }, simplify: { type: 'string' }, reviewLevel: { type: 'string' }, summary: { type: 'string' } }, required: ['status', 'summary'] }
const { plugin, worktree, areas } = args
const doFix = args.fix !== false
const MAX_REJECTIONS = 2
const LENSES = [
  'the newest diff of this branch and the history of the last fixes',
  'interactions between earlier fixes and regressions they introduced',
  'TOCTOU, races and symlink swaps',
  'caches keyed too coarsely, stale state, resource leaks',
  'per-turn or per-session caches and buffers added for speed: every event that must drop or flush them',
  'slow or unusual file systems, odd file names and encodings',
  'fail-open paths and missing error handling at trust boundaries',
  'the plugin wiki section, README and rules contradicting the code; tests that cannot fail',
]
const lenses = args.lenses ?? LENSES.map((lens) => ({ lens, model: 'sonnet', effort: 'medium' }))

// No human reads the agents' text: no narration between tool calls, only the structured result.
const QUIET = '\n\nNo narration: no text between tool calls, no plans, no progress notes, no recap. Call tools silently and end with the structured result only.'
// Classifications and yes/no go to the jev-api tools first; facts (repro, tests, code) are measured, never asked.
const JEV = '\n\nFor decisions that fit options, a rating or yes/no (severity, effort, same defect as another finding, documented limit or style, test failure unrelated to your change) call the jev-api tools first (mcp__jev-api__batch for several questions about one text; load them via ToolSearch if deferred) and use your own reasoning only on low confidence or a failed call. Never use them instead of a repro, a test run or reading the code.'
const run = (prompt, opts) => agent(prompt + JEV + QUIET, opts)

const huntPrompt = (a, lens) => `Bug hunt on plugin "${plugin}", area "${a.name}" (files: ${a.files}), in the git worktree ${worktree}. READ-ONLY on the repository; scratch files go under the session scratchpad. Stay in the worktree.
Lens: ${lens}. Read .claude/skills/bughunt/SKILL.md and ${plugin}/CLAUDE.md first.
Use real tools (the built plugin/ output, real git/node, the test stub) instead of reading alone. Report ONLY defects you reproduced: each with a stable key (file:symbol:short-slug), title, severity, verifyModel and verifyEffort (classify the verify job: sonnet/low for a simple, local repro; opus/high for subtle, concurrent or cross-cutting ones), the repro and its output, and a minimal fix. High bar: no style, speculation or documented limitations. A verifier will re-run every repro independently. If nothing is reproduced return an empty list and say in "checked" what you checked.`

const dedupePrompt = (raw) => `Merge duplicate findings of a bug hunt on plugin "${plugin}". Findings (index, lens, key, title, repro, fix):
${raw.map((f, i) => `[${i}] lens ${f.lens} | ${f.key} | ${f.title}\n  repro: ${f.repro}\n  fix: ${f.fix ?? 'none'}`).join('\n')}
Group the indexes that describe the same root defect (same code, same failure, even if found by another lens or worded differently). Different defects in the same file stay separate groups. Every index belongs to exactly one group. For each group return its members, one key, one title, and the repro and fix of the best member (merge them when they complement each other). Read the code only where two findings are too close to tell apart. READ-ONLY on the repository, worktree ${worktree}.`

const verifyPrompt = (f) => `Verify this claimed defect of plugin "${plugin}" in the git worktree ${worktree}. READ-ONLY on the repository; scratch files go under the session scratchpad. Stay in the worktree.
Finding ${f.key}: ${f.title}. Severity ${f.severity ?? 'n/a'}. Suggested fix: ${f.fix ?? 'none'}.
It was reported by these lenses, each with its own repro:
${f.reports.map((r) => `- lens ${r.lens} (${lenses[r.lens].lens}): ${r.repro}`).join('\n')}
For EVERY lens above re-run its repro yourself and read the code around it. Return one entry per lens: valid true when reproduced and a real defect; valid false when not reproducible, a documented limit, style or speculation (with the reason).
If at least one lens is valid, also rate the fix: fixModel sonnet for a local change that needs judgment, haiku for a mechanical, well-understood one; fixEffort low, medium or high by the work the fix and its test need (not used for haiku).`

const fixPrompt = (job, first) => `Fix this verified defect of plugin "${plugin}" in the git worktree ${worktree} (stay there; run git and pnpm from its root).
Finding ${job.f.key}: ${job.f.title}. Repro: ${job.f.repro}. Suggested fix: ${job.f.fix ?? 'none'}. Verified for lenses: ${job.f.validLenses.join('; ')}.
${job.notes ? `A previous fix (commit ${job.prevCommit}) was REJECTED in review. Review notes: ${job.notes}\nBuild on or replace that commit as the notes demand.\n` : ''}1. Re-run the repro. If it does not reproduce after all (and there is no review note saying otherwise): verdict refuted, change nothing.
2. Fix the root cause once in ${plugin}/src (shared code, after grepping every caller), never in plugin/**/*.mjs. Add a test that fails without the fix (revert the line to check).
3. \`pnpm --filter ${plugin} build\`, \`pnpm lint\`, \`pnpm --filter ${plugin} test\` until green; read the output.
${first ? `4. First fix of the branch: bump ${plugin}/package.json version once (only if \`git diff origin/main -- ${plugin}/package.json\` shows none), then rebuild.\n` : ''}5. \`git add\` what you changed, commit ("${plugin}: fix ${job.f.key}", no Co-Authored-By), \`git push -u origin HEAD\`.
Return verdict fixed|refuted|blocked (blocked: cannot be made green; commit nothing broken), the commit sha, files (the repo-relative paths of the files the commit changed, from \`git show --name-only\`) and one sentence.`

const reviewPrompt = (job, commit) => `Review a fix of plugin "${plugin}" in the git worktree ${worktree}. READ-ONLY: another fix job may be committing in this worktree right now, so do not edit, build or run tests there; read the fix with \`git show ${commit}\` and the code it touches. To run something, copy the commit into a scratch directory outside the worktree (\`git archive ${commit}\` and a symlink to node_modules).
Finding ${job.f.key}: ${job.f.title}. Repro: ${job.f.repro}.
Check: does it fix the root cause rather than the symptom, is every caller covered, does the test fail without the fix, does it add a regression or break an invariant, is anything beyond the finding changed. Reject only for a concrete defect you can name; style is no reason. Verdict approve, or reject with notes the fixer can act on.`

const closePrompt = (summary, files) => `Close the bug hunt of plugin "${plugin}" in the git worktree ${worktree} (stay there).
Files changed by the fix jobs (the only scope of simplify and code-review): ${files.join(', ')}.
1. Size up the changes: \`git diff --stat origin/main...HEAD -- <those files>\`. Doc files (markdown, text, anything under development/wiki/plugins/) never count as code. Ask the jev-api tools first (\`noul\`) whether the code changes are too small or too simple to need a simplifier: only documentation, or only a few lines (about 30 changed code lines or fewer) without new logic.
2. Simplify: when that is a confident yes, skip it. Otherwise skill "simplify" restricted to the changed code files (revert any edit it makes elsewhere), apply its fixes.
3. Code review: skip it under the same rule as simplify. Otherwise choose the level from the size and risk of the changes, jev-api \`score\` first: \`low\` few lines of simple code, \`medium\` moderate changes, \`high\` larger changes or concurrency, caches, security or protocol code, \`xhigh\` large and risky changes; never \`max\`. Run skill "code-review" with args "<level> --fix" and the changed code files as its target.
4. Only when step 2 or 3 changed something: \`pnpm --filter ${plugin} build\`, \`pnpm lint\`, \`pnpm --filter ${plugin} test\` until green.
5. Learnings pass: follow "Close: learnings" in .claude/skills/bughunt/SKILL.md for the defect classes of this hunt: ${summary}. Only general facts go into .claude/rules/*.md (with paths:) or .claude/skills/.
6. \`git add\`, commit ("${plugin}: bug hunt review and learnings", no Co-Authored-By), \`git push\`; then \`git status --short\` must be empty and \`git rev-parse HEAD\` equal \`git rev-parse @{u}\`, else commit and push again.
Return status clean|fixed|blocked, simplify (skipped or run, with the reason), reviewLevel (skipped or the level used) and one sentence.`

// Hunt: every lens, every area, all in parallel.
const hunts = await parallel(lenses.flatMap((l, li) => areas.map((a) => async () => ({ lens: li, report: await run(huntPrompt(a, l.lens), { label: `hunt:l${li}:${a.name}`, phase: 'Hunt', model: l.model, effort: l.effort, schema: FINDINGS }) }))))
const raw = hunts.filter((h) => h?.report).flatMap((h) => h.report.findings.map((f) => ({ ...f, lens: h.lens })))
const failedHunts = hunts.filter((h) => !h?.report).length

// Dedupe: one job after all hunts; the lenses of a group come from its members, not from the model.
let groups = []
if (raw.length) {
  const d = await run(dedupePrompt(raw), { label: 'dedupe', phase: 'Dedupe', model: 'sonnet', effort: 'medium', schema: DEDUPE })
  const used = new Set()
  for (const g of d?.groups ?? []) {
    const members = [...new Set(g.members)].filter((i) => Number.isInteger(i) && raw[i] && !used.has(i))
    if (!members.length) continue
    members.forEach((i) => used.add(i))
    groups.push({ ...g, members })
  }
  raw.forEach((f, i) => { if (!used.has(i)) groups.push({ members: [i], key: f.key, title: f.title, repro: f.repro, fix: f.fix }) })
}
const found = groups.map((g) => {
  const ms = g.members.map((i) => raw[i])
  const sev = ['high', 'medium', 'low'].find((s) => ms.some((m) => m.severity === s))
  // The hunters' classification of the verify job: the strongest model and highest effort asked for by any member.
  const verifyModel = ms.some((m) => m.verifyModel === 'opus') || !ms.some((m) => m.verifyModel) ? 'opus' : 'sonnet'
  const verifyEffort = ['high', 'medium', 'low'].find((e) => ms.some((m) => m.verifyEffort === e)) ?? 'medium'
  return { key: g.key, title: g.title, repro: g.repro, fix: g.fix, severity: sev, verifyModel, verifyEffort, reports: ms.map((m) => ({ lens: m.lens, repro: m.repro })), lensSet: [...new Set(ms.map((m) => m.lens))] }
})

// Verify: one opus verifier per deduplicated finding, in parallel.
const verdicts = await parallel(found.map((f) => () => run(verifyPrompt(f), { label: `verify:${f.key}`, phase: 'Verify', model: f.verifyModel, effort: f.verifyEffort, schema: VERIFY })))
const verified = []
found.forEach((f, i) => {
  const v = verdicts[i]
  const ok = (v?.lenses ?? []).filter((x) => x.valid && f.lensSet.includes(x.lens)).map((x) => x.lens)
  f.verifiedLenses = ok
  if (ok.length) verified.push({ ...f, validLenses: ok.map((n) => lenses[n].lens), fixModel: v.fixModel ?? 'sonnet', fixEffort: v.fixEffort ?? 'medium' })
})

// Fix queue (one job at a time) with a review per finished fix running in parallel to the next fix job.
const results = verified.map((f) => ({ key: f.key, lenses: f.lensSet.map((n) => lenses[n].lens), verifiedLenses: f.verifiedLenses.map((n) => lenses[n].lens), fixModel: f.fixModel, fix: doFix ? 'queued' : 'not run', review: null, rejections: 0 }))
const queue = doFix ? verified.map((f, i) => ({ f, res: results[i], notes: null, prevCommit: null })) : []
const pending = new Set()
let fixed = 0
const changed = new Set()
while (queue.length || pending.size) {
  if (!queue.length) { await Promise.race(pending); continue }
  const job = queue.shift()
  const model = job.f.fixModel
  const r = await run(fixPrompt(job, fixed === 0), { label: `fix:${job.f.key}`, phase: 'Fix', model, ...(model === 'haiku' ? {} : { effort: job.f.fixEffort }), schema: FIX })
  // After a rejected fix its commit stays on the branch: say so in the result.
  const left = job.prevCommit ? ` (rejected fix ${job.prevCommit} stays on the branch)` : ''
  if (!r || r.verdict === 'blocked') { job.res.fix = `blocked${left}`; log(`${job.f.key}: blocked`); continue }
  if (r.verdict === 'refuted') { job.res.fix = `refuted${left}`; continue }
  fixed++
  for (const f of r.files ?? []) changed.add(f)
  job.res.fix = 'fixed'
  job.res.commit = r.commit
  const review = run(reviewPrompt(job, r.commit), { label: `review:${job.f.key}`, phase: 'Fix', model: 'opus', effort: 'medium', schema: REVIEW })
    .catch(() => null)
    .then((rv) => {
      if (rv?.verdict === 'reject' && job.res.rejections < MAX_REJECTIONS) {
        job.res.rejections++
        job.res.review = 'rejected, queued again'
        queue.push({ ...job, notes: rv.notes, prevCommit: r.commit })
      } else if (rv?.verdict === 'reject') job.res.review = 'unresolved after rejections'
      else job.res.review = rv ? 'approved' : 'review failed'
    })
    .finally(() => pending.delete(review))
  pending.add(review)
}

let close = null
if (fixed > 0) {
  close = await run(closePrompt(verified.map((f) => f.title).join('; '), [...changed]), { label: 'close', phase: 'Close', model: 'sonnet', effort: 'medium', schema: CLOSE })
}
return { hunted: raw.length, failedHunts, deduped: found.length, verified: verified.length, failedVerifies: verdicts.filter((v) => !v).length, fixed, results, close }
```
