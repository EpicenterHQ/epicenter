---
name: abstraction
description: Shape a complex idea, workflow, design, or report on work into the smallest complete surface a person needs for the next judgment. Use when summarizing, reporting on, or explaining complex work to someone who must judge or act on it, when proposing a change that is easier to judge shown than described, or when an explanation obscures its point or makes the user carry unnecessary complexity.
---

# Abstraction

Show the person the part of a model they need now. Keep the model true, but do
not make them carry its history, machinery, or every possible consequence.

Use this after thinking, research, or design when the answer risks becoming
larger than the judgment it is meant to support. It pairs with `dialectic`:
dialectic helps work through the unsettled idea; abstraction helps present
what the person needs to understand or judge.

## Start with the conversation

Treat the actual chat—not just the topic—as the material to abstract. Read for
what the person is trying to do in this moment: understand something, choose
between live possibilities, correct a model, communicate an idea, or take the
next action. Notice what they already understand, what they are reaching for,
and where their wording signals uncertainty or a useful distinction.

Then choose the articulation that gives them the most leverage at that moment.
The goal is not merely to hide complexity. It is to hide the right complexity
while exposing the relationship, example, or contrast that lets them learn,
recognize the model, or move the conversation forward. An answer may therefore
be a compact explanation, a sharper restatement of their idea, a decision
frame, a concrete example, or a question that makes the missing judgment
visible.

Do not abstract away the user's actual intent in favor of a cleaner generic
answer. Preserve their important words and distinctions when those are part of
what they are trying to discover. If the conversation is still searching for
the model, offer the strongest useful articulation as provisional rather than
pretending the model has already settled.

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

When reporting on work, show what changed in a form the person can scan: code,
a before and after, or a small diagram, rather than naming the change in the
work's internal vocabulary. Draw it from the work itself, such as the diff or
the tests, not from an account of the work. Lead with the outcome; when the
person has a decision to make, put it after the evidence it depends on, at the
end where they read and reply. For each decision, give the options that
matter, what each costs, and which you recommend, so they can answer in a word.
When approaches compete, a comparison table with the dimensions they care about
as rows exposes the trade-off; state the recommendation after it. A report that
only restates what was done leaves the person to reconstruct what it means.

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

1. Read the conversation for the person's immediate aim, current model, and
   point of uncertainty or leverage.
2. Find the next judgment, insight, expression, or action the person needs.
3. Keep the actors, decisions, handoff, and consequence required for that
   moment.
4. Choose the clearest surface: a short sequence, small diagram, example,
   restatement, contrast, or paired viewpoint.
5. Check that separate owners have not been collapsed and deferred decisions
   have not been presented as settled.
6. Remove incidental detail while preserving the requested material and the
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

When the user is developing an idea in the chat, prefer an articulation that
advances their thinking over an abstract summary of the subject. Name the
useful shape you see, show the one distinction that makes it work, and leave
the next correction easy for them to make.

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
