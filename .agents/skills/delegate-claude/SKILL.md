---
name: delegate-claude
description: Delegate a bounded implementation, prototype, benchmark, or file artifact to Claude Code, then verify and integrate its completed work. Use when the user explicitly authorizes Claude to own execution. Read-only advice belongs to consult-claude.
---

# Delegate Claude

Claude owns a completed assignment in a dedicated clone. Codex owns continuity,
acceptance, and integration. Propose delegation when the work is separable,
substantial enough to repay briefing and checking, and has observable acceptance
criteria. Useful overlap with Codex's other work strengthens the case. Count
clone preparation, dependencies, briefing, acceptance, and integration in that
cost. Keep a short sequential fix in the main session when coordination would
cost more than the work.

The user's explicit authorization for Claude execution bounds the assignment.
Authorization for the parent task alone does not supply it.
Delegation does not authorize publishing, deploying,
sending messages, changing credentials, or expanding the product outcome.
Use [consult-claude](../consult-claude/SKILL.md) when the accepted outcome or a
consequential contract needs deciding, or for an answer that needs no execution.
Otherwise let the worker resolve implementation questions within the brief.
Stop with concrete evidence when a missing requirement would change the product
outcome or assignment scope. Passing tests cannot establish an unstated
requirement. Reserve independent adversarial review for consequential decisions,
rather than every worker result.

## Work backward from acceptance

Specify the result, affected consumers and requirements, source baseline,
allowed changes, verification, and stop condition. Let Claude choose the
implementation within those guarantees rather than prescribing each edit.
For example:

> Own the commit timing benchmark. Build and run a reproducible benchmark for
> small and large folders, and commit attempts while a Git lock is held. Return
> runnable files, measured timings, failure behavior, and limits of the evidence.
> Modify only the benchmark directory. Stop after the measurements establish
> whether local commit completion belongs on the API's critical path. Do not
> decide the public API or require a remote service.

For a fix, define observable behavior and affected callers before dispatch.
For an experiment, name the decision its evidence will settle. Claude returns
changed paths or artifacts, commands and actual results, and unresolved issues.
It should report a blocker with concrete partial work rather than inventing a
contract or requesting broader access.

## Prepare the workspace

Run the shared launcher from the coordinating repository. Give Claude a
fresh disposable clone outside that checkout. The launcher rejects the
coordinating checkout, nested clones, linked worktrees, and targets whose local
origin is not the coordinating checkout. These checks establish source
provenance, not whether an existing clone is disposable: Codex must create a
fresh one so valuable unfinished work is never made writable by the worker.
A clone keeps Git metadata separate; the Claude Bash sandbox bounds execution.

Use `git clone --no-local /absolute/source/checkout /absolute/worker/clone`,
and explicitly select the intended source commit. A clone contains committed
source only. Copy the relevant uncommitted and untracked task files, including
intended deletions, when they form part of the assignment. Include enough
context to preserve callers and requirements; exclude unrelated changes and
secrets. Record the baseline and transferred paths so the return diff separates
input changes from Claude's work. Do not use the shared stash or stage files in
the coordinating checkout to manufacture a snapshot.

Materialize applicable borrowed skills inside the worker clone. Vault's
absolute skill links point into the live Epicenter checkout; restricted file
tools cannot read those targets. Copy the needed guidance into the clone after
replacing its links, without changing the source links or granting outside
access. Do not copy machine state, credentials, or unrelated skills.

Prepare required dependencies before launch. This route provides no task-network
allowlist or local server binding. Keep source stable for the worker's run;
Codex can continue in the live checkout. A dedicated clone has one writer.
Before dispatch, identify checks the worker can run under those restrictions
and checks Codex must run during acceptance, especially browser or local-server
checks. A blocked check remains unverified until Codex performs it.

## Dispatch and continue

