---
name: adversarial-review
description: Independently pursue the strongest greenfield design, challenge the underlying model, find concrete deletion prizes, and work as a review group toward an agreed direction. Use when asking for an adversarial review, an independent architecture review, or an adversarial checkpoint on a plan or cumulative implementation. Do not use for routine final code inspection, which belongs to post-implementation-review.
---

# Adversarial review

Independently pursue the strongest greenfield design from the desired outcome
and actual users and callers. Hold that outcome steady while questioning the
organizing idea, boundaries, ownership, lifecycle, representation, and inherited
promises. Reconstruct the system as evidence about the problem, not the boundary
of the solution. Develop a concrete vision of what you would build if the current
abstraction did not exist, even when no bugs are apparent.

Make the deletion prize concrete: what machinery, obligations, or planned work
becomes unnecessary, and what stronger guarantee replaces it? The strongest
design may introduce an abstraction that earns its place. Judge the whole
bargain; fewer parts alone do not establish improvement. Keep migration cost
visible without letting it define the destination before exploring that design.

Success is a better-supported next direction that every participating reviewer
can explicitly support. Count complexity introduced as well as removed,
including work transferred to the user. Keeping the design is
valid after testing the alternative. Passing tests and individually defensible
abstractions do not settle whether the model deserves to survive; forced
disagreement and deletion at any cost do not establish improvement either.

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

> Starting from the desired outcome and actual users and callers, what is the
> strongest greenfield design? Reconsider the organizing idea, ownership,
> lifecycle, representation, and promises. Show concrete use, the deletion prize,
> the replacement guarantees, and the complexity introduced.

Codex reviewer two starts with:

> Independently develop the strongest greenfield design. What must it preserve
> to be worth adopting? Trace concrete callers and lifecycle sequences to find
> the guarantees the current complexity provides. Which matter to the user,
> and which are inherited assumptions? Show where an alternative would break
> a necessary guarantee or move the burden onto someone else.

The Claude reviewer starts with:

> Find the premises the design under review shares with its obvious
> alternatives: about ownership, lifetime, representation, or what is promised
> to people. Which premise accounts for the most machinery, and what would you
> build if it were false? Develop your own account and test it against the
> strongest case for the current design. If the evidence points to a better
> question, pursue that instead.

These are starting questions, not assigned conclusions or separate file lanes.
Reviewer two explores alternatives without waiting for reviewer one's proposal.
Any reviewer can discover a better design, challenge its starting frame, or
conclude that the current boundaries earn their place.

When reviewing a design before implementation, first give each reviewer the
desired outcome, explicit requirements, actual callers, and existing system,
without the implementer's proposed design or rationale. Ask each to sketch the
strongest greenfield design and name what it deletes and introduces. Preserve
their independent initial answers. Then provide the full proposal and reasoning
to each reviewer for a challenge against those answers. This ordering tests
whether the proposal anchored the search. For implemented work, the current
checkout may already expose the proposal; do not claim that the first pass was
blind. Start from the outcome, actual callers, and task-start baseline when
available. Explore the
destination before narrowing to critique of the cumulative diff.

Give each reviewer raw artifacts, concrete proposals, engineering reasoning, and
open questions in the full-proposal pass. Distinguish facts, hypotheses,
preferences, and accepted constraints; the implementer's reasoning is
contestable evidence, not the answer:

- The accepted outcome, explicit constraints, and decision to be examined.
- The plan and remaining work, including newly discovered facts.
- For implementation, the task-start baseline and cumulative diff, including
  task-owned uncommitted and untracked files. Distinguish unrelated work.
- Relevant entrypoints, consumers, tests, and verification results. A summary
  alone is not sufficient evidence.

Include actual and proposed code, representative callsites, and an ASCII diagram
when it clarifies the design. Ask what the reviewer would build from the desired
outcome and actual callers if the current abstraction did not exist. All
reviewers apply this review method themselves without launching more reviewers.
They may propose follow-up investigations; the coordinator commissions them.
Codex owns verification and can assign bounded experiments through
[delegate-claude](../delegate-claude/SKILL.md) within the parent task's
authorization, with Codex implementing substantial changes under Claude's
direction.

