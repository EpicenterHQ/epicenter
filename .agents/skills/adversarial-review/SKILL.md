---
name: adversarial-review
description: Independently challenge a design and its underlying model to find deletion prizes and stronger invariants. Use when asking for an adversarial review, an independent architecture review, or an adversarial checkpoint on a plan or cumulative implementation. Do not use for routine final code inspection, which belongs to post-implementation-review.
---

# Adversarial review

Independently reconstruct the affected system, then hunt for the decision that
would make a whole family of code or planned work unnecessary. Ask what stronger
invariant, different owner, or smaller promise would let the system collapse.
Passing tests and individually defensible abstractions do not settle whether
the model deserves to survive.

Hold the user's desired outcome steady while challenging the implementation,
remaining plan, and inherited requirements. Reconstruct from actual callers so
the implementer's explanation does not become the reviewer's frame. Even when
no bugs are apparent, construct a concrete smaller alternative to stress-test
the current design. Zoom out when local cleanup leaves the machinery intact.

Success is a better-supported next decision. Count complexity introduced as
well as removed, including work transferred to the user. Keeping the design is
valid after testing the alternative; neither forced disagreement nor deletion
at any cost is the job.

## Establish independence

If you are already the delegated reviewer, perform the review yourself and
launch no child agents. The following setup belongs to the coordinating agent.

The coordinating agent appoints two read-only reviewers by default: a fresh
Codex subagent using the runtime's available GPT-6 model with
`fork_turns: "none"` and `reasoning_effort: "high"`, and Claude through
[consult-claude](../consult-claude/SKILL.md), which owns the Fable model default
and access boundary. This repository authorizes both for adversarial review;
an explicit user restriction overrides that default. Ordinary final checks
remain local under post-implementation-review.

Give both reviewers the same evidence and whole design question. Run them in
parallel when possible, and withhold each reviewer's findings from the other
until both initial verdicts arrive. Claude's participation does not depend on
Codex first finding an unresolved question: another model may find the question
Codex missed. If either reviewer is unavailable, report the missing perspective
and continue with the available review; a local pass is not independent.

Give each reviewer raw artifacts, concrete proposals, engineering reasoning, and
open questions. Distinguish facts, hypotheses, preferences, and accepted
constraints; the implementer's reasoning is contestable evidence, not the answer:

- The accepted outcome, explicit constraints, and decision to be examined.
- The plan and remaining work, including newly discovered facts.
- For implementation, the task-start baseline and cumulative diff, including
  task-owned uncommitted and untracked files. Distinguish unrelated work.
- Relevant entrypoints, consumers, tests, and verification results. A summary
  alone is not sufficient evidence.

Include actual and proposed code, representative callsites, and an ASCII diagram
when it clarifies the design. Ask what the reviewer would build from the desired
outcome and actual callers if the current abstraction did not exist. Both
reviewers apply this review method themselves without launching more reviewers.
Codex owns any requested experiments.

For a proposal without implementation, supply the proposal and any existing
system it would replace. Distinguish observed behavior from design assumptions;
name what a prototype or caller would need to establish.

Hold the reviewed surface stable until both reviewers return. Use that interval
for verification preparation or an independent question outside the surface.
Do not begin work whose shape depends on the verdict.

Neither reviewer edits the live checkout.
Reviewers beyond this pair need distinct unresolved questions; dividing this review
into file lanes would hide the relationships it is meant to examine.

## Reconstruct before judging

Trace the affected design through its entrypoints, callers, owners, lifecycle,
and invariants. Include earlier implementation waves and relevant unchanged
consumers. Expand only far enough to establish the owner and consequences;
this is not a repository-wide audit.

List every file read as an ASCII tree before analysis. Mentally inline helpers,
wrappers, components, props, compartments, and file boundaries into their call
sites. Read the resulting behavior as if encountering it for the first time.

