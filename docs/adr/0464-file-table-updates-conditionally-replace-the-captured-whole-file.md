# 0464. File table updates conditionally replace the captured whole file

- **Status:** Proposed
- **Date:** 2026-09-30
- **Relates:** [ADR-0518](0518-a-row-is-read-through-one-pipeline-and-repaired-as-text.md) (the capture-guarded row writes this condition governs), [ADR-0515](0515-snapshot-saves-serialize-writes-and-retain-only-the-latest-pending-text.md) (an edit session's saves), ADR-0522 (the one scoped retry; replaced by [ADR-0576](0576-a-folder-has-one-write-a-merge-by-unit-where-the-writer-acting-wins.md) and deleted)

## Context

A document editor submits a complete row that began from bytes it read. If
another writer changed the file since, saving over it would erase changes the
editor never showed. Retrying the save against the newer bytes would erase
them just the same, one read later.

## Decision

**A guarded write makes one conditional attempt against the bytes the caller
captured, and never retries.**

- `replace(capture, row)`, `rename(capture, stem)`, `delete(capture)`, and
  `files.replace(capture, content)` publish only while the file still hashes to
  the capture's `sha256`. Otherwise the write is `Conflict` and wrote nothing.
- The condition is on the whole file, even when a person changed one field,
  so a change to any other field is a conflict too.
- A conflict goes back to the caller, which decides whether to reread, ask the
  person, or save something new. No write substitutes a newer baseline, and
  no retry count or transform callback exists.
- An outcome the storage could not confirm is `Unconfirmed`. It is never
  replayed: a reread shows the current file, not whether the earlier attempt
  landed.
- `create` is the one unconditional write, and it is exclusive.

The one exception is a settings write (ADR-0522), whose intent does not depend
on the file's previous contents, so re-applying it to newer bytes erases
nothing.

## Consequences

- An edit session (ADR-0515) guards each save by the capture its previous save
  confirmed, so a file that changed or vanished in between is a conflict
  rather than overwritten or recreated.
- Concurrent saves on one handle can conflict; the library promises no
  ordering under contention.
- On a desktop folder the check is best effort against other programs: a hash
  check followed by a rename is not an operating-system-wide compare-and-swap.

## Considered alternatives

- **Retry a conflict internally.** Erases the newer edit one read later, and
  adds a retry bound to decide.
- **Patch only the changed fields under a fresh read.** Lets a value derived
  from stale bytes land over a newer body, and keeps a second write path.
- **Overwrite without a condition.** Kept as `files.overwrite` for a caller
  that means it, never for a document editor.

This record was rewritten when ADR-0518 replaced the stem-addressed
`update`, `replace`, and `expectedSha256` options it first described; the
earlier text is at `git show d164ff068b:docs/adr/0464-file-table-updates-conditionally-replace-the-captured-whole-file.md`.
