# 0829. A restore never deletes on a device, and history's chain covers what changed, not who

- **Status:** Superseded
- **Date:** 2026-11-07
- **Superseded by:** [ADR-0899](0899-the-folder-sync-product-is-retired.md): the folder sync product is retired, and this record is its history.
- **Amends:** [ADR-0824](0824-a-folders-history-is-a-log-of-versions-and-git-is-how-it-leaves.md) at the digest covering the change and at "writes conflict only on the same file": the digest covers what changed and when, never who; every commit to a folder waits its turn, and only a write to the same file is refused; [ADR-0806](0806-an-open-app-checks-for-changes-and-a-sync-never-silently-loses-an-edit.md) at a window pausing while hidden, which was never built.
- **Relates:** [ADR-0809](0809-a-repository-is-a-spaces-app-and-bytes-nothing-needs-are-collected-or-purged.md) (purge), [ADR-0821](0821-a-computer-remembers-what-it-synced-and-a-shell-limits-each-window-to-its-folder.md) (the record of what was agreed), [ADR-0826](0826-history-enters-and-leaves-epicenter-as-git.md) (the export).
- **Amended by:** [ADR-0836](0836-one-merge-a-cursor-that-carries-its-digest-and-one-grant.md) at rotating every folder's epoch on a restore: a cursor carries its digest, and no epoch exists.
- **Unbuilt:** all of it: epoch rotation on restore and its runbook step; the digest in each `changes` answer and a client dropping its base on a mismatch; the scan for bytes a restore lost; the deletion outbox and its scheduled sweeper; a re-upload that claims a purged row first; a chain without author fields.

## Context

Reviewers found that restoring the server lost edits on every device: a folder's
epoch was never rotated, so a device compared against what it last agreed, and
a file the server no longer had counted as deleted there and was deleted
locally. Deleting a folder or purging bytes removed bytes outside the
transaction with no retry, and a re-upload could race a purge into a row that
names missing bytes. The chain of digests over a folder's changes hashed each
change's author, so a person could not be erased without breaking it.

## Decision

**A restore never deletes on a device.** Restoring rotates every affected
folder's epoch, and every answer to "what changed" carries the digest at its
cursor. A device that meets an unfamiliar epoch or digest drops what it had
agreed and starts from first contact, which never deletes. After a restore, the
operator's scan marks as purged every byte the store no longer holds.

**Bytes leave only through an outbox.** Deleting a folder or purging bytes
writes what must go in the same transaction, the deletion trigger included, and
a scheduled sweeper removes it, retrying until it does. A re-upload takes a
purged row back to pending before writing its bytes, and the sweeper deletes
only rows still purged.

**The chain covers what changed and when, never who.** A change's digest covers
its sequence, time, program, and each path's version and size; its author,
account, and message stay outside, so a person can be erased and the chain
still verifies. Erasing a person changes the Git export's commits from their
first change, so a mirror is pushed again with force.

**Every commit to a folder waits its turn**, and only a write to the same file
is refused.

## Consequences

- An operator can restore without devices losing work.
- Nothing a folder held outlives its deletion in the blob store.
- History can forget a person and still prove itself.
