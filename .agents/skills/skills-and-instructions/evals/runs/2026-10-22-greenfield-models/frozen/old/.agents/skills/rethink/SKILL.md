---
name: rethink
description: Pursue the best possible version of a system, API, or abstraction, develop the vision through dialectic, and work backward to make it real. Use when the user asks for greenfield thinking, radical options, a clean break, first-principles design, or says the current abstraction feels wrong.
---

# Rethink

Pursue the best possible version of what this could be. Suspend inherited
constraints long enough to discover the strongest shape: question the
boundaries, assumptions, and promises that make the current system feel
inevitable.

Use [dialectic](../../skills/dialectic/SKILL.md) to articulate that vision
together and give it concrete expression. Push it far enough that we can
recognize what makes it worth pursuing. Then work backward from that destination,
distinguishing constraints we must solve from assumptions we can discard.

## Pursue the vision

Start with what the user wants to make possible and follow the idea all the way.
Let the surrounding system come into question when its shape limits the outcome.
Existing APIs, ownership boundaries, package layouts, and prior decisions can all
be reconsidered. The cost of changing them belongs in the path to the destination;
it need not define the destination before we have seen it.

[Greenfield thinking](references/greenfield.md) develops the desired whole.
[Radical options](references/radical-options.md) challenges assumptions that keep
that whole out of reach. Use these references as the question calls for them.
Neither is a requirement to produce a fixed number of alternatives.

Develop the vision through dialectic: articulate what the system could become,
show how someone would use it, and let reactions to both deepen or revise the
proposal. Concrete expression makes ambition inspectable. Follow a caller,
interaction, or data flow far enough to expose the decisions the model makes
about ownership, state, policy, and lifetime.

Read the current system to learn what it reveals about the problem. Separate
inherited choices from demonstrated constraints. Investigate uncertain limits;
do not silently turn them into reasons to lower the ambition. Respect the user’s
explicit requirements, and surface a conflict when pursuing the vision would
require changing one.

## Work backward from the destination

As the direction settles, describe the observable behavior that would make it
real. Derive the implementation from that target: what must be created, moved,
replaced, or removed, in what dependency order, and what evidence will establish
that it works? Let the destination determine the work.

Keep the reasons the vision is worth pursuing present through implementation.
A convenient intermediate shape must not quietly become the endpoint. Use
[clean breaks](references/clean-breaks.md) to carry the chosen direction through
consumers and retire the superseded shapes.

Distinguish a difficult step from a discovery that changes the destination.
Continue solving the former. Bring the latter back into dialectic with the
concrete consequence visible, then work backward from the revised understanding.
An already settled direction needs no repeated discovery exercise.

Carry out the work within the user’s authorization. A request to explore a
vision remains exploration; an authorized replacement should proceed without
an added confirmation ritual.

## Close against the vision

Judge the result against the destination and the qualities that made it worth
pursuing. Exercise its concrete use and verify the changed contracts. Explain
what now realizes the vision and identify consequential drift. Passing tests
alone does not establish that the intended system has been built.
