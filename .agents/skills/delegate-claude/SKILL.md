---
name: delegate-claude
description: Delegate a bounded implementation, prototype, benchmark, or file artifact to Claude Code, which owns the reasoning and applies the result in the current checkout or a selected standalone clone. Use when asked to delegate execution to Claude or when a task-specific benefit justifies a separately owned Claude assignment. Answer-only investigations, recommendations, and text drafts belong to consult-claude.
---

# Delegate Claude

Claude owns the reasoning and delivery of a completed assignment, including
applying its changes in the assigned checkout. By default that is the current
checkout. The coordinating Codex owns overall continuity and focused acceptance.
It pauses its own edits to that checkout until Claude returns, and it does not
repeat Claude's investigation or copy the result into another checkout. Name
the benefit of assigning delivery to Claude, such as a user-requested division
of work or a bounded experiment that can proceed separately from the parent
task. Reasoning, design judgment, or taste alone does not require delegation.
Once delegation is selected, give Claude a coherent outcome and observable
acceptance criteria, including the investigation needed to deliver it. Codex
need not solve the assignment before handing it over.

Choose the execution route before launching. For substantial implementation,
default to `--codex --codex-model <selected-model>`. Claude owns the design
judgment, assigns bounded investigation and implementation to Codex, inspects
the resulting changes, and directs corrections. For a small edit tightly
coupled to Claude's reasoning, keep the direct route. Use direct delivery when
handing off would require repeating most of the investigation.

Respect the user's priorities for speed, attention, and usage. When speed
matters, minimize serial handoffs and repeated investigation while preserving
required verification. Additional agents must earn their coordination cost.

The user's request to delegate, or authorization to complete the parent task,
bounds the assignment. Delegation does not authorize publishing, deploying,
sending messages, changing credentials, or expanding the product outcome.
Use [consult-claude](../consult-claude/SKILL.md) when the requested result is an
answer, recommendation, or text draft. When the user authorizes a delivered
change, give Claude the investigation, design judgment, and implementation in
one assignment. An uncertain mechanism or design does not require an initial
consultation and a separate delivery handoff. Let Claude resolve those choices
within the accepted outcome.
Stop with concrete evidence when a missing requirement would change the product
outcome or assignment scope. Passing tests cannot establish an unstated
requirement. Reserve independent adversarial review for consequential decisions,
rather than every worker result.

## Work backward from acceptance

Specify the result, affected consumers and requirements, source baseline,
allowed changes, verification, and stop condition. Let Claude choose the
implementation within those guarantees rather than prescribing each edit.
For example:

> Own the folder-scanning benchmark. Build and run a reproducible benchmark for
> small and large folders, including missing-directory failure behavior. Return
> runnable files, measured timings, failure behavior, and limits of the evidence.
> Modify only the benchmark directory. Stop after the measurements establish
> whether scanning belongs on the API's critical path. Do not decide the public
> API or require a remote service.

For a fix, define observable behavior and affected callers before dispatch.
For an experiment, name the decision its evidence will settle. Claude returns
changed paths or artifacts, commands and actual results, and unresolved issues.
It should report a blocker with concrete partial work rather than inventing a
contract or requesting broader access.

Keep the destination and the reasons it is worth pursuing in the brief. Let
Claude choose implementation details within the accepted outcome. For greenfield
experiments, acceptance is evidence that distinguishes designs, not proof that
the preferred design is right. Claude surfaces discoveries that suggest a better
destination; Codex owns the resulting decision through
[rethink](../rethink/SKILL.md). A convenient implementation must not silently
replace the vision or the assignment.

## Choose the checkout

Omit `--workspace` to deliver into the current checkout: the Git root containing
the launcher's working directory, which may be a linked worktree. Each checkout
has one code writer. While Claude works, the coordinating Codex and other agents
do not edit that checkout; Codex can keep reading, planning, or working
elsewhere.

The current checkout can contain unrelated uncommitted work. Before dispatch,
record `git status` and name the allowed paths in the brief. If an allowed file
is already modified, record its existing diff so acceptance can separate it from
Claude's work. Claude preserves unrelated changes and does not stage, stash,
commit, or reset.

