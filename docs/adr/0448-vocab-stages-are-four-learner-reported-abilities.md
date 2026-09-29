# 0448. Vocab stages are four learner-reported abilities

- **Status:** Accepted
- **Date:** 2026-09-24
- **Amends:** [ADR-0102](0102-vocab-stores-verbatim-entries-under-a-human-owned-note-and-refuses-glosses-srs-and-provenance.md) (the three-stage acquisition dial)

## Context

An English expression can look familiar before the learner understands it in a sentence. Vocab's former `new`, `understood`, and `usable` stages had no place for that difference. The learner may reconsider a word while using it in a conversation, but a generated passage does not establish that they recognized, understood, or used it.

## Decision

**Each saved entry has one learner-reported stage: New, Recognize, Understand, or Use.** The corresponding stored values are `new`, `recognized`, `understood`, and `usable`.

- New: I saved this and have not assessed it yet.
- Recognize: It looks familiar, but I still need help with its meaning.
- Understand: I understand it when I encounter it.
- Use: I can use it myself.

Saving an entry starts it at New. Words and the chat's focus panel offer the same four labeled buttons as one single-select control. The chat control is optional and changes a saved entry's stage without ending the conversation. Only an explicit learner action changes the stage. The learner can choose any stage, including an earlier one; a generated answer, completed conversation, or model judgment never advances it.

## Consequences

Stages record the learner's judgment rather than a measured score. If the learner does not revisit an entry's stage, it can become stale. Four visible choices replace the sidebar's select menu without making stage review a required step at the end of a chat.

The four-value entry schema is already implemented. The selector change needs no data migration. The entry still needs no score, review history, exposure counter, or scheduler.

## Considered alternatives

- Keep three stages: loses the distinction between recognizing a form and understanding it in context.
- Add a fifth confidence or mastery stage: asks for another judgment without changing a learner action.
- Advance entries after a conversation: completion of generated material does not demonstrate learning and would let a device-local chat silently rewrite account-backed entries.
