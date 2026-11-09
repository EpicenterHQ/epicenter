# 0837. The ledger is the person's model: folders, the versions of their files, and who may see them

- **Status:** Superseded
- **Date:** 2026-11-07
- **Superseded by:** [ADR-0840](0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md), the same day: Epicenter became the home of one person's apps and agents, and the folder sync product this record belongs to waits. Read it as that product's design.
- **Amends:** [ADR-0824](0824-a-folders-history-is-a-log-of-versions-and-git-is-how-it-leaves.md) at a change as a batch of file writes, and at marks: the log is one row per file version, each with its own sequence number, and nothing names a moment; [ADR-0826](0826-history-enters-and-leaves-epicenter-as-git.md) at marks and tags: an import drops a repository's tags with a warning, and an export writes none; [ADR-0836](0836-one-merge-a-cursor-that-carries-its-digest-and-one-grant.md) at a grant's holder being a person, an email, or a web app, and at a named moment being a tag: a grant holds a person or an email, and there are no tags; [ADR-0820](0820-a-share-is-an-invitation-to-an-email-and-reaching-every-folder-is-a-permission.md) and [ADR-0811](0811-folders-are-shared-directly-and-an-app-reaches-the-folders-attached-to-it.md) at a web app reaching the folders attached to it: a web window holds a token for the one folder it was opened on; [ADR-0833](0833-a-folders-present-lives-in-one-shared-database-and-its-past-in-its-own-archive.md) at text up to 2 KiB stored inline: where bytes sit is the code's choice, not a decision.
- **Relates:** [ADR-0814](0814-one-window-shows-one-folder.md) (one window shows one folder), [ADR-0795](0795-git-merges-a-notes-body-and-epicenter-merges-its-front-matter-by-key.md) and [ADR-0830](0830-epicenter-sends-a-change-the-moment-it-happens-and-checks-for-others-every-thirty-seconds.md) (the merge), [ADR-0835](0835-records-from-0802-to-0834-agree-on-files-a-ledger-and-git-at-the-edges.md) (the register).
- **Amended by:** [ADR-0839](0839-a-save-is-one-numbered-write-a-reset-deletes-nothing-and-epicenter-owns-the-pages-every-app-links-to.md) at a sequence number per file version: versions saved together share one, and a version names its program and may carry a message.
- **Unbuilt:** all of it: the `version` table replacing `change` and `change_file`; removing marks; tokens for one folder through OAuth resource indicators; a web app's home that opens a folder; removing app attachments, `attach`, and `detach`.

## Context

A person knows four things about Epicenter: folders, the files in them, every
version of each file, and the people a folder is shared with. The server stored
more: a change grouping file writes beside a row for each file, marks naming
moments, a table of which web app may reach which folder, and a threshold
deciding which bytes sit in the database. Each served a mechanism or one
surface, not the person, and each was a word a reader had to learn. A desktop
app never reaches the folder server; only a web app does, and only because it
has no disk.

## Decision

**The ledger stores the person's model and nothing else.**

| Table | Holds |
| --- | --- |
| `folder` | its id and last sequence number |
| `version` | folder, sequence number, path, content (a SHA-256, or none for a delete), size, author, time |
| `content` | folder, SHA-256, size, and its bytes, held in the database or the blob store |
| `grant` | folder, a person or an email not yet accepted, and a role, member or reader |

An index of each folder's current files serves the checks a write needs. People
and sign-in stay in the authentication tables.

**A version is the unit of history.** Each file version has its own sequence
number; versions saved together are written in one transaction and share their
author and time. Cursors, the digest chain, a file's history, and a folder as of
any moment read versions.

**History is reached by time.** Nothing names a moment: a person returns to "the
folder last Tuesday" or "this note before Jess's edit".

**A window is opened on a folder; on the web, opening it is what grants it.** A
web app's home lists the folders that fit its view, and opening one issues a
token for that folder alone, its audience the folder's address, as OAuth
resource indicators (RFC 8707) define. Nothing is stored about apps. The
Epicenter app and the CLI hold the person's reach to every folder they hold.

**Content is named by its hash and stored once**; whether its bytes sit in the
database or the blob store is the code's choice by size.

**Machines edit fields; people edit prose.** A front-matter field is
machine-edited, one `key: <JSON>` per line, and merges by key, the later
winning. The body is the person's, merges by paragraph, and a conflict stays
visible and repairable in the file.

## Consequences

- The server's words are the person's words: folder, file, version, member.
- A web app asks which folder to open, and holds one token per open folder.
- An imported repository's tags are not kept.