For implemented code, apply
[post-implementation-review](../post-implementation-review/SKILL.md)'s inspection
passes in review-only mode: first read, mental inlining, ownership, smells,
invariants, API shape, naming, and file organization. This supplies the code
inspection; it does not initiate another independent review.

## Find the deletion prize

Ask what the local complexity is compensating for. Would moving an invariant
to construction, giving one object the lifecycle, or removing a stale promise
make a family of adapters, flags, callbacks, checks, or future tasks disappear?
Challenge new abstractions as readily as inherited ones.

Make the prize concrete: name the methods, types, modules, states, tests, docs
branches, or planned work that becomes unnecessary. Explain the replacement
guarantee. Fewer files alone proves little if callers inherit the same work or
lose a useful boundary. Preserve tests for behavior that must survive.

A compact implementation can still implement a bloated model. Challenge the
promise that requires the machinery, including previously accepted architecture
and product assumptions. Bring consequential tradeoffs to the human even when
they go beyond the current implementation plan; the reviewer proposes them
without treating them as authorized changes.

Distinguish a guarantee the software enforces from an obligation the user must
fulfill. For a proposed obligation, name the steps, what happens if they are
missed, and which guarantee the product can no longer claim. Moving work to a
person may be an excellent bargain, but that work remains part of the cost.
When exploring lifecycle resets or user-owned operations that eliminate
coordination, read [references/deletion-prizes.md](references/deletion-prizes.md).

Use focused skills for deeper decisions, without copying their procedures:

- [radical-options](../radical-options/SKILL.md) when local fixes preserve a bad
  abstraction and the better design may sit one level above it.
- [asymmetric-wins](../asymmetric-wins/SKILL.md) when refusing a small promise
  could delete a disproportionate code family. Name who loses what.
- [greenfield-clean-breaks](../greenfield-clean-breaks/SKILL.md) when the finding
  changes ownership, lifecycle, public contracts, or package boundaries. Use
  its design reasoning here; execution belongs to the coordinating agent.

Recommend a [collapse-pass](../collapse-pass/SKILL.md) when the evidence calls
for sustained removal of unearned indirection. The reviewer identifies the
opportunity; it does not begin that skill's editing or commit loop.

Product changes remain proposals for user judgment. Explicit user constraints
bound execution; surface a conflicting opportunity as a tradeoff rather than
silently dropping required behavior or data guarantees.

## Return a decision

Lead with the strongest grounded opportunity, or explain why the current
boundaries earn their place. Include:

- Current and proposed shape, with both file trees when organization changes.
- Concrete file or caller evidence, the stronger invariant and its owner,
  and behavior that must survive.
- The concrete smaller alternative, deletion prize, complexity introduced,
  and any user loss or obligation. Explain why the alternative wins or loses.
- Which remaining tasks should change or disappear, if a plan exists.
- Verification that would distinguish improvement from displaced complexity,
  including assumptions that remain unproven.

Report correctness blockers separately so an attractive collapse cannot hide
a regression. Attribute verification failures using the agreed review baseline;
the code inspection skill owns that procedure. Do not call a failure pre-existing
without evidence.

## Adjudicate and continue

The coordinating agent reconciles both reviews into one recommendation,
preserving consequential disagreement. Verify findings against current artifacts
and accept, reject, or defer them with reasons; agreement is not a correctness
test. Explain accepted findings before editing.
Implement and verify repairs within existing authorization; bring changes to
the accepted outcome or unresolved product judgment to the user.

After repairs, apply [post-implementation-review](../post-implementation-review/SKILL.md#output-shape)'s
local post-edit checks to every repaired file before closing the review.

When executing a plan, rewrite remaining work around the resulting design and
delete obsolete tasks. [spec-execution](../spec-execution/SKILL.md) owns wave
cadence and checkpoint records.

Request a focused follow-up when repairs materially change reviewed ownership
or expose an unresolved risk. Stop when grounded findings are resolved and the
next step has a defensible shape. Do not repeat reviews to obtain a collapse or
unanimous approval.
