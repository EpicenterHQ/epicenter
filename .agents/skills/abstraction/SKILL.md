---
name: abstraction
description: Shape a complex idea, workflow, or design into the smallest complete surface a person needs for the next judgment.
---

# Abstraction

Show the person the part of a model they need now. Keep the model true, but do
not make them carry its history, machinery, or every possible consequence.

Use this after thinking, research, or design when the answer risks becoming
larger than the judgment it is meant to support. It pairs with `dialectic`:
dialectic helps work through the unsettled idea; abstraction helps present
what the person needs to understand or judge.

## The test

> Given this conversation, what does the person need to see to understand and
> judge the thing itself? Make that presentation as simple as possible while
> preserving the evidence their judgment depends on.

When discussing a concrete change, show the relevant change alongside the
explanation. Brevity should remove incidental details, not the material the
person is trying to inspect. A summary, file link, or description of an effect
may help orient them; include the actual code, wording, or visible result when
that is what they are judging. Let the scope of their judgment determine how
much to show, including the complete change when requested.

## Keep the load-bearing parts

Preserve:

- who is involved;
- what each person or system decides;
- the handoff or sequence between them;
- the relationship that gives the model its shape;
- the consequence the person needs to judge.

When viewpoints differ, show them separately. A compact `reader / author`,
`user / system`, or `caller / owner` view is often clearer than an object graph.

## Reveal progressively

Lead with the governing relationship. Then add only the context, example, or
qualification needed to make it recognizable. Defer background and machinery
that do not affect the current judgment. Include the requested material in the
current response, with enough context to understand it.

If an omission could make something look absent, automatic, or settled, name
that boundary briefly. Do not hide uncertainty just to make the surface clean.

## A short pass

1. Find the next judgment the person needs to make.
2. Keep the actors, decisions, handoff, and consequence required for that
   judgment.
3. Choose the clearest surface: a short sequence, small diagram, example, or
   paired viewpoint.
4. Check that separate owners have not been collapsed and deferred decisions
   have not been presented as settled.
5. Remove incidental detail while preserving the requested material and the
   evidence needed to learn, recognize, correct, express, or act.

## With dialectic

Dialectic asks:

```txt
What thought, explanation, or question would help us work through this idea?
```

Abstraction asks:

```txt
What does this person need to see in order to react to that model now?
```

Let dialectic guide the conversation. Use abstraction to make the current
thought easier to judge, keeping uncertainty visible where it matters.
Do not impose a separate response format.

Understanding the model is not approval for an implementation, deletion, merge,
or other side effect.

## Watch for

- **Inventory:** nouns without the relationship between them.
- **Shortening:** fewer words but the same conceptual burden.
- **Premature simplicity:** a distinction that mattered to the decision has
  disappeared.
- **Implementation leakage:** storage, helpers, and compatibility history before
  they matter.
- **Completeness pressure:** every consequence shown at once.
- **False closure:** uncertainty hidden to make the answer feel finished.

## Stop

Stop when the person can say what the model is for, what they experience, what
they decide, and what remains separate—and can make the next correction without
having to ask for the material needed to judge it.
