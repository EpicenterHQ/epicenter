# 0395. Recovering old content uses the current working copy

- **Status:** Proposed
- **Date:** 2026-09-12
- **Amends:** [ADR-0272](0272-restore-replaces-a-workspace-from-an-artifact-under-a-new-document-identity.md) at the product recovery workflow: bringing old content back uses ordinary Push, not a restore endpoint or replacement document. [ADR-0281](0281-a-generation-is-a-whole-database-and-a-device-chooses-which-one-it-holds.md) at recovery through writable historical generations: no generation picker is required.
- **Relates:** [ADR-0337](0337-the-folder-is-a-working-copy-and-pull-and-push-are-the-whole-cycle.md) (the working copy), [ADR-0338](0338-the-folder-wins-and-a-push-is-one-approval.md) (Push semantics), [ADR-0343](0343-a-preview-is-an-output-and-the-side-that-showed-it-applies-it.md) (preview and recheck), [ADR-0394](0394-a-backup-is-the-library-s-folder-kept-by-the-authority.md) (folder contents).
- **Implementation:** `createWorkingCopy` already exposes Pull and Push with previews, new-row admission, permanent row deletion, and reports for unreadable files. A dedicated backup-restoration UI is not required.

## Context

The earlier draft specified a one-request destructive restore with a server
safety copy. It would replace every device's library and discard unsynchronized
work from retired generations.

The selected use case is narrower: someone has old readable files and wants to
bring some content back. Schema changes and serialization loss are acceptable
when the files can be inspected and repaired. The existing working-copy preview
provides the application path.

## Decision

**Recover old content by editing a current working copy, then use ordinary Push.**

1. Preserve the old folder separately. Pull the intended destination library
   into its working copy, handling any existing folder edits through the
   normal preview.
2. Copy selected old document contents into that working copy. Keep the current
   `.epicenter/manifest.json`; do not replace it with the old copy's manifest.
   Leave unrelated current files in place.
3. Inspect the Push preview. Repair unreadable files and retry, or approve the
   readable changes while the remaining files stay available for repair.

An existing row's file carries an ordinary edit. A recovered file with no live
row is admitted as a new row with a newly minted ID; the old filename does not
resurrect a deleted identity. Recovery does not guarantee identity preservation,
automatic remapping of references between recovered rows, deduplication, or
exactly-once repetition. People or applications repair links where needed.

The baseline makes recovered content a deliberate change relative to the
current library. Copying an old manifest would instead change the comparison
base and can misrepresent unrelated edits or deletions. Recovery copies selected
content; replacing the whole working directory is not an implicit restore.

**Deleting a materialized Markdown file and approving Push permanently deletes
its row. Trash is an ordinary application field.**

An application may declare `trashedAt: string | null` or another trash field.
Setting that field moves the row into the application's Trash view; clearing it
restores the row. The Markdown file remains materialized while the row exists.
The framework imposes no reserved trash field or universal Trash service.
Deleting the file bypasses that application convention and deletes the row.
Deleting a row or changing its blob reference never deletes the blob.

**Keys and URLs are recovered as values, without restoring their bytes.**

A reference works only where the independent local file or authorized remote
object remains available. Push never creates a synchronization obligation or
fetches a missing blob to make an old document readable.

A decodable field value need not conform to the current application's schema.
The working-copy parser reports unreadable content; application validation
reports nonconforming values. Do not promise that every schema mismatch blocks
Push or that importing old text reconstructs exact editor state.

## Consequences

Recovering content uses the existing preview and confirmation. It creates
ordinary synchronized edits and does not retire other replicas or discard their
pending work. No backup browser, restore wizard, safety-copy transaction, or
new restore route is required.

The existing activation and journal implementations remain until separately
audited. This decision does not authorize removing generation admission,
cache invalidation, or retirement fences from running code (ADR-0379).

## Considered alternatives

- Restore an entire historical library: introduces a cross-device loss boundary
  and a separate product action.
- Import the old manifest together with old content: mistakes historical
  provenance for the destination's current comparison baseline.
- Require exact round-trip compatibility: prevents useful recovery from readable
  files that people or agents can repair.
- Make every deleted file a Trash operation: hides permanent deletion behind a
  framework convention that applications need not implement.
