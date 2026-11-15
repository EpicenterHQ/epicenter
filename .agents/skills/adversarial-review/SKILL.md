---
name: adversarial-review
description: Independently form and test accounts of what a system should do, then work through disagreements to develop a stronger direction together. Use when asking for an adversarial review, an independent architecture review, or an adversarial checkpoint on a plan or cumulative implementation. Do not use for routine final code inspection, which belongs to post-implementation-review.
---

# Adversarial review

Form independent accounts. Work through consequential disagreements, allowing
objections to change the organizing model. Test a proposed direction against
the cases behind those objections and check that its parts work together.
Claim only the support actually established. When disagreement remains,
explain what was learned and what would decide it.

The purpose is a stronger, better-supported direction. Agreement establishes
shared support; it cannot establish that the right system is being built.
A review can reveal a better model, establish why the current one earns its
place, or clarify a choice that remains unresolved.

## Preserve independent judgment

The coordinator normally staffs three fresh, read-only reviewers: two using
the latest Codex model available in the host and one using Claude Fable, all
at high reasoning effort. Explicit user choices override this staffing.
Before staffing or coordinating the exchange, read
[the coordinator protocol](references/coordinator.md) for model selection,
briefs, evidence, and communication mechanics.

Each reviewer forms its own account from the same raw evidence before seeing
the others' conclusions. Different starting questions invite different
investigations, never assigned sides or conclusions. When proposal anchoring
is a consequential risk, form initial accounts before supplying the proposal.
A visible implementation may limit that independence; say so.

Reviewers perform their own reviews and launch no child agents. The coordinator
owns staffing and requested experiments. Read-only evidence assistance for
Claude does not add an independent seat. Hold the reviewed surface stable
until the review ends. Reviewers do not edit the live checkout.

If a reviewer is unavailable, report the limitation and continue with the
available seats. If none is available, review locally and state that it was
not independent. Routine final checks belong to post-implementation-review.

## Form and test an account

Start with the desired experience and actual or intended use. Treat the design
under review as one explanation of the problem. Develop your own account of
its natural operations and responsibilities before settling for improvements
within existing boundaries. Include relevant unchanged consumers and earlier
implementation waves; the decision determines how far to investigate.

Give that account concrete expression through caller code, an interaction,
or a data flow. Mentally inline layers to expose what consumers actually do.
Follow consequential information through creation, change, persistence,
failure, and cleanup. Check deciding claims against their sources. Distinguish
observations, hypotheses, preferences, and accepted constraints.

Compare the current design and promising alternatives through that use.
Ask what work is necessary, what the arrangement creates, and where an
alternative moves coordination or obligations. Show what disappears, what
people or callers must now do, and what is introduced or lost. Hiding the
same work behind fewer names proves little. A retained guarantee or a new
abstraction may earn its place; deletion is no required outcome.

Explicit requirements govern execution. An alternative that changes one
remains a proposal whose consequences the human judges. A counterexample
establishes a consequence; judge whether it defeats the alternative under
its proposed contract. Tests and existing decisions provide evidence about
the current contract, not proof of the best destination.

Use [rethink](../rethink/SKILL.md)'s reasoning when the organizing model needs
reconsideration: develop a better account, then return to the particulars.
Borrow [collapse-pass](../collapse-pass/SKILL.md)'s ownership and lifetime
reasoning or [product-collapse](../product-collapse/SKILL.md)'s examination of
assumed promises when useful. These serve the review without starting separate
workflows. For limiting shared premises, use
[radical options](../rethink/references/radical-options.md); for the bargain
of refusing a promise, use [asymmetric-wins](../asymmetric-wins/SKILL.md).
[Deletion prizes](references/deletion-prizes.md) illustrates those bargains.

For implemented code, use
[post-implementation-review](../post-implementation-review/SKILL.md)'s
inspection passes in review-only mode. Keep correctness blockers distinct
from architectural judgment. Attribute verification failures against the
baseline; claims that a failure predates the work need evidence.

## Develop the direction together

Share every initial account with every reviewer. Work through consequential
differences: question claims, answer objections, investigate deciding facts,
and develop concrete revisions or alternatives. Keep competing accounts live
while their consequences need investigation. A coordinator's candidate should
not force every alternative into its vocabulary.

When an objection challenges the organizing idea or the proposal keeps gaining
exceptions, examine what makes the contested work necessary. Which outcome or
promise is each side protecting? Could a different owner, lifetime, or
operation explain the work better? Give a promising reframing concrete form
and test it against the cases behind the original objections. It may dissolve
the dispute, clarify the choice, or establish why the contested work remains
necessary. Settle checkable facts directly and return evidence to everyone.
Develop the account together rather than collect objections or negotiate
assent to an unchanged proposal.

Before claiming agreement, express the combined direction concretely. Check
that its parts jointly deliver the stated behavior under compatible
consequential assumptions, including the sequences behind the objections.
Support for separate decisions does not establish support for their combination.
Reviewers may explain the same behavior differently; their contracts must
still be compatible.

A direction is agreed only when every participating reviewer explicitly
supports that same concrete next direction, its deciding claims have been
checked, and meaningful objections are resolved. The coordinator's synthesis
or a majority cannot substitute for that support. Never press a reviewer to
assent or drop a real objection; silence is not support. Never add reviewers
to outnumber an objection or obtain endorsement. A standing objection means
the direction is not agreed. State conditions on support and distinguish a
conditional recommendation from a verified guarantee.

End without convergence when the group has investigated the reframings its
disagreement suggests and a consequential disagreement remains that further
exchange cannot settle with the available evidence or authority. Explain what
was tried, what changed, and what evidence or human judgment would decide it.
Agreement to ask the person a question is agreement on the question, not on
the design. A deadline supplies no reason to assent. Ending the review does
not approve disputed implementation; unresolved correctness or safety
objections still block acceptance.

## Return the developed account

Lead with the scope of support: what direction is agreed, what is conditional,
and what remains not converged. Make clear when common ground does not approve
a complete design. Present one coherent account of what the group developed,
including the reframings tried, deciding evidence, and remaining disagreement.
Separate reviewer reports do not replace that shared work.

Show the behavior, what becomes simpler or more capable, and the costs or
obligations that remain. When a product preference decides the choice, present
the real alternatives and consequences for the human to judge. Explain why
consequential findings were accepted, rejected, or deferred, and what changes
in remaining plans. Separate actual verification from sketches, proposed
checks, and unverified conditions. Choose a presentation that makes the
decision easy to assess. See [the example workflow](references/example-workflow.md)
for worked exchanges and returns.

Explain accepted findings before editing. Carry authorized repairs through
implementation and verification; bring changes to the accepted outcome or
unresolved product choices to the user. The
[coordinator protocol](references/coordinator.md#continue-after-review)
covers checks after repairs and when to return to the group.
