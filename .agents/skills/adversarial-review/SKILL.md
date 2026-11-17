---
name: adversarial-review
description: Independently pursue the strongest greenfield design, then use the findings to develop and test it further. Use when asking for an adversarial review, an independent architecture review, or an adversarial checkpoint on a vision, plan, or cumulative implementation. Routine final code inspection belongs to post-implementation-review.
---

# Adversarial review

Pursue the strongest greenfield design for the subject we’re reviewing. Work out
what we would build from scratch and why, then let the recommendation follow
from that understanding.

Begin from the shared intent in the brief. Bring questions that could change
that intent back to the person through the coordinator.

Before staffing or coordinating a review, read the
[coordinator protocol](references/coordinator.md).
Reviewers work read-only and perform the review themselves, without launching
child agents. See the [example workflow](references/example-workflow.md)
for worked exchanges and recommendations.

## Think independently

Read the person's request, actual or intended use, and source evidence before
seeing other reviewers' conclusions. Understand why the existing system works
as it does, including relevant callers and earlier implementation work. Treat
the current system as evidence about the problem, not the boundary of the solution.

Show the design through an interaction, caller code, or data flow. Follow what
happens as information is created, changed, saved, lost, or cleaned up. Separate
what the sources establish from what you assume or prefer.

Compare what each design makes people and callers do. Show what work disappears,
what moves elsewhere, what is introduced, and what people gain or lose. Include
the cost of changing systems. Work transferred to a person still counts.
Judge objections against what each alternative actually promises.
See [deletion prizes](references/deletion-prizes.md)
for examples of these tradeoffs.

For implemented code, use [post-implementation-review](../post-implementation-review/SKILL.md)'s
inspection passes in review-only mode. Keep correctness failures separate from
design judgments. Check the baseline before saying a failure predates the work.

## Carry the design forward

The coordinator works with the person to pursue the strongest greenfield
design. Use the reviewers' independent thinking to deepen and challenge your
understanding of what we should build and why. Carry that understanding into
the design and take responsibility for how its parts work together.

Let what you learn change the design. Use [rethink](../rethink/SKILL.md)'s
reasoning to reconsider the whole. When findings reopen what we are trying
to make possible, use [dialectic](../dialectic/SKILL.md) with the person to
revisit the intent.

Show how the proposed design would work and check the facts it depends on.
Test it as a whole, including the situations behind reviewers' concerns.
Return meaningful revisions to the reviewers they affect and use their
responses to develop it further.

Work toward a design every reviewer can support. If investigation cannot
advance an important disagreement, bring it to the person. Explain what
was tried, what you learned, and what evidence or judgment would decide it.

## Explain what the review supports

Show the design you arrived at, how the independent findings shaped it, and
what you learned. Then give the person a recommendation, including its reasoning,
evidence, costs, and remaining uncertainty. Keeping the current design can be
the right recommendation.

Explain important objections, how the evidence answers them, and what remains
open. Separate verified results from sketches and checks still to run.

Seek a design every reviewer can support. Call it agreed only when each reviewer
has examined and explicitly supported the same concrete proposal. Say what
they support and any conditions that remain.

A review can end with an unresolved disagreement. Agreement does not prove
correctness; check the claims the recommendation depends on. An unresolved
correctness or safety blocker still prevents accepting the design.
