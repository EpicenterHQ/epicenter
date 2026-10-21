# 0503. File-authoritative workflows preserve information and tolerate repairable states

- **Status:** Proposed
- **Date:** 2026-10-04
- **Amended by:** [ADR-0576](0576-a-folder-has-one-write-a-merge-by-unit-where-the-writer-acting-wins.md) at the draft's save: a save no longer stops as `Conflict` for **Reload theirs** or **Keep mine**. It merges by unit with the file as it is now, the writer winning a unit both changed, and a delete beats an edit that never saw it. The rest of this record stands.
- **Relates:** [ADR-0477](0477-file-folder-operations-tolerate-repairable-layout-disorder.md) and [ADR-0482](0482-folder-mutations-publish-one-file-at-a-time.md) establish repairable layouts and independent file operations.
- **Unbuilt:** Applying this review criterion to application refusals and choosing simpler folder-deletion behavior in Honeycrisp.

- **Current edit implementation:** [ADR-0666](0666-one-source-draft-per-path-saves-against-its-observed-source.md) describes the implemented whole-source draft behavior; its decision remains Proposed. `FileEdit` commands change one pinned source in call order; storage matching neither its observed source nor its draft causes a whole-file `Conflict` rather than a field or body merge. Direct `files.write`, `tables.<name>.set`, and Git sync retain their content merge rules. The earlier draft-merge descriptions below record the prior model.

## Context

Epicenter stores ordinary files so a human or coding agent can inspect what
happened and repair it. That access should shape the guarantees we pursue.

The folder API keeps the text of an invalid row accessible, reports each
issue with its line, and guards every save of an existing row by the bytes it last confirmed.
Applications can still accumulate checks aimed at preventing
inconsistent relationships. Honeycrisp refuses folder deletion when any note's
folder cannot be read, then clears each member note's `folderId` before removing
the folder. Another program can change those relationships afterward anyway.

A malformed file or dangling reference can be corrected with another edit.
An overwritten draft or discarded field cannot be recovered unless some
version retained it. Those failures deserve different protection.

## Decision

**File-authoritative workflows tolerate visible inconsistencies that a human
or coding agent can repair with another edit.**
The review question is: "If this goes wrong, will a human or coding agent have
enough information to understand and repair it?" Source must remain accessible,
the problem must be discoverable, and correction must not require reconstructing
erased intent. An application permits work that does not depend on the broken
data. Repair need not restore the previous state: reassigning a note whose
folder was deleted can be a sufficient correction.

**Edits protect information from accidental loss.**
Change only what was requested, retain unknown keys and the body, and keep
unsaved input when publication fails or remains unknown. A save may rewrite
frontmatter formatting into its standard form; it may not drop a value. Keep
per-file conditions and exclusive destinations that prevent accidental
replacement, and keep raw-text repair available. Intentional deletion and
whole-file replacement retain their explicit contracts.

A table save writes the complete row, so a field the row omits disappears
from the file. Unknown keys survive because a read under [ADR-0518](0518-a-row-is-read-through-one-pipeline-and-repaired-as-text.md)
returns the complete row, unknown keys included, and the application edits
that row; nothing reconstructs a row from partially validated fields or merges
keys from disk.

The application owns the draft in an edit session ([ADR-0523](0523-applications-own-drafts-in-edit-sessions-and-leave-one-open-item.md)). Each
save is guarded by the bytes the session's previous save confirmed
([ADR-0515](0515-snapshot-saves-serialize-writes-and-retain-only-the-latest-pending-text.md)), so a change made elsewhere, or a deleted file, stops the
save as `Conflict` and overwrites nothing. The person chooses **Reload theirs**,
which replaces the draft with the file, or **Keep mine**, which saves the draft
over the file or creates it again. A failed or unconfirmed save leaves the draft
on screen. A field-local buffer remains useful where a control holds input that
the row cannot represent yet.

A row that does not read as valid is opened as text and repaired there; there is
no partial row (ADR-0518).

**Partial workflows leave completed edits saved and report their outcomes.**
Distinguish success, refusal, and uncertainty. Before adding a refusal,
transaction, rollback, or recovery mechanism, name the information it protects
and the repair path without it. Remove machinery whose only purpose is
preventing a repairable inconsistency once visibility and repair are established.
A human or agent may need to make a later correction; that effort is part of
the tradeoff.

## Consequences

The first application is Honeycrisp folder deletion. All Notes already includes
notes whose folder is missing; the note editor shows the missing ID and offers
reassignment. Verify that path after reopening before simplifying deletion.

Prefer evaluating deletion of only the folder file: note references and drafts
stay untouched, and restoring the same folder ID restores membership. Compare
that with the current reassignment to `null`, which clears membership. Reusing
an old ID for a different folder would also reattach those notes. Choose and
state the intended behavior before changing the operation and its dialog.

This criterion does not make every operation unconditional. `create` and a
table edit session write only valid rows; a draft that fails the schema is
reported and never written. An invalid row is repaired through a text session
over `files`, which saves exactly what is typed.
Git preserves versions actually captured by commits; an automatic commit
request does not establish a retained copy. Path, credential, and Git
publication protections keep their existing owners.

Tests for a simplified workflow should establish that problematic source stays
accessible, unrelated work continues, drafts survive, and a later edit repairs
the state. The next slices live in [the backlog](../../BACKLOG.md#apply-repairability-to-file-authoritative-workflows).

## Considered alternatives

- Prevent every inconsistent relationship: adds coordination that outside
  writers can invalidate.
- Rely on an agent to fix any failure: an agent still needs source and evidence.
- Treat Git as universal rollback: versions never captured remain unrecoverable.
