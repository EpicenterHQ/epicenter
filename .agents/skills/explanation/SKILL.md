---
name: explanation
description: Explain technical ideas and work so a person can find the point and understand the relationships. Use when the user asks in chat how or why something works, what changed, or why a design is shaped the way it is, or when an explanation is dense or hard to follow. For authored prose or documentation, use its destination skill.
---

# Explanation

Help the person understand the thing they asked about and see enough of it to
correct your account. An accurate inventory of parts can still fail if the
reader must discover the relationship among them or work out why they matter.

## Meet the question they brought

Identify what the person is trying to understand: a purpose, mechanism, choice,
change, or check of their own mental model. Start with the answer to that
question in their terms. If they offer a baseline, such as how they think the
API works or what the browser already does, explain what changes relative to
it before introducing the system's internal names.
Introduce an internal name only after the thing it names is clear, and only
when the person will need that name again.

Choose the governing relationship before the details. For a complex model,
preserve the actors, ownership, sequence, and consequences that affect the
person's understanding or decision. Leave incidental implementation history
for later. Do not simplify by hiding uncertainty, making proposed behavior
sound implemented, or collapsing distinct owners.

When someone asks why a part exists, show what it adds or protects in the
workflow they care about. When they ask how it works, follow the relevant
action or value far enough to show its consequence. When they ask whether
their understanding is right, confirm and correct its parts before deriving
another model.

## Make the answer readable in chat

Design the first screen for a skim. Put the answer or key relationship near
the top. Give distinct ideas separate short paragraphs; most paragraphs
should carry one idea in one to three sentences. For a longer answer, use
descriptive headings that state the point of each section. A short answer
may need no heading.

Use whitespace and a little emphasis to direct attention. Bold the crucial
distinction or conclusion, not every sentence or list label. If someone reads
only the opening, headings, and emphasized text, they should still recognize
the answer. Do not turn every response into the same template.

Choose a form for the relationship it makes easier to see:

- **Code** shows behavior or a caller's choice. Use a small relevant example,
  say what its non-obvious lines do, and show the expected result. Mark
  hypothetical APIs as proposals.
- **A diagram** shows flow, ownership, or timing that prose or code makes hard
  to track. Combine it with code when both the caller and the sequence matter.
- **A list** separates parallel points; numbers mean order. Keep each item
  focused and parallel.
- **A table** supports a genuine comparison across the same dimensions.
  Keep cells brief; a dense table is another wall of text, especially on a
  narrow screen.
- **A rendered or interactive view** helps when appearance or changing state
  is itself the question. A static technical answer usually belongs in chat.

Introduce each visual with the question it answers. After it, explain only
the consequence the reader cannot easily see for themselves. More formatting
does not rescue an answer organized around the wrong question.

## Show enough to judge

For a concrete change, show the relevant code, wording, or visible result
alongside the explanation. A file link or summary can orient the person, but
does not replace the material they asked to inspect. For a report, draw the
account from the diff, tests, and actual behavior; describe what changed in
ordinary terms rather than the work's internal vocabulary.

When a decision is needed, explain the options that matter, their costs, and
your recommendation. Put the decision after the evidence it depends on, where
the person can reply to it. When the model is unsettled, use
[dialectic](../dialectic/SKILL.md) to make a proposed account or example
judgeable and revise it from the person's response.

Stop when the person can understand, challenge, or act on the point without
reconstructing the machinery behind it. Depth may be necessary; density is
not.

## Boundaries

These presentation choices govern live explanations and reports. An authored
piece has its own reader and movement. Use [writing-voice](../writing-voice/SKILL.md)
for Braden's prose, [technical-articles](../technical-articles/SKILL.md) for
articles, and [teaching-page](../teaching-page/SKILL.md) for a standalone
HTML lesson. Carry over the care for the reader's attention, not chat's
headings, bolding, or code rhythm as a universal style.
Use [documentation](../documentation/SKILL.md) for README and JSDoc writing.
