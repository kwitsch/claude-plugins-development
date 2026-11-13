---
name: perf-worklist
description: Work off a plugin's performance task list (`<plugin>/docs/TASKS.md`) job by job with a Workflow - one sequential subagent per open task with a model and effort picked per task (cap opus, xhigh), commit and push after every job, then a fresh performance analysis. Runs the analysis first when no open task exists. Use when the user asks to work through, burn down or re-run the performance analysis and task list of a plugin.
argument-hint: "<plugin-name>"
---

# perf-worklist

Systematic run over `<plugin>/docs/` (layout and task rules: `.claude/rules/plugin-docs-tasks.md`, pattern from `dprint/docs/`). The argument is the plugin directory name; stop with one line if `<plugin>/package.json` does not exist.

The user's request for this skill is the opt-in for the Workflow tool (load `workflow-authoring` first if it is not loaded).

## Start: worktree and branch

If the session is not already in a linked git worktree, `EnterWorktree` (ToolSearch if deferred) named `perf-<plugin>`, then `git switch -c perf/<plugin>-<YYYY-MM-DD>` (one branch and one draft PR for the whole run). Never nest. Note the worktree's absolute path and today's date: both go into the workflow `args`.

## Step 1: open tasks to jobs

1. Read `<plugin>/docs/TASKS.md`. An open task is an unchecked `- [ ]` entry (tags `open`, `partial`, `docs-only`, `measurement-only`) or a task document with `status: open|partial|docs-only`. Read each open task's `tasks/<id>-<slug>.md`.
2. **No open task** (or no list): run the analysis first (step 3 with `mode: "analyse"`), then repeat this step with the new list. Nothing open after the analysis: report that and stop.
3. **One job per open task**, in the order of the `Dependencies` section of `TASKS.md` (else priority, then id). For every job pick `model` and `effort` (hard cap: `opus` and `xhigh`, never `max`):
   - Ask jev-api once per task (`mcp__jev-api__batch`, state = the task document text): `score` "How large and risky is the change?" with levels `[S: docs or one line, M: one function with tests, L: several functions or modules, XL: cross-cutting, concurrency or protocol change]`, rounded to the nearest level. Low confidence (below 0.5), an error or no configuration: judge it yourself from the same criteria and say so in one line.
   - Map: S -> `haiku`/`low` (docs-only and closed-without-code decisions: `sonnet`/`low`), M -> `sonnet`/`medium`, L -> `opus`/`high`, XL -> `opus`/`xhigh`. A `measurement-only` task is at least `sonnet`/`medium`.
   - Show the table (id, title, size, model, effort) in the reply before starting.

## Step 2: jobs (Workflow, sequential)

Run the script below with `Workflow`, `args = { mode: "jobs", plugin, worktree, date, jobs: [{ id, file, title, model, effort }] }`. Jobs run one after the other in the same worktree (no `isolation`; they all edit the same files). Every job commits and pushes itself. A `blocked` job stops the run; report it and leave the rest open.

After the last job and before the analysis, a review job runs (when at least one job shipped code or docs): `/simplify` once, then `/code-review high --fix` on the branch, then build, lint and tests again, commit and push of what changed (`opus`/`high`; `high` is the ceiling here, never `max`). A blocked review also skips the analysis.

## Step 3: analysis

The script's last phase (and `mode: "analyse"`) runs one analysis agent (`opus`/`xhigh`, read-only on code, writes docs only): method of `<plugin>/docs/EVALUATION-*.md` (same machine, built output, 5+ repetitions where cheap, a comparison with the previous evaluation, never edit old numbers), new findings as `tasks/<id>-<slug>.md` with the next free `F<nn>` id and `status: open`, `TASKS.md` updated. It commits and pushes, and returns the new open ids.

The review and the analysis commit and push their own changes like every job; the run ends with a clean `git status` and the branch head equal to its upstream.

New open tasks after the closing analysis are reported, not worked in the same run: a new run of this skill works them off.

## Finish

After the workflow: `gh pr create --draft` for the branch when none exists (`gh pr view` first), title `<plugin>: performance task list (<n> jobs)`, body = per-job table with status and commit. No attribution lines. Report the PR URL, the per-job outcome and the new open ids.

## Workflow script

