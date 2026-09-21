---
name: spec-execution
description: Execute implementation plans through working checkpoints and independent adversarial steering. Use when the user says "execute this spec", "implement this plan", "run the spec", or points at a spec file.
metadata:
  author: epicenter
  version: '1.0'
---

# Spec Execution

Execute the accepted outcome in waves. Each wave produces working code and new
evidence about the design. The remaining plan must respond to that evidence:
consumer migrations can reveal that several adapters share one misplaced
invariant, or that a later wave no longer needs to exist. Passing tests proves
behavior; it does not settle ownership.

Use the active spec when one exists. For a plan supplied in conversation, keep
the same checkpoints in working notes without creating a spec just for the
ritual. Spec preflight and retirement below apply only to actual spec files.

Commits should follow the shape of the work. Commit after a wave when that wave is a natural review unit. Combine waves into one larger commit when the changes are tightly coupled. Break a large wave into smaller commits when that makes the history easier to audit. The goal is working checkpoints first, readable git history second.

## The Execution Loop

```
PREFLIGHT SPEC
    |
    v
READ ACTIVE PATH
    |
    v
PLAN WAVES (which tasks are parallel vs sequential?)
    |
    v
WAVE N
  1. Execute tasks (sub-agents when useful)
  2. Verify (type-check, tests if applicable)
  3. Independent adversarial review of cumulative implementation + remaining plan
  4. Adjudicate findings, reshape remaining waves, implement and verify repairs
  5. Record decisions in spec or working notes; commit or checkpoint
    |
    v
REPEAT toward accepted outcome using the revised plan
    |
    v
FINAL REVIEW (post-implementation-review, harvest decisions to docs/adr/, delete spent spec)
```

Default to continuing after the checkpoint has been reviewed and its findings
resolved. A grounded structural change within the accepted outcome does not
need renewed permission merely because it touches more files. Ask when the
choice changes the product outcome, exceeds authorization, requires a
destructive action, or depends on a judgment the repository cannot settle.

## Phase 0: Preflight the Spec

Before planning waves, make sure the spec has a current execution path.

Check:

- Status: Draft or In Progress. A spec is in-flight; "done" is deletion, not a terminal status (see `specs/README.md`).
- Supersession: whether the top of the spec points to a newer spec.
- One Sentence: what the spec is actually about.
- Current State and Target Shape: enough concrete code, routes, types, or file paths to start.
- Implementation Plan: actionable tasks or waves.
- Verification: commands, smoke tests, or grep checks that prove the work.
- Open Questions: anything that blocks implementation.

Large specs are fine. Do not split or reject a spec because it is long. Only stop to refresh the spec when the active path is unclear, stale, or mixed with unrelated reader jobs.

If a spec is long but usable, write a short wave plan and proceed. If it is long and confusing, first add or update a "How to read this spec" or "Active execution path" section. That update is part of the work.

## Phase 1: Read and Understand

Before touching any code:

1. **Read the active path first**: understand what is current before reading appendices, prompts, or historical notes
2. **Identify the implementation phases** from the spec's Implementation Plan section
3. **Map dependencies**: which tasks block others? Which are independent?
4. **Check the spec's Open Questions**: resolve what you can, flag what needs human input
5. **Scan the rest of the spec for constraints**: read decisions, rejected alternatives, and edge cases that could affect the implementation

If the spec has unresolved Open Questions that block implementation, surface them immediately. Don't guess on architectural decisions.

## Phase 2: Plan Waves

Break the spec's implementation plan into execution waves. A wave is a set of changes that can land together while leaving the repo working.

Breaking API changes are allowed inside a wave. The boundary matters: by the end of the wave, update affected consumers, migrations, tests, or documentation so the repo is coherent again.

### Plan for evidence

Record the task-start baseline and pre-existing working changes so each review
can include earlier committed waves without attributing unrelated edits to this
task. Track task-owned untracked files as well as tracked changes.

Name each wave's working outcome, dependencies, and verification. Put a review
checkpoint after each substantive wave, before dependent implementation starts.
A substantive wave establishes or changes an API, ownership boundary, lifecycle,
or consumer integration. Do not turn every edit or mechanical batch into a
checkpoint. Review earlier when discoveries undermine the next planned step.

Keep later waves provisional. Commit boundaries follow reviewable changes and
need not coincide with steering checkpoints.

## Phase 3: Execute Waves

For each wave:

### 1. Execute Tasks

Use sub-agents for owned implementation work when they are available. They are strongest when each agent owns a bounded task, a clear file set, and a non-overlapping write surface. The primary agent still owns orchestration, integration, verification, spec updates, and final review.