For a proposal without implementation, supply the proposal and any existing
system it would replace. Distinguish observed behavior from design assumptions;
name what a prototype or caller would need to establish.

A Claude reviewer may use host-provided read-only Codex evidence
assistance, while retaining the review judgment and checking deciding sources.
That helper is an evidence gatherer, not an additional independent reviewer.

Hold the reviewed surface stable until the review closes. Use that
interval for verification preparation or an independent question outside the surface.
Do not begin work whose shape depends on the verdict.

Reviewers do not edit the live checkout.

## Manage the search

Once the initial accounts arrive, the reviewers work as one group. Share every
account with every reviewer. Reviewers exchange findings, question one
another's claims, answer objections, and revise a single concrete proposed
direction: retain the design, change it in a stated way, or combine elements of
competing accounts. Name the claim, model, or product judgment behind each
consequential disagreement. When the reviewers share a premise responsible for
substantial machinery, examine its support and what an alternative account
would make possible.

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

Actively manage assignments while the group discusses the direction. Clarify
questions, supply new evidence, correct factual misunderstandings, and redirect
duplicated work. If a reviewer stops at local cleanup, ask what makes the model
necessary and what different organizing idea would eliminate it. Preserve useful
findings and state the new question when redirecting, without prescribing a
conclusion. Parallel exploration can broaden the search; focused follow-ups
can test an emerging alternative or the group's synthesis.

## Reconstruct before judging

Start from the desired outcome and actual use. Map the concepts, operations,
callers, ownership, and lifetimes someone must understand. Show where information
lives, how it moves, and which relationships require coordination. Choose a
representation that exposes those relationships; a file list alone is
insufficient.

Mentally inline helpers, wrappers, components, props, extracted types, and
forwarding layers into their consumers. Read the resulting behavior afresh.
Which boundaries explain necessary work, and which merely preserve an earlier
arrangement?

Investigate rather than relying on the presented diff. Search for callers, dead
paths, mirrored state, repeated decisions, compatibility branches, and related
implementations. Trace findings through construction, reads, writes, and cleanup.
Use search matches as leads, not proof that something should disappear.

Challenge the guarantees themselves. Who needs each promise, what does it
enable, and what machinery does it require? Develop alternatives that remove,
narrow, or replace promises as well as implementations. Show the resulting
caller experience, complexity introduced and removed, and any user loss or
obligation. Changes to explicit requirements remain proposals for the user's
judgment.

## Find the deletion prize

Visibly list and explain the methods and concepts someone must understand,
then ask whether the same job could be done with fewer concepts. Use the
[concept inventory](../collapse-pass/references/concept-inventory.md) to compare
the current model with a concrete alternative, including a different design
that makes several concepts unnecessary together. Reuse an inventory from the
inspection rather than making another one.

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

- [Repairability](../rethink/references/repairability.md) when file-authoritative
  workflows coordinate to prevent inconsistencies. Identify what information
  the machinery protects and show the proposed repair path. Verification is
  required before removing protections.
