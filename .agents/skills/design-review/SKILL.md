---
name: design-review
description: Independently reassess an affected design and recommend the next structural decision. Use when asking for a design review, an independent architecture review, or an adversarial checkpoint on a plan or cumulative implementation. Routine final code inspection belongs to post-implementation-review.
---

# Design review

Independently reconstruct the affected design, then ask: given what we know now,
what stronger invariant or different ownership boundary would make this simpler,
and what should we do next?

The accepted outcome anchors the review. Existing helpers, file splits, API
shapes, and remaining tasks are hypotheses to test. Look for deletion prizes
and collapses that local implementation work can miss.

Success is a better-supported next decision. Count complexity introduced as
well as removed. A larger rewrite, more findings, or disagreement with the
implementer is not evidence of a better review. Keeping the design is valid.

## Establish independence

The coordinating agent starts one read-only reviewer that did not implement
the work, with a fresh context. Use the runtime's available GPT-6 model with
high reasoning. If unavailable, use the strongest available reviewer and
disclose the substitution. Independent review requires subagent tools; if they
are unavailable, perform the pass locally and state that it was not independent.
Do not invoke Claude unless the user explicitly requests it.

Give the reviewer raw artifacts and open questions, without the implementer's
preferred conclusion:

- The accepted outcome, explicit constraints, and decision to be examined.
- The plan and remaining work, including newly discovered facts.
- For implementation, the task-start baseline and cumulative diff, including
  task-owned uncommitted and untracked files. Distinguish unrelated work.
- Relevant entrypoints, consumers, tests, and verification results. A summary
  alone is not sufficient evidence.

For a proposal without implementation, supply the proposal and any existing
system it would replace. Distinguish observed behavior from design assumptions;
name what a prototype or caller would need to establish.

Hold the reviewed surface stable until the reviewer returns. Use that interval
for verification preparation or an independent question outside the surface.
Do not begin work whose shape depends on the verdict.

The reviewer does not edit the live checkout or launch child agents. If you
received this skill as the delegated reviewer, perform the review yourself.
Additional reviewers need distinct unresolved questions; dividing this review
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

Product changes remain proposals for user judgment. A deletion prize does not
authorize dropping required behavior, data guarantees, or explicit constraints.

## Return a decision

Lead with the strongest grounded opportunity, or explain why the current
boundaries earn their place. Include:

- Current and proposed shape, with both file trees when organization changes.
- Concrete file or caller evidence, the stronger invariant and its owner,
  and behavior that must survive.
- The deletion prize, complexity introduced, and any user loss.
- Which remaining tasks should change or disappear, if a plan exists.
- Verification that would distinguish improvement from displaced complexity,
  including assumptions that remain unproven.

Report correctness blockers separately so an attractive collapse cannot hide
a regression. Attribute verification failures using the agreed review baseline;
the code inspection skill owns that procedure. Do not call a failure pre-existing
without evidence.

## Adjudicate and continue

The coordinating agent verifies findings against current artifacts and accepts,
rejects, or defers them with reasons. Explain accepted findings before editing.
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