- **Independent tasks**: Launch sub-agents in parallel when write sets do not overlap. Each gets a focused prompt with only the context it needs: the relevant spec section, the files it owns, and the patterns to follow.
- **Dependent tasks**: Launch sub-agents sequentially when one task imports from another task's output or modifies the same files. Wait for one to complete before launching the next. The second agent gets the output/context from the first.
- **Local tasks**: Keep work local when the task is tightly coupled, urgent, too ambiguous to delegate, or likely to block the next orchestration step.
- **Keep changes coherent**: Treat the spec as the execution spine, not a file whitelist. Implement the spec first; fix grounded correctness, verification, API, and serious clarity issues you uncover; record meaningful deviations.

### 2. Verify the Wave

Run the wave's planned checks on affected packages and consumers. Use broader
checks when the change crosses those boundaries or the plan requires them.

Resolve regressions introduced by the task before proceeding. Attribute
failures against the task-start baseline using the review skill's procedure;
report unrelated baseline failures without expanding the task to repair them.
If a failure prevents validating the changed behavior, find an independent
check or identify the unresolved blocker. A failing command alone does not
establish which change caused it.

### 3. Review and steer

Run [adversarial-review](../adversarial-review/SKILL.md) on the cumulative implementation
and remaining plan. It owns reviewer setup, evidence, structural judgment, and
adjudication.

Resolve the checkpoint before dependent implementation starts. Rewrite remaining
waves around accepted findings and delete tasks made unnecessary by a stronger
invariant. The checkpoint may conclude that the current plan should continue
unchanged.

### 4. Record the checkpoint

Update the spec or working notes with what is now true, the verification,
accepted and consequential rejected findings, and how the remaining plan
changed. Mark completed items and remove or replace obsolete future work;
appending a discovery while leaving contradicted tasks active is plan drift.

### 5. Commit or Checkpoint the Wave

When a spec exists, include its checkpoint updates with the corresponding code
changes in each committed unit. For a conversation plan, keep the checkpoint in
working notes. Commit only when authorized by the user's request.

You do not have to create one commit per wave; use the commit shape that best fits the review, as described at the top of this skill. If the user wants one large commit, keep intermediate working checkpoints and create one final commit at the end.

For authorized commits, load `git` and `standalone-commits` for staging and
history conventions.

## Phase 4: Final Review

After all waves complete:

1. **Close against the accepted outcome.** The final checkpoint review covers
   the cumulative implementation and remaining obligations. It also serves as
   the final `post-implementation-review`; repeat only for subsequent material
   changes or unresolved findings. Verify that the result satisfies the outcome,
   rather than merely completing the latest checklist.
2. **Harvest durable decisions into `docs/adr/`.** A spec is scaffolding, not the
   durable record (see `specs/README.md` and the AGENTS.md routing). For each
   load-bearing decision the work settled (an architecture or ownership choice, an
   API shape, a rejected alternative worth not re-litigating), record it in
   `docs/adr/`:
   - If the spec already pointed at a `Proposed` ADR, flip it to `Accepted`.
   - Otherwise write a new ADR using `docs/adr/README.md`. Keep it to the one
     decision and its consequences; the spec held the exploration, the ADR holds
     the outcome.
   - A spec with no durable decision (a pure refactor or mechanical plan) needs no
     ADR. Not every spec earns one.
3. **Delete the spent spec.** Once its decisions are in ADRs and the work has
   landed, `git rm` the spec. Git keeps the body and `docs/spec-history.md` indexes
   it by date, so nothing is lost. Do not leave a finished spec in the tree as a
   knowledge base; that is the pollution this workflow exists to prevent.
4. **Verify hygiene.** Run `bun scripts/check-doc-hygiene.ts`. It must pass: no
   spec left in the tree declaring a terminal status, no `Proposed` ADR orphaned by
   a deleted spec. A failure means the harvest is incomplete; fix it (flip the ADR,
   delete the spec) rather than committing the smell.
5. **Final commit or final amend/squash** that includes the new or updated ADR and
   the spec deletion, matching the commit strategy chosen earlier.

The durable "why" now lives in the ADR; the "what landed" narrative belongs in the
pull request body. When writing the PR, load `pull-request`. Nothing durable stays behind in the spec.

## Implementation subagent prompts

The primary agent orchestrates: it plans waves, launches sub-agents when useful, verifies results, updates the spec, and commits. It may implement tightly coupled or blocking work directly when delegation would add coordination cost or risk.

Implementation agents get bounded lanes. Each needs:

- **The specific plan section** it's implementing
- **The files it should read** before making changes
- **The primary files it owns**
- **The patterns to follow** (reference relevant skills)
- **Escalation**: return cross-lane discoveries to the primary agent; it resolves
  code conflicts and decides whether missing product judgment or authorization
  requires the user

This narrow context applies to implementation agents. The independent reviewer
needs the cumulative view described in [adversarial-review](../adversarial-review/SKILL.md).

## Recover without losing the outcome

If an implementation agent crosses its lane, inspect the changes before
integrating them. Keep grounded fixes within the authorized outcome; remove
speculative edits without disturbing pre-existing work. Record consequential
discoveries in the checkpoint and revise dependent work before resuming.
