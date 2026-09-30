# 0468. Every completed app save has a recoverable Git revision

- **Status:** Proposed
- **Date:** 2026-09-30
- **Unbuilt:** automatic save revisions, durable completion, direct history queries, and browser/native storage measurements.

## Context

The earlier file-folder plan separated saved files, staging, and commits. A
person could save a note without retaining that version in history. Preserving
manual staged selections during autosave also requires native index coordination
and a browser staging implementation.

The intended experience is ordinary editing with automatic, recoverable history.
The editor already chooses when accumulated typing becomes a save. A second
checkpoint schedule creates another state the app must explain.

## Decision

**A completed app save publishes its accepted current files and records their
exact bytes in completed Git history before acknowledging success.** Each
changed save appends one commit to the folder's app-managed branch. One supported
operation, such as renaming a recording and its audio, records all participating
paths in that commit. History remains append-only. Restoring an earlier version
is a new conditional save.

The editor batches typing before submitting a save. A keystroke creates no Git
commit by itself. Derived title and timestamp changes belong to the same source
generation. An unchanged save still checks freshness and ensures its accepted
bytes are retained; it need not create an empty commit. Retain observed external
bytes before replacing them. Their capture can create a separate external-change
commit if they were not already in history.

The folder owns publication and automatic history. Managed writes through its
file boundary, including browser shell writes, use this completion rule.
Application callers do not stage files or coordinate a second commit. A browser
shell command can make several separately acknowledged writes; the command is
not thereby one transaction.

Native external programs still edit ordinary current files. The app records
states it observes, without inferring intent or promising to capture every
transient external version. A commit records the known snapshot with the
operation's accepted changes. It does not certify a fresh scan of all untouched
native paths.

**Git retains history and pending payloads; current files remain the saved
source.** Pending evidence identifies before/after bytes and publication
requirements. Its bytes have actual Git reachability through objects and refs.
Mentioning an object ID in a message is insufficient. History introduces no
second writable current tree or duplicate completed-operation database.

The folder supports history inspection and conditional restore without public
stage, unstage, amend, reset, or rebase operations. A native index kept for Git
inspection is derived state. Manual staging alongside autosave is outside the
managed workflow. Unexpected branch rewrites stop automatic publication and
retain evidence. Rewrite detection and retention of acknowledged revisions must
be proven before migration.

Completed history initially retains every revision, including actual attachment
bytes. Direct commit queries supply file history. A persistent history index,
history thinning, and permanent erasure are separate decisions if needed.
Deletion removes current paths while earlier versions remain recoverable.
An LFS pointer alone does not retain the required media payload.

"Saved" describes local completion. Remote synchronization has its own status.
History does not retain typing that never reached a save. Generated query indexes
are outside save completion. Separate repositories cannot provide one atomic
checkpoint.

## Consequences

- App staging, browser staging state, a separate checkpoint scheduler, and a
  duplicate historical byte store are unnecessary for this workflow.
- Published files without completed history form an incomplete operation.
  Recovery retains its evidence instead of blindly retrying a normal failure.
- Autosave creates more commits. UI grouping must preserve acknowledged versions.
  Save cadence, browser latency, and retained bytes need realistic measurements.
- Delete and restore copy must describe retained history. Existing claims that
  deletion cannot be undone must change when those applications migrate.
- Existing Yjs stores retain their current contract until deliberately migrated.

## Considered alternatives

- Keep save, stage, and commit independent. Manual Git curation retains staged
  state coordination and versions saved without history.
- Checkpoint only structural operations. Text saves would have a different
  history guarantee from create, delete, and rename.
- Commit later or amend earlier autosaves. Delayed history leaves a failure
  window; preserving replaced commits requires more reachability machinery.
- Build a separate revision log. Git supplies snapshots and media for the
  initial full-retention, direct-query policy. A custom log must justify its
  storage, query, retention, and interoperability contracts.
