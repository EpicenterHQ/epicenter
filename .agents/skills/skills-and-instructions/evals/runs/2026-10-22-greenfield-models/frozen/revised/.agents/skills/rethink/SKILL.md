---
name: rethink
description: Develop the strongest grounded vision of a system, API, or abstraction through dialectic, then work backward to make it real. Use when the user asks for greenfield thinking, radical options, a clean break, first-principles design, or questions the current organizing idea or boundaries.
---

# Rethink

Develop your own account of what the system should do from the desired
experience and actual use. Treat the current design as one explanation of the
problem. Discover the organizing idea that gives the whole its strongest shape,
then derive its concepts, operations, responsibilities, and guarantees.

Use [dialectic](../dialectic/SKILL.md) to develop that vision together through
concrete expression. Contribute a considered model the user can recognize,
challenge, and improve. Take responsibility for pursuing the idea beyond what
they have already articulated.

## Form an account of the whole

Start with what someone wants to make possible and how they would naturally
use it. Articulate what the system does, what its operations mean, and which
information and responsibilities belong together. Follow that account far
enough to reveal a coherent design. Let the surrounding system come into
question when its shape limits the outcome.

Read the current implementation and actual callers to understand the work,
needs, and consequences. Distinguish necessary work from problems created by
the current arrangement. Existing names, APIs, ownership boundaries, lifetimes,
and guarantees are evidence about earlier choices. They need not supply the
vocabulary or boundaries of the destination.

Use [greenfield thinking](references/greenfield.md) to develop natural use and
derive ownership. Use [radical options](references/radical-options.md) when the
apparent choices share an assumption worth reconsidering. Let the live question
determine the exploration; a fixed number of alternatives or a mandatory
guarantee-removal exercise would prejudge what a better design looks like.

Keep the desired outcome distinct from a proposed way to achieve it. Explicit
requirements govern implementation; a promising vision may reveal a requirement
worth changing. Show that conflict and its consequences as a proposal. Investigate
uncertain limits, and separate demonstrated constraints from inherited assumptions.
Keep transition costs visible without letting them define the destination
before it has been developed.

## Give the vision concrete expression

Show how someone would use the proposed system: realistic caller code, an
interaction, or a data flow. Derive the public surface and internal boundaries
from that use. Follow important information through creation, change,
persistence, failure, and cleanup where those affect the design. An attractive
entrypoint alone may conceal the decisions that matter.

Use what the expression reveals to revise the model. Explain what the person
must understand and do, which distinctions carry independent information, and
which coordination problems disappear or move elsewhere. A new abstraction may
earn its place by making the whole easier to understand and own. Fewer concepts
and less code are valuable consequences when supported by the design.

When the user senses unnecessary machinery, investigate the account that makes
it seem necessary. Reconsider the relevant whole and bring forward a developed
alternative; the user should not have to challenge each remaining member of an
API to reach it. A rename or local repair remains appropriate when that is what
the evidence supports.

Compare the promising vision with the existing approach through concrete use
and consequential failures. Show what improves, what machinery or obligations
disappears, and what complexity or loss is introduced. A counterexample reveals
a cost to judge against the intended experience. Develop the strongest supported
destination, whether it retains the current model or changes it substantially.

## Work backward from the destination

As the direction settles, state the observable behavior that would make it real.
Derive what must be created, moved, replaced, or removed, in dependency order,
and what evidence will establish that it works. Use
[clean breaks](references/clean-breaks.md) to carry an authorized replacement
through consumers and retire the superseded shapes.

Keep the reasons the vision is worth pursuing present through implementation.
A convenient intermediate shape must not quietly become the endpoint.
Distinguish a difficult step from a discovery that changes the destination.
Continue solving the former; bring the latter back into dialectic with its
consequences visible, then work backward from the revised understanding.

An already settled direction needs no repeated discovery exercise. Carry out
the work within the user's authorization: exploration remains exploration, and
an authorized replacement proceeds without an added confirmation ritual.

## Close against the vision

Exercise the concrete use and verify changed contracts. Judge the result against
the destination and the qualities that made it worth pursuing. Explain what now
realizes the vision and resolve consequential drift. Passing tests alone does
not establish that the intended system has been built.
