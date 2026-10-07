---
name: delegate-claude
description: Delegate a bounded implementation, prototype, benchmark, or file artifact to Claude Code, then verify and integrate its completed work. Use when asked to delegate to Claude or let Claude own execution within an authorized task. Read-only advice belongs to consult-claude.
---

# Delegate Claude

Claude owns a completed assignment in a dedicated clone. Codex owns continuity,
acceptance, and integration. Prefer delegation when the work is separable,
substantial enough to repay briefing and checking, and has observable acceptance
criteria. Useful overlap with Codex's other work strengthens the case. Count
clone preparation, dependencies, briefing, acceptance, and integration in that
cost. Keep a short sequential fix in the main session when coordination would
cost more than the work.

The user's request to delegate, or authorization to complete the parent task,
bounds the assignment. Delegation does not authorize publishing, deploying,
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
standalone clone outside that checkout. The launcher rejects the live checkout,
nested clones, and linked worktrees. A clone keeps Git metadata separate; the
Claude Bash sandbox provides the execution boundary.

Use an independent clone, such as `git clone --no-local <source> <workspace>`,
and explicitly select the intended source commit. A clone contains committed
source only. Copy the relevant uncommitted and untracked task files, including
intended deletions, when they form part of the assignment. Include enough
context to preserve callers and requirements; exclude unrelated changes and
secrets. Record the baseline and transferred paths so the return diff separates
input changes from Claude's work. Do not use the shared stash or stage files in
the coordinating checkout to manufacture a snapshot.

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

The launcher supplies Read, Glob, Grep, Edit, Write, and Bash; disables hooks and
MCP tools; confines file-tool access; and explicitly approves Bash under a
required sandbox with no unsandboxed retry. Missing sandbox support fails instead
of silently widening execution. Normal temporary-file writes remain available. It does not create
or remove the clone, commit changes, or integrate them. Claude's instructions
prohibit child agents, commits, remote changes, publishing, and access changes.
Those instruction boundaries are separate from filesystem enforcement.

Read native `result`, `session_id`, `is_error`, `permission_denials`, and actual
model usage. A zero process exit alone does not establish completion. Monitor
yielded processes and keep the user informed. Resume a completed worker in the
same workspace for the same assignment, supplying changed evidence explicitly:

```bash
bun .agents/skills/consult-claude/scripts/consult-claude.ts \
  --mode delegate --workspace /absolute/path/to/dedicated-clone \
  --resume <session_id> --effort medium <<'FOLLOWUP'
[Failed acceptance check, raw evidence, and focused correction.]
FOLLOWUP
```

The launcher preserves the native session model on resume unless `--model` is
explicit. Command-line effort does not persist: repeat the chosen `--effort`
on each follow-up. The example above continues ordinary medium-effort work;
repeat high after difficult implementation or an Opus-high escalation. Omission
uses native settings or defaults. For a failed acceptance check, send the
evidence and a focused correction to the same worker.
Escalate with `--model claude-opus-5-5 --effort high` when a specific unresolved
implementation ownership, lifecycle, or mechanism decision within accepted
requirements needs deeper judgment, or when repeated attempts cannot explain the
failure mechanism. Model escalation does
not fix missing dependencies or blocked permissions; Codex fixes the environment
or owns the blocked check. An explicit scope boundary still applies.

Use `--dry-run` to inspect arguments without calling Claude. Do not switch a
read-only session into a worker to bypass its assignment scope.

## Accept and integrate

Use consultation with a fresh session when independent judgment is needed on
Claude's output. Run it from the idle worker clone or a snapshot containing the
reviewed evidence; give it the desired behavior, baseline, callers, and cumulative
diff before the worker's justification. From a worker clone, invoke the launcher
by its absolute path in the coordinating checkout, with the clone as the working
directory. Adversarial-review owns the pair for a consequential checkpoint.

Inspect the actual artifact or diff against the supplied baseline. Check the
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
When recording a delegation outcome in existing task notes, include the actual
model, accepted result, elapsed time, correction rounds, and coordinator effort.
Use observed outcomes to adjust model choice; do not create a separate tracking
system or count a worker's successful exit as accepted work.
