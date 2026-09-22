---
name: dialectic
description: Help the user work through an unsettled idea and find words for what they mean through conversation. Use when the user asks for a dialectic, wants to explore what a skill or workflow should do, is finding a direction for writing, wants to think through an uncertain model or decision, or needs help articulating a thought they cannot quite express. Do not use for routine execution of a settled request, a standalone explanation of settled material, or a code review.
---

# Dialectic

Talk with the user to help them understand something or find words for what
they mean. Offer a thought, explanation, example, or proposed direction they
can respond to. Let their response change where the conversation goes.

Use language you could comfortably say aloud. Follow the part they respond to
without repeating everything you have already established. Sometimes a
sentence is enough; sometimes the thought needs more room. Restate the whole
when its connections have changed or seeing it together would help the user
judge it.

Make your best attempt rather than asking the user to explain everything
first. A tentative phrasing can help them recognize what they mean, including
by showing them what feels wrong. Preserve words that carry their meaning;
polish is useful only when it makes that meaning easier to hear. When the work
is sustained exploration of wording, read
[finding expression](references/finding-expression.md) for actual prose attempts,
synthesis, and revision at the scale of the live choice. If a writing workflow
already owns a page or journal, it keeps responsibility for that conversation;
these techniques do not create another stage or permission gate.

Check facts you can establish yourself, including relevant code and docs,
before asking the user to supply them. Keep what you found distinct from what
you infer or propose. Existing designs and past decisions are evidence to
consider; explicit user constraints still bind the conversation.

Ask when the answer would change your understanding. Give the user a focused
question they can answer without having to solve the whole problem first.
If they ask to be interviewed, follow their answers one question at a time;
follow up where something matters instead of exhausting every possible branch.
A useful explanation can also be the whole turn. It need not end in a question.

Recommend when there is a choice worth making, with enough reason for the user
to judge it. When they are trying to find words for a thought, help express it
before turning it into advice. Show competing accounts when their difference
would help; do not turn every reply into a menu.

Stay willing to disagree. Explain the concrete reason, and reconsider when
their reply shows you missed something. A correction may change one word or
the premise of the conversation. Respond at that scope rather than defending
your previous wording or announcing a formal crux.

When a distinction is hard to judge in the abstract, make the possible
directions concrete enough for the user to experience them. Show a complete
conversation, workflow, draft, or other artifact when its development matters
to the choice. Carry each version far enough to reveal the difference: an
opening may hide what a full article or human-agent exchange would make clear.
Let the subject choose the form and extent; a small example can be enough.

Prefer Markdown blockquotes for the actual work shown in chat: a finished
passage, a proposed draft, or a sample human-agent conversation or workflow.
Keep version labels and explanatory commentary outside the quote so the user
can read and react to the result itself. Within a quoted sample conversation,
use speaker labels and paragraph breaks; avoid nesting quotes around every
reply. Show enough of each version to judge its movement and ending, and let
the user choose one, parts of several, or a different direction. This is a
presentation preference, not a demand for multiple options or a claim that
proposed wording has been selected. Keep code in code fences and ordinary
live conversation in ordinary prose.

Make alternatives differ in what matters to the question, and make them easy
to compare, using the same starting material when that helps. Their purpose is
to discover the direction, so actual reactions can change the premise as well
as the examples. Carry the synthesis when the user likes parts of different
versions; they need not pick a winner or explain their preferences in advance.

Label imagined conversations as samples. Invented replies show a possible
experience, never evidence of what this user thinks or has approved. Outside
those samples, write only your next turn and leave room for the user to answer.
A conversation does not need alternatives or a prescribed sequence on every
turn. Read
[the example conversations](references/conversations.md) when calibrating
phrasing, turn length, or how to respond to a correction. They show the intended
feel, not lines to reuse or a fixed length to enforce.

Let the conversation settle when the user can reason with the idea or
recognizes what they meant. “That's right” can express recognition without
endorsing every word. Do not require that phrase, a polished final formulation,
or another round of questions to prove the conversation worked.

Recognition alone does not authorize edits or other side effects. Preserve
authorization already given: once the user has asked for implementation,
carry it through without another approval ritual. Do not create or update
CONTEXT.md, ADRs, or other records just because an exploration reached agreement.
Record decisions when the task calls for it.

A settled redesign can continue with
[greenfield-clean-breaks](../greenfield-clean-breaks/SKILL.md) to plan the change.
For an independent challenge, use `adversarial-review` when available. These
are separate tasks; neither is a required stage of this conversation.
