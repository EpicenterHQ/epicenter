# Coordinator protocol

Read this before staffing or coordinating an adversarial review. The
[skill](../SKILL.md) owns the review's reasoning and standards for support.

## Staff the review

Normally launch two fresh Codex subagents with `fork_turns: "none"` and
`reasoning_effort: "high"`, explicitly selecting the latest Codex model
exposed by the host. At this update, that is GPT-6.1 Terra
(`gpt-6.1-terra`), verified against the host's model catalog and
[OpenAI's release notes](https://help.openai.com/en/articles/9624314-model-release-notes).
Check current host availability when launching; do not inherit an older parent
model or substitute a generic GPT-6 family label.

The third seat is a fresh, read-only Claude Fable reviewer through
[consult-claude](../../consult-claude/SKILL.md), at high effort. The current
model is [Claude Fable 5.2](https://www.anthropic.com/claude/fable),
`claude-fable-5-2`. Pass `--model claude-fable-5-2 --effort high` explicitly
on its initial launch and every resume; the consultation launcher's general
Opus default does not select this review seat. Preserve the session ID,
verified account, source checkout, and selected model for follow-ups as
consult-claude requires. Check the returned model and permission denials before
attributing a review. Report unavailability or substitution explicitly.

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