- [Rethink's radical-options reference](../rethink/references/radical-options.md)
  when local fixes preserve a bad abstraction and the better design may sit one
  level above it.
- [asymmetric-wins](../asymmetric-wins/SKILL.md) when refusing a small promise
  could delete a disproportionate code family. Name who loses what.
- [rethink](../rethink/SKILL.md) when the finding
  changes ownership, lifecycle, public contracts, or package boundaries. Use
  its design reasoning here; execution belongs to the coordinating agent.

Recommend a [collapse-pass](../collapse-pass/SKILL.md) when the evidence calls
for sustained removal of unearned indirection. The reviewer identifies the
opportunity; it does not begin that skill's editing or commit loop.

Product changes remain proposals for user judgment. Explicit user constraints
bound execution; surface a conflicting opportunity as a tradeoff rather than
silently dropping required behavior or data guarantees.

## Return a decision

Lead with the group's agreed direction, whether it changes the current design
or keeps it. Show the mechanism and why it wins. Name the deletion prize when
there is one: the machinery or planned work that would disappear, and the replacement
guarantee. Explain the cost as a concrete consequence, such as losing unsaved
work, and what complexity a mitigation would retain or introduce. When keeping
the design, show the strongest deletion prize considered and why its cost makes
retention worthwhile.

Give each serious alternative enough shape to judge on its own. A compact ASCII
diagram can expose ownership or lifecycle; a code block can show an API; bullets
or a small table can distinguish multiple options. Use bold text to expose a
recommendation or requirement warning when it helps scanning. Do not force a
fixed number of options or headings. If one path clearly wins, explain it and
include only alternatives that illuminate the decision. Label any option that
conflicts with an explicit user requirement as a proposed requirement change,
and include the strongest compliant path when one is viable.

State downsides, remaining uncertainty, and the next discriminating check where
they affect the judgment. Give the current best estimate instead of listing
unknowns without analysis. Codex owns checks it can perform; do not hand the
user homework. Ask the user only about a product choice that evidence cannot
settle. Keep precise design terms and make their consequences understandable.

Read [the example workflow](references/example-workflow.md) when calibrating
how independent findings become a recommendation the user can judge. It shows
both a proposed simplification and a decision to retain the current design,
with the intended phrasing and progression rather than a required transcript.

Support that judgment with:

- Current and proposed methods and concepts, what disappears, and why the
  remaining distinctions matter; show both file trees when organization changes.
- Concrete file or caller evidence, the stronger invariant and its owner,
  and behavior that must survive.
- The concrete greenfield alternative, deletion prize, complexity introduced,
  and any user loss or obligation. Explain why the alternative wins or loses.
- Which remaining tasks should change or disappear, if a plan exists.
- Verification that would distinguish improvement from displaced complexity,
  including assumptions that remain unproven.

Report correctness blockers separately so an attractive collapse cannot hide
a regression. Attribute verification failures using the agreed review baseline;
the code inspection skill owns that procedure. Do not call a failure pre-existing
without evidence.

## Adjudicate and continue

The coordinating agent helps the reviewers develop one concrete direction and
returns revisions to the whole group. Verify deciding claims against current
artifacts and record which findings the group accepted, rejected, or deferred,
and why. Agreement does not establish correctness. If no reviewer tested the
specific direction against the guarantee it must preserve, ask the reviewer
best placed to challenge it for a counterexample or the caller evidence that
rules one out. Return that evidence to the group and resolve the resulting
objections before asking every reviewer to confirm support. Keep unproven claims
conditional; the coordinator's own synthesis does not replace group agreement.

Present the strongest opportunity, deletion prize, costs, and judgment
together so the user can assess the bargain. Keep reviewer reports and
deliberation in supporting evidence; the user should not have to reconstruct
the recommendation from separate reports. An unresolved condition belongs beside
the recommendation, without making a promising direction sound settled.
Explain accepted findings before editing.
Implement and verify repairs within existing authorization; bring changes to
the accepted outcome or unresolved product judgment to the user.

After repairs, apply [post-implementation-review](../post-implementation-review/SKILL.md#verify)'s
verification guidance to the repaired files and their callers before closing
the review.

When executing a plan, rewrite remaining work around the resulting design and
delete obsolete tasks. Record consequential findings and decisions in the active
plan or working notes. The assignment sets any intermediate review checkpoints.

Return to the group when repairs materially change reviewed ownership or expose
unresolved risk. Close when every participating reviewer supports the same
concrete next direction, its deciding claims have been checked, and meaningful
objections are resolved. Carry the agreed direction through its authorized
repairs and verification, then resume remaining assigned work.
