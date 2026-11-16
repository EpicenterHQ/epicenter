# Coordinator protocol

Read this before staffing or coordinating an adversarial review. The
[skill](../SKILL.md) owns the review's reasoning and standards for support.

## Staff the review

Normally staff three fresh, read-only seats at high reasoning effort:

| Seats | Model and launch settings |
|---|---|
| Two Codex subagents | `gpt-6.1-sol`; `fork_turns: "none"`, `reasoning_effort: "high"` |
| One Claude Opus reviewer | Fresh [consult-claude](../../consult-claude/SKILL.md) session with `--model claude-opus-5-5 --effort high` on launch and every resume |

Check current host availability and select these models explicitly on launch
and follow-ups. Verify the model that actually ran from execution metadata;
a reviewer's self-identification is insufficient. Use consult-claude's account,
session, and returned-model/permission checks. Report unavailability or
substitution.

Explicit user choices override these defaults. Run the seats in parallel when
possible. Keep initial conclusions private until all initial accounts arrive.

## Supply the evidence and starting questions

Give every seat the desired outcome, explicit requirements, actual or intended
callers, relevant entrypoints, and existing system. Include the task-start
baseline and cumulative diff for implementation reviews, distinguishing
task-owned uncommitted and untracked files from unrelated work. Supply
verification results, remaining plans, and open questions. A summary alone
is insufficient evidence. Include essential reviewer guidance in each brief;
provide linked reasoning when the assignment calls for it.

When anchoring is a consequential risk, supply outcome, requirements, callers,
and existing system before the proposed API or rationale. Preserve the initial
accounts, then supply the proposal. Describe limits from an already visible
implementation honestly.

Assign one of the following starting perspectives to each reviewer independently
of model choice. No perspective belongs to a particular model. Each reviewer
develops a complete recommendation and tests alternatives; the perspective
determines where the investigation starts, not what it may examine.

Greenfield design:

> From the desired experience and actual use, what should this system be? Develop
> your own account of its natural operations and responsibilities, then compare
> it with the design under review. Which problems disappear under that account,
> and what work, guarantees, or costs remain?

Use and consequences:

> Follow actual or intended users through the work this system must support.
> Read existing callers as evidence of need rather than of the right operations.
> Develop your own account of what belongs together and what its operations
> mean. Test that account and the design under review against consequential
> sequences. Which requirements reflect necessary outcomes, and which reflect
> an assumed solution? Show the bargain behind your recommendation.

Shared premises:

> Find the premises the design under review shares with its obvious
> alternatives: about ownership, lifetime, representation, or what is promised
> to people. Which premise accounts for the most machinery, and what would you
> build if it were false? Develop your own account and test it against the
> strongest case for the current design. If the evidence points to a better
> question, pursue that instead.

These are starting questions, not assigned conclusions. Any reviewer can
challenge its framing or establish that the current design is strongest.

## Carry the exchange

Reviewers may communicate directly where tooling supports it. Otherwise relay
their substantive findings, questions, evidence, objections, and replies,
attributed to their author and without summarizing away the reasoning. Claude
receives these at completed-turn boundaries through its resumed session;
there is no mid-turn channel. Return deciding traces and experiment results
to every reviewer. Exchanges should test claims rather than repeat broad
reviews.

Claude may use host-provided read-only Codex evidence assistance while retaining
the judgment and checking deciding sources. This helper gathers evidence; it
is not another independent reviewer. Codex owns requested experiments.

Three seats is a starting point, not a cap. Add a reviewer when an unresolved
question, competing model, or missing expertise needs one. Give it the shared
evidence and the question it joins to answer. Where anchoring matters, let it
form its account before reading the group's current direction and objections.
Never add a seat to outnumber an objection or obtain endorsement.

Hold the reviewed surface stable until the review ends, whether or not it
converges. Use that interval for verification preparation or independent work
whose shape does not depend on the verdict. Reviewers remain read-only.

## Continue after review

Explain accepted findings before editing. An implementation task already
authorizes repairs within its accepted outcome; a review-only task does not
authorize implementation. Bring changes to the accepted outcome or unresolved
product choices to the user.

After authorized repairs, use
[post-implementation-review](../../post-implementation-review/SKILL.md#output-shape)'s
local post-edit checks on every repaired file. Rewrite remaining work around
the resulting design and delete obsolete tasks. Return to the group when
repairs materially change reviewed ownership or expose unresolved risk. Once
the agreed direction is carried through and its consequential findings are
resolved, resume remaining assigned work.
