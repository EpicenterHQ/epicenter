# 0306. Borrowed data is disposable and a person's own data is not

- **Status:** Accepted
- **Date:** 2026-08-31
- **Amended by:** [ADR-0318](0318-epicenter-data-is-what-epicenter-is-the-authority-for-and-a-foreign-write-is-a-command.md) at the classification test. Withdrawn: origin and recoverability as the question, which misclassifies a draft composed against a provider. The two classes, the obligations table, and the refusals below all stand, and the table gains a row for how a write happens.
- **Relates:** [ADR-0247](0247-an-app-that-keeps-a-local-copy-of-a-providers-data-owns-its-file-lifecycle.md) (an app owns its provider copy's lifecycle), ADR-0280 (the local database has no authority to refill from), and ADR-0298 (what the authority holds for a person)

## Context

Epicenter keeps two classes of local data and has been reasoning about them with
one vocabulary. A person's notes are authored here and exist nowhere else until
they sync; losing them is unrecoverable. An app's copy of a provider's data, such
as Local Mail's 40,000 Gmail messages, was authored somewhere else and can be
fetched again.

Every expensive problem in storage, migration, repair, backup, export, and format
versioning, exists because losing the bytes would be a tragedy. Applying that
whole apparatus to a copy that can be re-fetched buys nothing and costs a code
family per app.

## Decision

**Borrowed data may be thrown away at any time. A person's own data may never
be.**

```txt
  a person's own data              borrowed data
  -------------------              -------------
  a note they wrote                40,000 Gmail messages
  authored HERE                    authored by a provider
  lost = gone forever              lost = fetch it again
       |                                |
       v                                v
  migration, repair,               none of them. a shape change
  backup, export                   is a new filename.
```

Every expensive problem in storage exists because losing the bytes would be a
tragedy. For a copy that can be re-fetched it is an inconvenience, so all of it
deletes. The classification decides what code exists:

| | a person's own data | borrowed data |
| --- | --- | --- |
| authored | here | by a provider |
| recovery if lost | none; it is the only copy | fetch it again |
| synchronizes | yes, through the authority | never |
| migration on open | required | refused |
| repair on read | required | refused |
| backup and export | required | refused |
| how a shape change lands | a format the reader understands, or an export and re-import (ADR-0280) | a new filename, the predecessor retained (ADR-0197, ADR-0247) |

A borrowed copy therefore ships no migration path, no repair path, and no
recovery code. A shape change is a version in the filename; the old file is
retained until something reclaims it, and nothing is rewritten in place. When a
copy cannot be read, the answer is to delete it and pull again.

The re-pull is expensive: a full Gmail backfill costs hours and metered provider
quota. That expense is accepted as the price of never writing the code that
avoids it. Filename versioning is how the price is usually dodged, not a promise
that it never comes due.

## Consequences

- `apps/local-mail` and `apps/local-books` already implement this and are the
  reference. Nothing about their file lifecycle changes.
- The platform never offers migration, repair, backup, or export for an
  application's own database. Offering one would make the platform responsible
  for a schema only the application knows.
- A derived index over a person's data is the most disposable thing in the
  system: it is not even fetched again, it is recomputed (ADR-0307).
- This is a classification, not a durability claim. Borrowed data is still
  written durably; it is the recovery obligation that is refused, not the write.
- A future application whose local copy CANNOT be re-fetched is not borrowed data
  and does not get this treatment. It is a person's own data and belongs in
  Epicenter Data.

## Considered alternatives

- **One storage doctrine for both classes.** Rejected because it forces the
  strictest requirement onto every byte, which is how a Gmail cache acquires a
  migration path it never needed.
- **Let each app decide its own recovery posture.** Rejected as already tried:
  the shared primitive ADR-0247 deleted had been sanded down to filename
  arithmetic precisely because it could not name what kind of copy it held.
