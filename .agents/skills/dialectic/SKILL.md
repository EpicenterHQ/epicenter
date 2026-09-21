---
name: dialectic
description: Help the user work through an unsettled idea and find words for what they mean through conversation. Use when the user asks for a dialectic, wants to think through an uncertain model or decision, or needs help articulating a thought they cannot quite express. Do not use for routine execution of a settled request, a standalone explanation of settled material, or a code review.
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
polish is useful only when it makes that meaning easier to hear.

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

Use a concrete situation, code, or a diagram when it makes the idea easier to
judge. Let the subject choose the form. A conversation does not need a named
crux, a complete vision, or a prescribed sequence of moves on every turn.

Stop after your turn and give the user room to answer. Do not write their
replies for them unless they asked for a sample conversation. Read
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
