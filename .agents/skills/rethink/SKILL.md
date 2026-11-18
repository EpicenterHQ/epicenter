---
name: rethink
description: Reconsider accumulated fixes, exceptions, and decisions in light of the original purpose. Use when the user asks to rethink from first principles, explore greenfield or radical alternatives, redraw the line of best fit, or reconsider the question, assumptions, or boundaries shaping the current approach.
---

# Rethink

When we’ve accumulated fixes, exceptions, or individually reasonable
decisions, zoom out. Bring together what they’ve taught us and imagine the
whole afresh. Given what we’re trying to make possible, what would we make
if we were starting today?

Look for the most tasteful way to recompose the work around that purpose,
with the freedom to change the question we’ve been answering. Judge the
result by what it makes possible and what it asks us to give up.

If the purpose or direction is still unsettled, work it out with the user
through [dialectic](../dialectic/SKILL.md). When the user has settled and
authorized the outcome, use this reasoning to make the choices it leaves
open. Investigate further when uncertainty could change the decision.
A local correction can still be the best result.

## Understand the particulars

Gather what the fixes, exceptions, and decisions have taught us, along
with the corrections and observations that prompted this rethink.
Identify what each one establishes. Some show what people need or value;
others reveal problems the current approach creates. Identify the
assumptions behind those problems. Distinguish observed facts,
preferences, and your explanation of them; a proposed explanation may
itself need revision.

Read the current work and its actual uses. For software, follow the
callers; for a principle, examine the situations it should guide.
Separate what people are trying to do from how the current work lets
them do it. Find out who relies on the current behavior and what would
happen if it changed. A revealing workaround can expose a problem even
before the same problem recurs.

## Imagine the whole afresh

Develop your own conception of what we would make today to serve the
purpose. Zoom out beyond the part we've been trying to fix and consider
how the surrounding system could do the work differently. Imagine it in
use. Use taste to judge how the parts fit together and what someone using
the whole would have to understand or do. Ask what can be reused or
recomposed, and which distinctions still matter. Look for an organizing
principle from which the parts follow.

For example, changing a setting may not require editing a running handle.
Restarting the app or refreshing the page can reuse its startup process
to create the handle with the new setting, removing the need for live
reconfiguration. Weigh the interruption and any lost work against the
complexity of keeping the handle alive while its settings change.

Existing names, rules, boundaries, and guarantees are evidence about earlier
choices; they need not determine the new shape. A rule whose reason has
disappeared may be unnecessary; giving up a guarantee someone still relies
on is a tradeoff to make explicit.

For systems and APIs, set existing applications aside. Ask what primitives
we would choose if we were building from scratch and how they would compose.
When two things overlap, ask whether they can be built from the same pieces.

Use [radical options](references/radical-options.md) when the current framing
makes alternatives hard to see.

Use the [concept inventory](../collapse-pass/references/concept-inventory.md)
when deciding which concepts a workflow or API needs.

Keep what we're trying to accomplish separate from how we propose to do it.
Explicit requirements still apply. If a promising design suggests changing
one, propose that change and explain its consequences. Check limits you're
unsure about. Note what switching designs would cost, and explore the new
design before deciding whether to make that switch.

## Return to the particulars

Take the newly imagined whole back to the cases, corrections, and decisions
that prompted it. Show what it makes possible in those situations and which
old problems no longer arise. Try an awkward or materially different case.
Where the design fails, reconsider the design or the judgment about that
case rather than automatically appending another exception.

Show enough of the proposal to test it: a revised principle applied to
realistic situations, an argument, caller code, an interaction, or a data
flow. For software, follow important information through creation, change,
persistence, failure, and cleanup where those affect the design. An
attractive entrypoint alone may conceal the decisions that matter.

Compare the new whole with the current one. Explain what becomes easier to
understand or do, what work disappears or moves elsewhere, and what
complexity, risk, or loss is introduced. Say who would give up what.
Distinguish a deliberate tradeoff from a problem we haven't solved.
Follow a user's correction through related decisions and test the revised
design again.

A better design may reveal a distinction worth keeping. It may improve the
explanation while leaving the implementation intact. Keep the current
design when it best serves the purpose; fewer rules or less code are useful
consequences when the reasoning supports them.

