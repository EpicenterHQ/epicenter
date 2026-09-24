# 0448. Vocab stages are four learner-reported abilities

- **Status:** Proposed
- **Date:** 2026-09-24
- **Amends:** [ADR-0102](0102-vocab-stores-verbatim-entries-under-a-human-owned-note-and-refuses-glosses-srs-and-provenance.md) (the three-stage acquisition dial)
- **Unbuilt:** Entries still use `new`, `understood`, and `usable`; the sidebar cycles those three values.

## Context

An English expression can look familiar before the learner understands it in a sentence. Vocab's current `new`, `understood`, and `usable` stages have no place for that difference. The learner wants to review their familiarity after practice, but a generated passage does not establish that they recognized, understood, or used any selected entry.

## Decision

**Each saved entry has one learner-reported stage: New, Recognize, Understand, or Use.** The corresponding stored values are `new`, `recognized`, `understood`, and `usable`.

- New: I saved this and have not assessed it yet.
- Recognize: It looks familiar, but I still need help with its meaning.
- Understand: I understand it when I encounter it.
- Use: I can use it myself.

Saving an entry starts it at New. Only an explicit learner action changes its stage. The learner can choose any stage, including an earlier one; a generated answer, completed activity, or model judgment never advances it. A Practice activity may offer a moment to review selected entries, but the exercise format and review UI are separate decisions.

## Consequences

Stages record the learner's judgment rather than a measured score. If the learner does not revisit an entry's stage, it can become stale. Direct selection replaces the three-stage cycling button so changing or correcting a judgment does not require stepping through unrelated values.

The implementation can replace the three-value schema without migrating learner rows because this Vocab change has zero existing users and data. The entry still needs no score, review history, exposure counter, or scheduler.

## Considered alternatives

- Keep three stages: loses the distinction between recognizing a form and understanding it in context.
- Add a fifth confidence or mastery stage: asks for another judgment without changing a learner action or Practice path.
- Advance entries after Practice: completion of generated material does not demonstrate learning and would let a device-local activity silently rewrite account-backed entries.
