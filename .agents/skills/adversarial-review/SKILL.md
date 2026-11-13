---
name: adversarial-review
description: Independently form and test models of what a system should do, challenge the design against them, and work as a review group toward an agreed direction. Use when asking for an adversarial review, an independent architecture review, or an adversarial checkpoint on a plan or cumulative implementation. Do not use for routine final code inspection, which belongs to post-implementation-review.
---

# Adversarial review

Independently develop an account of what the system should do from the desired
experience and actual use. Treat the design under review as one explanation of
the problem. Form a grounded judgment about the organizing idea before settling
for improvements within its existing concepts and boundaries.

Give that account concrete expression and compare it with the proposed or
implemented design. Ask which work is necessary and which problems arise from
the arrangement itself. A review can reveal a stronger model, establish why the
current one earns its place, or identify the fact that decides between them.
Passing tests, plausible abstractions, and reviewer agreement cannot establish
that the right system is being built.

Success is a better-supported next direction that every participating reviewer
can explicitly support. Judge the desired experience, coherence, guarantees,
total complexity, and consequences together. Make deletion prizes concrete where
they arise; a new abstraction or a retained guarantee may also be essential to
the better design.

## Establish independence

If you are a reviewer in the group, perform the review yourself and launch no
child agents; staffing belongs to the coordinator. Exchange findings and
objections with the other reviewers directly where your tooling supports it,
and otherwise through the coordinator. The following setup belongs to the
coordinating agent.

The coordinator normally staffs three read-only seats. Two are fresh Codex
subagents using the runtime's available GPT-6 model, each with
`fork_turns: "none"` and `reasoning_effort: "high"`. The third is a fresh,
read-only Claude Opus reviewer through
[consult-claude](../consult-claude/SKILL.md). Explicit user choices override
this staffing. If a reviewer is unavailable, report the limitation and continue
with the available seats. If none is available, perform the review locally and
state that it was not independent. Ordinary final checks remain local under
post-implementation-review; a routine edit does not earn this review.

Give every reviewer the same raw evidence and a different starting question.
Run them in parallel when possible. Withhold each reviewer's conclusions from
the others until all initial accounts arrive; the exchange that follows builds
on independent thought rather than replacing it.

Codex reviewer one starts with:

> From the desired experience and actual use, what should this system be? Develop
> your own account of its natural operations and responsibilities, then compare
> it with the design under review. Which problems disappear under that account,
> and what work, guarantees, or costs remain?

Codex reviewer two starts with:

> Follow actual or intended users through the work this system must support.
> Read existing callers as evidence of need rather than of the right operations.
> Develop your own account of what belongs together and what its operations
> mean. Test that account and the design under review against consequential
> sequences. Which requirements reflect necessary outcomes, and which reflect
> an assumed solution? Show the bargain behind your recommendation.

The Claude reviewer starts with:

> Find the premises the design under review shares with its obvious
> alternatives: about ownership, lifetime, representation, or what is promised
> to people. Which premise accounts for the most machinery, and what would you
> build if it were false? Develop your own account and test it against the
> strongest case for the current design. If the evidence points to a better
> question, pursue that instead.

These are starting questions, not assigned conclusions. Any reviewer can
originate a different model, challenge the framing it was given, or establish
that the current one is strongest.

Provide the desired outcome, explicit requirements, actual or intended callers,
relevant entrypoints, and existing system. Include the task-start baseline and cumulative
diff for implementation reviews, distinguishing task-owned uncommitted and
untracked files from unrelated work. Supply verification results, remaining
plans, and open questions. Distinguish observations, hypotheses, preferences,
and accepted constraints. A summary alone is insufficient evidence.

When anchoring on a proposal is a consequential risk, first supply the outcome,
requirements, callers, and existing system without the proposed API or rationale.
Preserve each independent account, then supply the proposal for comparison.
For implemented work, the checkout may already reveal the proposal; describe
that limitation honestly. Independence concerns the reasoning as well as access
to evidence. Reviewers should investigate rather than adopt the implementer's
explanation as their frame.

The Claude reviewer may use host-provided read-only Codex evidence assistance
while retaining the judgment and checking deciding sources. This helper gathers
evidence; it is not another independent reviewer. Codex owns requested experiments.

Hold the reviewed surface stable until the review closes. Use that interval for
verification preparation or independent work whose shape does not depend on
the verdict. Reviewers do not edit the live checkout.

## Form and test the model

Understand the relevant workflow through actual or intended use, entrypoints,
ownership, information, and lifetimes. Include relevant unchanged consumers and
earlier implementation waves. Expand far enough to establish consequences; the review's
decision determines its scope.

Articulate what the system enables and show natural use. Derive the concepts and
boundaries that account for that work. Read the current arrangement as evidence:
mentally inline helpers, wrappers, components, and forwarding layers to expose
what consumers actually do. Trace important information through creation, change,
persistence, failure, and cleanup. Follow findings to deciding sources.

For implemented code, use
[post-implementation-review](../post-implementation-review/SKILL.md)'s inspection
passes in review-only mode. This supplies code inspection without initiating
another independent review. Keep correctness blockers visible separately from
the architectural judgment, and attribute verification failures using the
agreed baseline. Claims that a failure predates the work need evidence.