Requires Bun, Git, and authenticated Claude Code 2.1.285 or later with access to
the selected model and a working native Bash sandbox. Use the same launcher as
consultation. Its new-delegation default is Sonnet 5.5 at medium effort for
bounded work with clear acceptance criteria. Use `--effort high` for difficult
implementation within a settled design. Choose
`--model claude-opus-5-5 --effort high` when the assignment itself requires
sustained judgment within accepted requirements. Do not raise Sonnet to max
effort as a routine substitute for choosing Opus.

```bash
bun .agents/skills/consult-claude/scripts/consult-claude.ts \
  --mode delegate --workspace /absolute/path/to/dedicated-clone <<'ASSIGNMENT'
[Result, consumers, requirements, baseline, allowed changes, checks, stop.]
ASSIGNMENT
```

The launcher supplies Read, Glob, Grep, Edit, Write, and Bash. Restricted mode
ignores user and project settings; hooks and MCP tools are disabled. File tools
are confined to the worker, and only the required sandbox can approve Bash,
with no unsandboxed retry. The sandbox removes inherited application variables
from shell commands while leaving standard shell variables available; the
Claude process retains its authentication environment. Prepare checks that do
not require credentials or network access. Normal temporary-file writes remain
available. The launcher does not create or remove the clone, commit changes, or
integrate them. Claude's instructions
prohibit child agents, commits, remote changes, publishing, and access changes.
Those instruction boundaries are separate from filesystem enforcement.

Read native `result`, `session_id`, `is_error`, `permission_denials`, and actual
model usage. A zero process exit alone does not establish completion. Monitor
yielded processes and keep the user informed. Worker sessions are fresh on each
launch: `--resume` is refused in delegate mode. For a correction, keep the idle
clone and supply the full assignment, baseline, current diff, failed check, and
focused correction in a new brief:

```bash
bun .agents/skills/consult-claude/scripts/consult-claude.ts \
  --mode delegate --workspace /absolute/path/to/dedicated-clone \
  --effort medium <<'FOLLOWUP'
[Full assignment, baseline, current diff, failed check, and focused correction.]
FOLLOWUP
```

Repeat an explicit model and effort choice when continuing work that needs it.
Missing dependencies and blocked permissions belong to Codex; changing models
does not repair them. An unresolved product requirement still stops the worker.

Use `--dry-run` to inspect arguments without calling Claude. Do not switch a
read-only session into a worker to bypass its assignment scope.

## Accept and integrate

Use consultation with a fresh session when independent judgment is needed on
Claude's output. Run it from the idle worker clone or a snapshot containing the
reviewed evidence; give it the desired behavior, baseline, callers, and cumulative
diff before the worker's justification. From a worker clone, invoke the launcher
by its absolute path in the coordinating checkout, with the clone as the working
directory. Adversarial-review owns the pair for a consequential checkpoint.

Inspect the artifact or diff against the supplied baseline before executing
worker code. Git metadata is also untrusted: inspect with
`git -c core.fsmonitor= -c core.hooksPath=/dev/null diff --no-ext-diff --no-textconv <recorded-baseline>`
to cover staged and unstaged tracked changes. Also list untracked artifacts with
`git -c core.fsmonitor= -c core.hooksPath=/dev/null ls-files --others --exclude-standard`
and inspect their contents before running checks with the coordinator's authority. Check the
consumer contract and run relevant checks; identify which evidence came from
Claude and which Codex reproduced. Fix or return a focused failure to the same
worker rather than commissioning another full panel. Codex applies accepted
changes to the live checkout and performs local post-implementation checks.

Keep integration review proportional to the consequence. Tests establish their
covered behaviors; direct caller inspection and counterexamples can expose
missing requirements. Two models agreeing does not prove correctness.

Return the user-facing result and material limitations. Preserve the worker's
artifacts until integration is verified; clean up only task-owned temporary
work after its useful contents are retained. Judge delegation by accepted work,
coordinator time including rejected attempts, turnaround, and corrections.
When recording an outcome in existing task notes, include the accepted result
and observations that change future judgment. Do not create another tracking
system or count a successful process exit as accepted work.