Select an external standalone clone with `--workspace` only when isolation earns
its cost, such as Codex continuing to edit the live checkout in parallel or an
experiment that should not touch it. Create a fresh disposable clone so the
worker cannot overwrite valuable unfinished work in an existing clone. Only
this route needs a transfer: use
`git clone --no-local /absolute/source/checkout /absolute/worker/clone` outside
the current checkout, select the intended commit, and copy the relevant
uncommitted and untracked task files,
including intended deletions; exclude unrelated changes and secrets. Record the
baseline and transferred paths. A clone's result reaches the live checkout only
when the coordinator applies it. Do not use the shared stash or stage files in
the coordinating checkout to manufacture a snapshot.

`--workspace` accepts the current checkout root or an external standalone clone.
The launcher refuses paths inside or containing the current checkout, external
linked worktrees, non-repositories, and external clones whose local origin does
not identify the coordinating checkout. These checks establish source provenance,
not whether an existing clone is disposable. Consultation never accepts
`--workspace`.

Materialize applicable borrowed skills inside a worker clone. Vault's absolute
skill links point into the live Epicenter checkout; restricted file tools cannot
read those targets. Copy the needed guidance into the clone after replacing its
links, without changing the source links or granting outside access. Do not copy
machine state, credentials, or unrelated skills.

Prepare required dependencies before launch. This route provides no task-network
allowlist or local server binding. Before dispatch, identify checks Claude can
run under those restrictions and checks Codex must run during acceptance,
especially browser or local-server checks. A blocked check remains unverified
until Codex performs it.

## Dispatch and continue

Requires Bun, Git, and authenticated Claude Code 2.1.285 or later with access to
the selected model and a working native Bash sandbox. Use the same launcher as
consultation. New and resumed delegations default to Opus 5.5 high; explicit
`--model` and `--effort` flags override that. Codex helpers use the selected
helper model at medium reasoning. Sonnet is an explicit choice for routine
bounded work.

For substantial implementation, enable Codex assistance and select its model
explicitly; this example uses `gpt-6.1-sol`:

```bash
bun .agents/skills/consult-claude/scripts/consult-claude.ts \
  --account personal --account-email claude@example.com \
  --codex --codex-model gpt-6.1-sol \
  --mode delegate <<'ASSIGNMENT'
[Result, consumers, requirements, baseline, allowed paths, checks, stop.]
ASSIGNMENT
```

For a small edit tightly coupled to Claude's reasoning, omit both `--codex`
and `--codex-model` to use direct delivery.

Add `--workspace /absolute/path/to/standalone-clone` to select a clone.

Without `--codex`, the launcher supplies Read, Glob, Grep, Edit, Write, and Bash.
Restricted mode ignores user and project settings; hooks and MCP tools are
disabled. File tools are confined to the assigned checkout, and only the
required sandbox can approve Bash, with no unsandboxed retry. The sandbox removes
inherited application variables from shell commands while leaving standard shell
variables available; the Claude process uses the verified native profile.
Missing sandbox support fails instead of silently widening execution. Prepare
checks that do not require credentials or network access. Normal temporary-file writes
remain available. It does not create clones, stage or commit changes, or copy
them between checkouts. Claude's instructions prohibit child agents, commits,
remote changes, publishing, and access changes.
Those instruction boundaries are separate from filesystem enforcement.

With `--codex`, Claude has Read, Glob, Grep and the host's evidence and
implementation tools, with no Edit, Write or Bash.
Codex is the sole code writer in the assigned checkout. Claude chooses specific
evidence requests, defines bounded implementation assignments, reads deciding
source and resulting edits, checks reported verification, and directs corrections.
Read [Codex assistance](../consult-claude/references/codex-assistance.md) before
enabling it. Host limits and sandboxing apply independently to the helper;
neither its execution nor external-provider usage is bounded by Claude's budget.

The helper's write sandbox keeps `.git`, `.agents`, `.codex` and `.aws`
read-only. When the assignment edits a skill, the coordinator adds
`--codex-write-root .agents/skills/<name>` for each assigned skill directory on
the first turn and every resume. Each root must resolve, after symlinks, to a
real directory inside the assigned checkout's `.agents/skills`. The launcher
refuses roots for consultation or direct delegation. Only the implementation
tool receives them; evidence stays read-only, and neither Claude nor tool
arguments can add a root. A root reopens its whole directory, including any
launcher scripts inside it, so name the allowed files in the brief.

