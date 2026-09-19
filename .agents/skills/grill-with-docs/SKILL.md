---
name: grill-with-docs
description: Stress-test a plan against the project's domain model and record settled terminology and decisions. Use when the user wants an interview grounded in existing context or ADRs. Do not use for a read-only code review or ordinary documentation edits.
---

# Grill with docs

Use [grill-me](../grill-me/SKILL.md) for the interview and its stopping condition.
This skill adds domain evidence and a durable home for what the user settles.

## Ground the discussion

Read the relevant context, ADRs, and current code. Follow `CONTEXT-MAP.md` if it
exists; otherwise locate the project's existing context document rather than
assuming it lives at the root. A glossary or ADR is evidence of an earlier
understanding, not authority over the user's intended outcome.

When a term or proposed behavior conflicts with that evidence, explain the
consequence and recommend a resolution. Use a concrete scenario when it makes
the distinction easier to judge. Establish whether the user is describing
current behavior or changing it before treating a mismatch as an error.

## Record what settles

Update the existing domain glossary as terminology settles, preserving its
scope and conventions. Keep implementation plans out of glossary entries.
Create a glossary only when a resolved domain term needs one; read
[CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md) for a starting format when the project
has no convention. Do not turn tentative reactions into accepted definitions.

Record a durable decision when changing it would be costly, its reason would
otherwise be surprising, and it resolves a real trade-off. Follow the project's
ADR conventions, including status and numbering; in Epicenter, read
`docs/adr/README.md`. Use [ADR-FORMAT.md](./ADR-FORMAT.md) only when the project
has no convention. A proposed decision remains proposed until accepted.

Finish with the agreed outcome, the records changed, and the next concrete step.
Do not extend the interview merely to fill a glossary or generate an ADR.
