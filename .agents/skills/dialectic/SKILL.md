---
name: dialectic
description: Work out an unsettled idea together through concrete attempts to articulate and express it. Use when the user asks for a dialectic, wants to explore what a skill or workflow should do, is finding a direction for writing, wants to think through an uncertain model or decision, or needs help articulating a thought they cannot quite express. Do not use for routine execution of a settled request, a standalone explanation of settled material, or a code review.
---

# Dialectic

Develop a shared model through articulation and concrete expression. Use this
method within the ongoing task; its purpose, artifacts, and authorization
remain in place as our understanding develops. Standalone exploration needs
no destination artifact.

**Articulation of the model** states our current understanding of the idea,
intent, or arrangement: what we mean, how its parts relate, and what we want
it to make possible.

**Concrete expression** shows what that model could produce: caller code using
an API, a conversation following a skill, or the actual prose of a piece of
writing.

Make the thought clear enough to think alongside. Keep its useful shape; cut
repetition and premature elaboration. Bring articulation and expression together
where they help the user grasp the proposal and judge its consequences. Use
reactions to either to revise our understanding and the next attempt, working
toward “that’s right” to both.

## Make the model and its consequences judgeable

Offer a coherent thought with enough reasoning and concrete expression for the
user to engage with it. Let the live uncertainty determine how much to develop:
a broad design question may need a substantial comparison, while a correction
may need only the revised idea and its consequence. Carry settled context
forward without presenting it again. Avoid making the user pull an explanation
out of a sequence of small replies or leading questions.

Make the current thought visible in a form the user can point to and change.
A small map can expose connections and omissions; a list, passage, or caller
example can expose other choices. When a response changes the model, revise
the same expression where it still fits so the user can see what changed.
After showing it, say what you think and why. Recommend a direction when you
can. If the choice is still open, show the example or fact that would help
decide it. Do not simply restate the expression. Judge by how readily the user
can understand and correct the thought, not by reply length or a required
format.

Check facts you can establish yourself and distinguish evidence from proposals.
Ask when missing information would make the attempt misleading or unhelpful.
A hypothetical conversation or caller sketch proposes a result; it does not
establish that an implementation produces it.

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

Show distinct alternatives when comparing them would help settle the live
question. A correction may clarify what to avoid while leaving meaningful
directions open; preserve what the user has recognized and make those remaining
differences concrete. Explain each direction enough to judge it on its own,
using headings when they help the comparison. Recommend a direction when you
have grounds, and leave room to combine, reject, or redirect the possibilities.
A settled selection or a straightforward correction needs no new comparison.

When comparing revisions, show the relevant original and alternatives together
so the user need not reconstruct earlier versions from memory. Keep unrelated
conditions comparable while allowing each change to show its consequences.

A correction often narrows the possibilities without settling the next
expression. When useful, compare a gradation of editorial distance, from
repairing the current expression to reconsidering its approach. Carry forward
what the user has recognized so exploration accumulates rather than repeatedly
starting over. Page-writing owns the writing-specific default of a close repair,
an intermediate reworking, and a more adventurous attempt.

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

Let that response guide further development. Work through the consequences of
a challenged assumption before building more design on it. Introduce names,
schemas, workflows, or further examples when they help the current judgment;
premature detail makes the user untangle decisions they have not made yet.

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

For prose drafting and revisions, use [writing-voice](../writing-voice/SKILL.md)
for language, rhythm, fidelity to the author's words and particulars, and
contextual revision comparisons, including short passages. Trying new wording
can help the author discover what they mean; it does not permit
inventing personal events, motives, or beliefs. Page and journal workflows
retain their authorship and artifact requirements.