```js
export const meta = {
  name: 'perf-worklist',
  description: 'Work off a plugin perf task list job by job (commit + push each), then re-run the analysis',
  phases: [
    { title: 'Jobs', detail: 'one subagent per open task, sequential' },
    { title: 'Review', detail: '/simplify, then /code-review --fix on the branch' },
    { title: 'Analysis', detail: 'fresh performance analysis' },
  ],
}

const JOB = { type: 'object', properties: { status: { enum: ['done', 'closed', 'blocked'] }, commit: { type: 'string' }, summary: { type: 'string' } }, required: ['status', 'summary'] }
const REVIEW = { type: 'object', properties: { status: { enum: ['clean', 'fixed', 'blocked'] }, commit: { type: 'string' }, summary: { type: 'string' } }, required: ['status', 'summary'] }
const ANALYSIS = { type: 'object', properties: { newOpen: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } }, required: ['newOpen', 'summary'] }
const { plugin, worktree, date } = args

// No human reads the agents' text: no narration between tool calls, only the structured result.
const QUIET = '\n\nNo narration: no text between tool calls, no plans, no progress notes, no recap. Call tools silently and end with the structured result only.'
const run = (prompt, opts) => agent(prompt + QUIET, opts)

const jobPrompt = (j) => `Work performance task ${j.id} (${j.title}) of plugin "${plugin}" in the git worktree ${worktree} (stay there; run git and pnpm from its root).
Read ${plugin}/docs/tasks/${j.file}, ${plugin}/docs/TASKS.md, ${plugin}/CLAUDE.md, .claude/rules/plugin-docs-tasks.md and the rules the task names.
1. Check the task against the CURRENT code (moved files, renamed symbols, drift). Obsolete or not worth doing: status closed with the reason in the task document, no code.
2. Otherwise: failing test first (it must fail without the fix), then the smallest root-cause change in ${plugin}/src, never in plugin/**/*.mjs. Measure before and after where the task asks for it.
3. Run \`pnpm --filter ${plugin} build\`, \`pnpm lint\`, \`pnpm --filter ${plugin} test\`; fix until green. Read the output; never claim green unseen.
4. Update the task document (status, Verification with the test and numbers, the version that ships it) and TASKS.md in the same commit. Bump ${plugin}/package.json version (patch, minor for behaviour) only if \`git diff origin/main -- ${plugin}/package.json\` shows no version change yet, then rebuild.
5. \`git add\` only what this job changed, commit (message "${plugin}: ${j.id} <what>", no Co-Authored-By, no generated-with footer), \`git push -u origin HEAD\`.
Return status done|closed|blocked (blocked: tests cannot be made green or the task needs a user decision; commit nothing broken), the commit sha, and one summary sentence.`

const reviewPrompt = () => `Review the work of this run on the branch in the git worktree ${worktree} (everything since origin/main for plugin "${plugin}"; stay in the worktree).
1. Invoke the Skill "simplify" once on the branch changes and apply its fixes.
2. Invoke the Skill "code-review" with args "high --fix" (never max) on the branch.
3. Run \`pnpm --filter ${plugin} build\`, \`pnpm lint\`, \`pnpm --filter ${plugin} test\` and fix until green; read the output.
4. If anything changed: \`git add\` it, commit ("${plugin}: simplify and review fixes", no Co-Authored-By) and \`git push\`. Never touch plugin/**/*.mjs by hand. Then check that \`git status --short\` is empty and \`git rev-parse HEAD\` equals \`git rev-parse @{u}\`; otherwise commit and push again.
Return status clean (nothing to change), fixed or blocked (not green), the commit sha and one summary sentence.`

const analysisPrompt = () => `Run a fresh performance analysis of plugin "${plugin}" in the git worktree ${worktree}. Follow .claude/rules/plugin-docs-tasks.md and the method of the latest ${plugin}/docs/EVALUATION-*.md (and ${plugin}/docs/README.md if present). Date: ${date}.
Write ${plugin}/docs/EVALUATION-${date}.md (a dated file; never edit old numbers; state what was and was not run). New findings: ${plugin}/docs/tasks/F<next free nn>-<slug>.md with status open, frontmatter and sections per the rule; update TASKS.md. Docs only: do not change code.
\`git add\` the docs, commit ("${plugin}: performance analysis ${date}", no Co-Authored-By) and \`git push -u origin HEAD\`. Then check that \`git status --short\` is empty and \`git rev-parse HEAD\` equals \`git rev-parse @{u}\`; otherwise commit and push again. Return the ids of the new open tasks.`

const results = []
if (args.mode === 'jobs') {
  phase('Jobs')
  for (const j of args.jobs) {
    const r = await run(jobPrompt(j), { label: j.id, phase: 'Jobs', model: j.model, effort: j.effort, schema: JOB })
    results.push({ id: j.id, ...(r ?? { status: 'blocked', summary: 'agent failed' }) })
    log(`${j.id}: ${results.at(-1).status}`)
    if (results.at(-1).status === 'blocked') break
  }
}

let proceed = results.every((r) => r.status !== 'blocked')
let review = null
if (proceed && results.some((r) => r.status === 'done')) {
  phase('Review')
  review = await run(reviewPrompt(), { label: 'simplify + code-review', phase: 'Review', model: 'opus', effort: 'high', schema: REVIEW })
  log(`review: ${review?.status ?? 'agent failed'}`)
  proceed = review !== null && review.status !== 'blocked'
}

let analysis = null
if (args.mode === 'analyse' || proceed) {
  phase('Analysis')
  analysis = await run(analysisPrompt(), { label: 'analysis', phase: 'Analysis', model: 'opus', effort: 'xhigh', schema: ANALYSIS })
} else {
  log('Analysis skipped: a job or the review is blocked')
}
return { results, analysis }
```
