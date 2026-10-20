---
name: abstraction
description: Shape a complex idea, workflow, design, or report on work around the judgment a person needs to make. Use when summarizing, reporting on, or explaining complex work to someone who must judge or act on it, or when an explanation obscures its point or makes the user carry unnecessary complexity. Do not use for routine execution of a clear request.
---

# Abstraction

Make the model easy to recognize and judge without making it less true. The
right amount of detail is what this person needs to understand, correct, or
act on it; brevity alone does not reduce their work.

Start from what the person is trying to accomplish and the judgment in front
of them. Show the governing relationship before its machinery. Preserve the
actors, ownership, sequence, and consequences that change that judgment;
leave history and incidental implementation detail available for later.

Choose the form from what needs to be understood. Prose can carry a claim,
a comparison can expose a trade-off, and code or a diagram can make a
relationship concrete. Use visual hierarchy so the point requiring attention
is easy to find. A successful layout in one conversation is not a required
format for the next.

When reporting on work, show what changed in a form the person can scan:
code, a before and after, or a small diagram, instead of naming the change in
the work's internal vocabulary. Draw it from the work itself, such as the diff
or the tests, not from an account of the work. When the person has a decision
to make, end with it, after the evidence it depends on, because the end is
where they read and reply. For each decision, give the options that matter,
what each costs, and which you recommend, so they can answer in a word. A
report that only restates what was done leaves the person to reconstruct what
it means.
When the person is judging a concrete change, include the actual code, wording,
or visible result with enough context to inspect it. Show the complete change
when they ask for it.

Simplification fails when it hides uncertainty, makes deferred behavior look
implemented, or collapses distinct owners. Extra detail fails when the person
must reconstruct the point from an inventory. Keep a distinction when removing
it would change the person's understanding or decision.

[dialectic](../dialectic/SKILL.md) develops an unsettled model through reactions;
abstraction chooses how that model meets the person. Show alternatives when
comparing them helps resolve the uncertainty. Otherwise present the strongest
current account and what remains unresolved.

Stop when the person can make the next judgment without reconstructing the
machinery behind it or asking for the material needed to judge it.
