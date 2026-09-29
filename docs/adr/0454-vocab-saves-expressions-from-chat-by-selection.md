# 0454. Vocab saves expressions from chat by selection

- **Status:** Accepted
- **Date:** 2026-09-24
- **Relates:** [ADR-0102](0102-vocab-stores-verbatim-entries-under-a-human-owned-note-and-refuses-glosses-srs-and-provenance.md) (explicit selection capture)

## Context

Vocab already lets the learner select text in a settled tutor answer and save that exact expression. It also offers Suggest entries on each answer, which makes a separate model request, parses candidate text, and displays a tap-to-save tray. The learner has chosen direct selection as the chat capture action. Multiline additions from outside chat have their own reviewed import path.

## Decision

**Saving from chat starts with the learner selecting the expression in a settled tutor answer.** The Save expression affordance stores the trimmed selection as one entry through the existing exact-text save rule. A selection may be a word or a phrase. Selecting an entire answer would save that answer as one entry; Vocab does not split it into candidate expressions.

Vocab removes Suggest entries and its model-generated candidate tray. To save several expressions from one answer, the learner makes several selections. The chat does not infer which words to add to Personal `entries`.

## Consequences

Chat capture has no extra completion request, candidate parser, suggestion loading or failure state, or saved-candidate checks. The learner chooses the exact span, including on a narrow screen. Touch selection takes more effort than tapping an offered suggestion. Adding multiple expressions in one operation remains available through the separate multiline import review, not by parsing a tutor answer.

## Considered alternatives

- Keep Suggest entries beside selection: preserves one-tap candidate saving but keeps a second model call and parsing path for the same entry collection.