Examine whether the current model explains necessary work or creates problems
that its machinery then solves. Reconsider ownership, lifecycle, representation,
operations, and guarantees together when their relationships reveal a different
organizing idea. Use [rethink](../rethink/SKILL.md)'s design reasoning to develop
that idea far enough to judge. Execution belongs to the coordinator.

Give a promising alternative concrete expression through caller code, an
interaction, or a data flow. Follow the consequences far enough to expose work
hidden behind an attractive entrypoint. Compare what someone must understand
and do, how information is preserved or lost, and where coordination moves.
Name the machinery and planned work that disappear and any abstractions or
obligations introduced. Hiding the same work behind fewer names proves little.

Explicit requirements continue to govern execution. An alternative that changes
one remains a proposal: state the conflict and the resulting experience. Trace
guarantees to the outcomes they serve so the human can judge the bargain. A
counterexample establishes a consequence; judge whether that consequence defeats
the alternative under its proposed contract. Tests and existing decisions carry
evidence about the current contract, not proof that it is the best destination.

Use [radical options](../rethink/references/radical-options.md) when apparent
alternatives share a limiting premise. Use
[asymmetric-wins](../asymmetric-wins/SKILL.md) when refusing a particular promise
is the central bargain. Read [deletion prizes](references/deletion-prizes.md)
for examples where changing a lifetime or operating rule removes coordination.
These are ways to investigate, not a requirement to remove a guarantee or find
a smaller design in every review.

## Work toward an agreed direction

Once the initial accounts arrive, the reviewers work as one group. Share every
account with every reviewer. Reviewers exchange findings, question one
another's claims, answer objections, and revise a single concrete proposed
direction: retain the design, change it in a stated way, or combine elements of
competing accounts. Name the claim, model, or product judgment behind each
consequential disagreement. When a dispute persists or a direction keeps gaining
exceptions, treat that as a clue that the contested work may be downstream of an
inherited choice. Reconstruct the work from the desired outcome. Ask what makes
it necessary: a process that changes live state in place, an ownership boundary,
a lifetime, or a promise. Consider whether changing that choice makes the
dispute and its exceptions unnecessary. Give the alternative concrete expression
and check what disappears, what people or callers must now do, and what it costs.
Test it against the cases behind the objections before returning to the local
dispute. Some disagreements turn on a checkable fact, and some exceptions
protect a necessary distinction; settle those directly.

Reviewers may message one another directly where the available tooling supports
it. Otherwise the coordinator relays substantive messages: findings, questions,
evidence, objections, and replies, attributed to their author and passed on
without summarizing away the reasoning. A Claude reviewer receives them at
completed-turn boundaries by resuming its session; it has no mid-turn channel.
Communication does not let a reviewer launch another; the coordinator alone
adds reviewers.

Verify deciding claims against actual artifacts. Prefer a focused caller trace,
counterexample, or experiment when it can settle a disputed claim directly, and
return the result to every reviewer. Keep adding reviewers as unresolved
questions, competing models, or needed expertise demand. Three seats is a
starting point, not a cap. Give each added reviewer the shared evidence and the
question it joins to answer. When anchoring is a consequential risk, let it form
its own account before it reads the group's current direction and open
objections. Exchanges should test claims rather than repeat broad reviews.

The review closes when every participating reviewer explicitly supports the
same concrete next direction, its deciding claims have been checked, and
meaningful objections are resolved. Reviewers need not share identical
reasoning, and the direction may revise or combine earlier alternatives. The
coordinator does not substitute its own synthesis or a majority for that
agreement. Never press a reviewer to assent or to drop a real objection; a
standing objection keeps the review open. Agreement marks completion, not
correctness, so the deciding claims still need evidence. A direction can carry
an explicit condition, such as a check that must pass first.

When agreement depends on a product judgment only the human can make, or on
evidence the group cannot reach, bring that specific blocker to the user with
the alternatives and their consequences. Do not report the review as complete
or describe a direction as agreed until every reviewer supports it.

## Return a decision and continue

Lead with the group's agreed direction: retain the design, change it, or resolve
a consequential tradeoff. Show the concrete behavior and evidence that make that
decision matter. When the choice depends on a product preference the evidence
cannot establish, present the alternatives and their consequences for the human
to judge. Carry what that judgment reveals through the affected design. Explain
what becomes simpler or more capable, what disappears, and what costs or
obligations remain. Give the human enough to assess the bargain without
reconstructing reviewer reports. Name required changes to remaining plans.
Record which findings the group accepted, rejected, or deferred, and why.

Support the recommendation with deciding caller or implementation evidence,
verification performed, and the next discriminating check for consequential
uncertainty. Report actual results separately from sketches or proposed checks.
Use diagrams, file trees, or comparisons where they expose the design. Read
[the example workflow](references/example-workflow.md) for how a group reaches
agreement and how retaining the current design can win.

Explain accepted findings before editing. Carry repairs within existing
authorization through implementation and verification; bring changes to the
accepted outcome or unresolved product choices to the user. After repairs, use
[post-implementation-review](../post-implementation-review/SKILL.md#output-shape)'s
local post-edit checks on every repaired file. Rewrite remaining work around the
resulting design and delete obsolete tasks.

Return to the group when repairs materially change reviewed ownership or expose
unresolved risk. Once the agreed direction is carried through and its
consequential findings are resolved, resume remaining assigned work.
