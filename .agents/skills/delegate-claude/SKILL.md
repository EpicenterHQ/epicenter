---
name: delegate-claude
description: Delegate a bounded implementation, prototype, benchmark, or file artifact to Claude Code, then verify and integrate its completed work. Use when asked to delegate to Claude or let Opus own execution within an authorized task. Read-only advice belongs to consult-claude.
---

# Delegate Claude

Claude owns a completed assignment in a dedicated clone. Codex owns continuity,
acceptance, and integration. Prefer delegation when the work is separable,
substantial enough to repay briefing and checking, and has observable acceptance
criteria. Useful overlap with Codex's other work strengthens the case.

The user's request to delegate, or authorization to complete the parent task,
bounds the assignment. Delegation does not authorize publishing, deploying,
sending messages, changing credentials, or expanding the product outcome.
Use [consult-claude](../consult-claude/SKILL.md) for unresolved contract discovery
or an answer that needs no execution. Passing tests cannot establish an unstated
requirement. Reserve independent adversarial review for consequential decisions,
rather than every worker result.

## Work backward from acceptance

Specify the result, affected consumers and requirements, source baseline,
allowed changes, verification, and stop condition. Let Claude choose the
implementation within those boundaries. For example:

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

## Dispatch and continue

Requires Bun, Git, and authenticated Claude Code 2.1.285 or later with access to
Opus 5.5 and a working native Bash sandbox. Use the same launcher as consultation:

```bash
bun .agents/skills/consult-claude/scripts/consult-claude.ts \
  --mode delegate --workspace /absolute/path/to/dedicated-clone \
  --effort high <<'ASSIGNMENT'
[Result, consumers, requirements, baseline, allowed changes, checks, stop.]
ASSIGNMENT
```

The launcher supplies Read, Glob, Grep, Edit, Write, and Bash; disables hooks and
MCP tools; confines file-tool access; and requires sandboxed Bash without an
unsandboxed retry. Missing sandbox support fails instead of silently widening
execution. Normal temporary-file writes remain available. It does not create
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
  --resume <session_id> --effort high <<'FOLLOWUP'
[Failed acceptance check, raw evidence, and focused correction.]
FOLLOWUP
```

Use `--dry-run` to inspect arguments without calling Claude. Use consultation
with a fresh session when independent judgment is needed on Claude's output.
Do not switch a read-only session into a worker to bypass its assignment scope.

## Accept and integrate

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