Every launch requires the shared launcher's `--account personal|work` and
`--account-email` flags on the first turn and every resume. Account setup,
identity checks, and profile ownership are described in
[Choose a subscription account](../consult-claude/SKILL.md#choose-a-subscription-account).

Read native `result`, `session_id`, `is_error`, `permission_denials`, and actual
model usage. A zero process exit alone does not establish completion. Monitor
yielded processes and keep the user informed. Resume the same session for
the same assignment in the same checkout, repeating any `--workspace`, `--codex`
and write-root choices. New evidence, a failed check, or a correction does not
need a new conversation. This example resumes helper-backed delivery; direct
sessions omit both Codex flags:

```bash
bun .agents/skills/consult-claude/scripts/consult-claude.ts \
  --account personal --account-email claude@example.com \
  --codex --codex-model gpt-6.1-sol \
  --mode delegate --resume <session_id> <<'FOLLOWUP'
[Failed acceptance check, raw evidence, and focused correction.]
FOLLOWUP
```

State what remains accepted and what changed, and retain useful partial work.
Choose natural assignment boundaries when evidence could change substantial
work; straightforward tasks need no mandatory checkpoints. Keep one writer per
checkout: parallel workers need separate clones and independently reviewable
results.

The launcher reapplies Opus 5.5 high on resumes while retaining the native
conversation history, so an older Sonnet session continues as Opus unless
`--model` repeats Sonnet. Repeat any deliberate nondefault `--model` or
`--effort` on each follow-up. For a failed acceptance check, send the evidence
and a focused correction to the same session. If a session deliberately used
Sonnet or lower effort, return to the default when a specific unresolved
ownership, lifecycle, or mechanism decision needs deeper judgment, or when
repeated attempts cannot explain a failure. Model escalation does not fix
missing dependencies or blocked permissions; Codex fixes the environment or owns
the blocked check. An explicit scope boundary still applies.

Use `--dry-run` to inspect arguments without calling Claude. Do not switch a
read-only session into a worker to bypass its assignment scope.

Follow [the continuation record](../consult-claude/SKILL.md#send-a-brief) for
assignments that may outlive the current context, including the workspace
choice. Repeat the same `--codex` capability, helper model, limits and write
roots on parent resumes. Within one launcher run, Claude can resume a helper
session that the same tool returned. A parent resume starts a fresh helper
connection that refuses earlier helper IDs, so Claude sends a new brief with
the earlier findings and changed source. Do not switch a session between direct
execution and helper-backed delivery.

## Accept the delivery

The coordinating Codex accepts the result in the assigned checkout. Inspect the
artifact or diff against the recorded baseline before executing worker code.
Git metadata is also untrusted: inspect with
`git -c core.fsmonitor= -c core.hooksPath=/dev/null diff --no-ext-diff --no-textconv <recorded-baseline>`
to cover staged and unstaged tracked changes. List untracked artifacts with
`git -c core.fsmonitor= -c core.hooksPath=/dev/null ls-files --others --exclude-standard`
and inspect their contents before running checks with the coordinator's authority.
Check the allowed paths and consumer
contract, and reproduce the checks that decide acceptance, especially those
Claude could not run. Identify which evidence came from Claude and which Codex
reproduced. Do not repeat the full investigation. Return a focused failure to
the same session rather than editing alongside Claude or commissioning another
full panel. After acceptance, Codex resumes edits and owns continuity, including
any post-implementation review the parent task requires. For a clone delivery,
Codex applies accepted changes to the live checkout when the task needs them
there.

Use consultation with a fresh session when independent judgment is needed on
Claude's output. Run it from the idle assigned checkout or a snapshot containing
the reviewed evidence; give it the desired behavior, baseline, callers, and
cumulative diff before the worker's justification. From a worker clone, invoke
the launcher by its absolute path in the coordinating checkout, with the clone
as the working directory. Adversarial-review owns the pair for a consequential
checkpoint.

Keep acceptance review proportional to the consequence. Tests establish their
covered behaviors; direct caller inspection and counterexamples can expose
missing requirements. Two models agreeing does not prove correctness.

Return the user-facing result and material limitations. Preserve a clone until
its accepted contents are retained; clean up only task-owned temporary work.
Judge delegation by the soundness of the reasoning, quality of design and
implementation, and evidence that the result meets its requirements. When
recording a delegation outcome in existing task notes, include the actual model,
accepted result, deciding evidence, corrections, and unresolved limits. Use
observed outcomes to adjust the division of work; do not create a separate
tracking system or count a worker's successful exit as accepted work.
