---
name: adversarial-review
description: Independently form and test a model of what a system should do, then challenge the design against it. Use when asking for an adversarial review, an independent architecture review, or an adversarial checkpoint on a plan or cumulative implementation. Do not use for routine final code inspection, which belongs to post-implementation-review.
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

Success is a better-supported next decision. Judge the desired experience,
coherence, guarantees, total complexity, and consequences together. Make deletion
prizes concrete where they arise; a new abstraction or a retained guarantee may
also be essential to the better design.

## Establish independence

If you are already the delegated reviewer, perform the review yourself and
launch no child agents. The following setup belongs to the coordinating agent.

The coordinator normally staffs three read-only seats. Two are fresh Codex
subagents using the runtime's available GPT-6 model, each with
`fork_turns: "none"` and `reasoning_effort: "high"`. The third is a fresh,
read-only Claude Opus reviewer through
[consult-claude](../consult-claude/SKILL.md). Include it without waiting for the
user to name Claude. Explicit user choices override this staffing. If a reviewer is unavailable, report the limitation and continue
with the available seats. If none is available, perform the review locally and
state that it was not independent. Ordinary final checks remain local under
post-implementation-review; a routine edit does not earn this review.

Give every reviewer the same raw evidence and a different starting question.
Run them in parallel when possible. Withhold each reviewer's conclusions from
the others until all initial answers arrive.

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

Hold the reviewed surface stable until reviewers return. Use that interval for
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

## Reconcile the independent accounts

The coordinator compares the reviewers' accounts as well as their findings.
Identify the claim, model, or product judgment behind consequential
disagreement. When the reviewers share a premise responsible for substantial
machinery, examine its support and what an alternative account would make
possible. Agreement alone neither closes the question nor requires another
review.

Verify deciding claims against actual artifacts. Prefer a focused caller trace,
counterexample, or experiment when it can settle the uncertainty directly.
Grow the reviewer group when findings expose a distinct unresolved question or
another independent angle could materially improve the decision, such as when
the initial reviews remain within the same unexamined model. There is no fixed
seat count, and adding a reviewer within the task's scope needs no further user
permission. Name the question each added reviewer answers and supply the
deciding evidence. Stop when the decision is supported; unanimity and
exhausting every angle are not the goal. Avoid repeating broad reviews to
obtain a collapse or unanimous approval.

Reconcile the evidence into one recommendation while preserving consequential
disagreement. Accept, reject, or defer findings with reasons. Keep conditions
beside the claims they qualify; a promising direction may still depend on an
unproven fact.

## Return a decision and continue

Lead with the best-supported next decision: retain the design, change it, or
resolve a consequential tradeoff. Show the concrete behavior and evidence that
make that decision matter. When the choice depends on a product preference the
evidence cannot establish, present the alternatives and their consequences for
the human to judge. Carry what that judgment reveals through the affected design.
Explain what becomes simpler or more capable, what disappears, and what costs or
obligations remain. Give the human enough to assess the bargain without
reconstructing reviewer reports. Name required changes to remaining plans.

Support the recommendation with deciding caller or implementation evidence,
verification performed, and the next discriminating check for consequential
uncertainty. Report actual results separately from sketches or proposed checks.
Use diagrams, file trees, or comparisons where they expose the design. Read
[the example workflow](references/example-workflow.md) for how findings become
a recommendation and how retaining the current design can win.

Explain accepted findings before editing. Carry repairs within existing
authorization through implementation and verification; bring changes to the
accepted outcome or unresolved product choices to the user. After repairs, use
[post-implementation-review](../post-implementation-review/SKILL.md#output-shape)'s
local post-edit checks on every repaired file. Rewrite remaining work around the
resulting design and delete obsolete tasks.

Request a focused follow-up when repairs materially change reviewed ownership
or expose unresolved risk. Close when the consequential findings are resolved
and the next step has a defensible shape, then resume remaining assigned work.
