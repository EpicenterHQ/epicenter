---
name: dialectic
description: Work out an unsettled idea together through concrete attempts to articulate and express it. Use when the user asks for a dialectic, wants to explore what a skill or workflow should do, is finding a direction for writing, wants to judge a proposed change, wants to think through an uncertain model or decision, or needs help articulating a thought they cannot quite express. Do not use for routine execution of a settled request, a standalone explanation of settled material, or a code review.
---

# Dialectic

Give the thought a useful shape so we can think with it together.

Articulate what we mean and show what it could become. Bring prose, code,
diagrams, and examples together where they make the idea easier to grasp and
its consequences easier to judge. A code block can make a handoff inspectable;
a diagram can reveal ownership; a passage can let someone experience the
proposed voice.

Give each part useful work. Preserve the structure that makes the thought
approachable, while cutting repetition and premature elaboration. Let the
question determine the form, sequence, and depth. Show alternatives when their
differences help resolve something still open.

Use the person’s reaction to develop both the idea and its expression. Carry
forward what they recognize, reconsider what their correction reveals, and
make the next coherent attempt.

Use this method within the ongoing task; its purpose, artifacts, and
authorization remain in place as our understanding develops. Standalone
exploration needs no destination artifact.

## Make the model and its consequences judgeable

Offer your best current understanding and a useful attempt without requiring
the user to diagnose everything first. They may arrive with an idea, an
existing expression, or a result that raises a new question. The idea and its
expression can share a paragraph, code example, or sketch. Explain separately
what the expression leaves unclear. A settled edit needs no new explanation.

Before/after prose or code can make a revision visible; a table can compare
approaches on the tradeoffs the reader needs to weigh. Choose representations
for what they help the person see, and let them work together.

Check facts you can establish yourself and distinguish evidence from proposals.
Before showing an exact proposed diff, read the current code and affected
callers. Identify the file and scope, and include enough context to judge the
behavior that changes. Label hypothetical code as a sketch.
Ask when missing information would make the attempt misleading or unhelpful.
Recommend a direction when you have grounds for one, explaining consequential
choices. A hypothetical conversation or caller sketch proposes a result; it
does not establish that an implementation produces it.

Present the concrete expression as close as practical to its intended final
form. For a blog, render the proposed writing in the actual site and show
screenshots; for an API, show realistic caller code; for a skill, show the
conversation it could produce. Use a simpler representation when it is
sufficient for the question being judged. Prepare previews within the task's
authorization; showing a proposed result does not require publishing it.

Follow the concrete example far enough to show the consequence being judged.
If resource lifetimes matter, show sharing and cleanup. If a skill's response
to uncertainty matters, show that later turn. If a passage's movement or ending
matters, let the user read it. Complete enough means enough for the live
question, not an entire application or a rewrite of settled work. Economical
commentary does not require a short expression.

A correction may clarify what to avoid while leaving meaningful directions
open. Preserve what the user has recognized and make those remaining
differences concrete. Explain each direction enough to judge it on its own,
using headings when they help the comparison. Recommend a direction when you
have grounds, and leave room to combine, reject, or redirect the possibilities.
A settled selection or a straightforward correction needs no new comparison.

When comparing revisions, show the relevant original and alternatives together
so the user need not reconstruct earlier versions from memory. Keep unrelated
conditions comparable while allowing each change to show its consequences.

## Learn from the response

Treat the user's response as evidence about what you understood and what the
attempt reveals. They may recognize the model but dislike a choice in its
expression, or the expression may expose something the model missed. Locate
that difference through the conversation rather than asking the user to
classify their reaction. Revise at the scope it illuminates; a reaction to one
passage does not establish a universal preference.

Carry what you learn into the next coherent attempt. If the user recognizes
parts of different versions, do the synthesis rather than making them assemble
fragments. If their response changes the premise, reconsider the relevant
whole as if that understanding had been known from the beginning. Discovery
may produce an idea neither participant had fully formed beforehand.

Leave the user's reaction open, including rejection of your framing. Judge
against their intent, evidence, constraints, and consequences; stay willing
to disagree and explain why. Ask a focused question when it helps resolve
something, not to solicit approval after every attempt. In a sample exchange,
label invented replies as samples; in the live conversation, leave the user's
next reply to them.

“That’s right” names recognition of the model and its concrete expression,
not a required phrase. Let recognition settle the question it addresses and
continue authorized work from there. A later discovery may reopen that
question. Recognition alone supplies no authorization for side effects.

## References

Read [the example conversations](references/conversations.md) when developing
writing, an API, a skill, or a website, or calibrating how to show an attempt.
They demonstrate the relationship between articulation and concrete expression
without prescribing a format, number of versions, or sequence.

For substantial prose work, use [writing-voice](../writing-voice/SKILL.md) for
language, rhythm, and fidelity to the author's words and particulars. Trying
new wording can help the author discover what they mean; it does not permit
inventing personal events, motives, or beliefs. Page and journal workflows
retain their authorship and artifact requirements.
