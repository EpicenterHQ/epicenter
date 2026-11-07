# 0836. One merge, a cursor that carries its digest, and one grant

- **Status:** Accepted (2026-11-07)
- **Date:** 2026-11-07
- **Amends:** [ADR-0829](0829-a-restore-never-deletes-on-a-device-and-historys-chain-covers-what-changed-not-who.md) at a restore rotating every folder's epoch: a cursor names its change's digest, and a device that finds the digest changed drops its base, so no epoch exists; [ADR-0820](0820-a-share-is-an-invitation-to-an-email-and-reaching-every-folder-is-a-permission.md) and [ADR-0811](0811-folders-are-shared-directly-and-an-app-reaches-the-folders-attached-to-it.md) at members, invitations, and app attachments as separate things: each is a grant; [ADR-0826](0826-history-enters-and-leaves-epicenter-as-git.md) at `epicenter mark`: a named moment is a tag.
- **Relates:** [ADR-0830](0830-epicenter-sends-a-change-the-moment-it-happens-and-checks-for-others-every-thirty-seconds.md) (a line is the unit of merge), [ADR-0835](0835-records-from-0802-to-0834-agree-on-files-a-ledger-and-git-at-the-edges.md) (the register).
- **Amended by:** [ADR-0837](0837-the-ledger-is-the-persons-model-folders-the-versions-of-their-files-and-who-may-see-them.md) at a grant holding a web app and at tags: a grant holds a person or an email, and there are no tags.
- **Amended by:** [ADR-0839](0839-a-save-is-one-numbered-write-a-reset-deletes-nothing-and-epicenter-owns-the-pages-every-app-links-to.md) at a device finding a changed digest: the ledger answers "reset", and a reset deletes nothing.
- **Unbuilt:** all of it: one merge for every writer; cursors with digests and no epoch; one grant table; "ledger" for "repository" in code.

## Context

Two merges exist: sync's merges by line and by key, while the merge an app's
own write and an agent's tools use still tries words first, so the same two
edits merge differently by who merges them. A restore was to rotate every
folder's epoch, a step an operator can forget, though every change already
carries a digest that changes when history is rewritten. Members, invitations,
and app attachments are three tables answering one question: who may reach
this folder. "Mark" names both the four status symbols and a named moment.

A per-folder database on Durable Objects was weighed and refused: each request
is authorized against people and members in Postgres, so the objects saved no
round trip; the Worker sits beside Postgres, so they gained no locality; and
every folder's heads and titles, deleting a folder, and restoring the service
would have crossed two stores. Durable Objects fit a server where work happens
in memory; Epicenter's server only orders and remembers.

## Decision

**One merge, for every writer.** Sync, an app's own write, an agent's tool, and
a landed branch all merge a field by key and a body by Git's line merge. No
writer merges by word.

**A cursor carries its digest.** A device remembers the change it last saw and
that change's digest; when the ledger's digest at that change differs, history
was restored or rewritten, and the device drops what it had agreed and starts
from first contact. No epoch exists, and a restore needs no step to protect
devices.

**Access is one grant**: a folder, a holder (a person, an email not yet
accepted, or a web app), and a role (member or reader). Accepting an invitation
binds its email to the person.

**A named moment is a tag**, as Git calls it and the export writes it; a mark
is one of ✓ ◌ ⚠ ✗. A collection holds notes or files; nothing is renamed to
"item". The code's "repository" becomes "ledger".

**Two invariants hold.** The server keeps nothing about devices: cursors and
records live on them. Hidden files are the computer's own and never sync.

## Consequences

- The same two edits merge the same way, whoever merges them.
- An operator can restore without a runbook step for devices.
- Who may reach a folder is answered by one query.
