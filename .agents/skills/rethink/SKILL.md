---
name: rethink
description: Reconsider the model behind fixes, exceptions, or decisions, find a better organizing principle, and test it against the particulars. Use when the user asks to zoom out, redraw the line of best fit, pursue greenfield thinking, radical options, a clean break, or first-principles design, or questions the current organizing idea or boundaries.
---

# Rethink

When we’ve accumulated fixes, exceptions, or individually reasonable decisions,
reconsider the model that holds them together. Find a better organizing
principle, then return to the particulars and see whether it actually explains
them.

The model may be a software design, a skill's principle, an argument, or an
interpretation. Zooming out can mean finding a better distinction among the
cases or reconsidering the surrounding system and its boundaries. For new
work, begin with the intended uses and requirements the model must explain.

When the direction or purpose still needs development with the user, use
[dialectic](../dialectic/SKILL.md) to develop it together. When the user has
already settled and authorized the outcome, carry that intent forward and use
this reasoning to resolve choices directly. Scale investigation to the
uncertainty; a local correction can still be the best result.

## Understand the particulars

Start with what someone wants to make possible and the cases, corrections, or
observations that brought the model into question. Identify what each one
establishes. Distinguish observed facts, preferences, and your explanation of
them; a proposed explanation may itself need revision.

Read the current work and its actual uses. For software, follow the callers;
for a principle, examine the situations it should guide. Include fixes and
decisions already made. A revealing workaround can expose a problem in the
model even before the same problem recurs.

## Reconsider the model

Develop your own account of what would explain the particulars and fulfill
the intent. Ask which distinctions matter, what belongs together, and which
problems the current arrangement creates. Existing names, rules, boundaries,
and guarantees are evidence about earlier choices. They need not determine the
form of the better account. Follow the surrounding system when its shape
limits the outcome.

Identify assumptions carried forward from earlier versions of the idea.
Establish what still depends on them. A rule whose reason has disappeared may
be unnecessary; giving up a guarantee someone still relies on is a tradeoff
to make explicit.

For system or API design, use [greenfield thinking](references/greenfield.md)
to develop natural use and derive ownership. Use
[radical options](references/radical-options.md) when the
apparent choices share an assumption worth reconsidering. Let the live question
determine the exploration; a fixed number of alternatives or a mandatory
guarantee-removal exercise would prejudge what a better design looks like.
When questioning which concepts a workflow or API needs, use the
[concept inventory](../collapse-pass/references/concept-inventory.md) to make
the current and alternative nouns and their distinctions visible.

Keep the desired outcome distinct from a proposed way to achieve it. Explicit
requirements govern implementation; a promising model may reveal a requirement
worth changing. Show that conflict and its consequences as a proposal.
Investigate uncertain limits. Keep transition costs visible without letting
them define the destination before it has been developed.

## Return to the particulars

Take the proposed model back to the cases, corrections, and decisions that
prompted it. Show why each one follows, which exceptions become unnecessary,
and which differences remain meaningful. Try an awkward or materially
different case. Where the model fails, reconsider the model or the judgment
about that case rather than automatically appending another exception.

Give the model concrete expression: a revised principle applied to realistic
situations, an argument, caller code, an interaction, or a data flow. For
software, follow important information through creation, change, persistence,
failure, and cleanup where those affect the design. An attractive entrypoint
alone may conceal the decisions that matter.

Compare the new account with the current one. Explain what becomes easier to
understand or do, what work disappears or moves elsewhere, and what complexity
or loss is introduced. Follow a user's correction through related decisions
and test the revised account again.

A better model may reveal a distinction worth keeping. It may improve the
explanation while leaving the implementation intact. Keep the current model
when it best accounts for the evidence and intent; fewer rules or less code
are useful consequences when the reasoning supports them.

## Work backward from the destination

As the direction settles, state what must change in the work: its wording,
structure, behavior, or implementation. Derive the changes in dependency order
and what evidence will establish that they work. For software replacements,
use [clean breaks](references/clean-breaks.md) to carry the authorized change
through consumers and retire the superseded shapes.

Keep the reasons the vision is worth pursuing present through implementation.
A convenient intermediate shape must not quietly become the endpoint.
Distinguish a difficult step from a discovery that changes the destination.
Continue solving the former; bring the latter back into dialectic with its
consequences visible, then work backward from the revised understanding.

## Close against the vision

Examine the revised work against the destination and the qualities that made it
worth pursuing. Check that it still explains the particulars that prompted it.
For implementation changes, exercise the concrete use and verify changed
contracts. Resolve consequential drift; passing tests alone does not establish
that the intended system has been built.
