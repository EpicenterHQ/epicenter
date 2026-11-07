# 0835. Records from 0802 to 0834 agree on files, a ledger, and Git at the edges

- **Status:** Accepted (2026-11-07)
- **Date:** 2026-11-07
- **Relates:** every record from [ADR-0802](0802-people-share-spaces-an-app-works-in-one-at-a-time-and-a-folder-carries-its-contract.md) to [ADR-0834](0834-every-folder-is-also-a-git-remote.md), and [ADR-0801](0801-records-from-0763-to-0800-agree-on-the-merge-rust-patching-marks-and-agents.md), the last such register.
- **Unbuilt:** see the Built column below.

## Context

Thirty-three records written over two days decided the shape of folders, sync,
history, sharing, Git, and apps, and many amended earlier ones: spaces, a stamp
in each folder, copy detection, history stored as Git, a notifier, and live
sessions were each decided and then withdrawn. A reader who follows the records
in order meets every withdrawn design before the one in force. This record
states what is in force, in one place, and names the record that decided each
part, so the chain can be read for its reasons rather than its result.

## Decision

**The model.** A folder is plain files in `~/Epicenter`, where people, apps, and
agents work. The server is a ledger that orders changes, keeps every version,
and admits people. Git is the door in and out. One thing moves: a change, a set
of files each naming the version it replaces. [`docs/vision.md`](../vision.md)
states it for a reader; the table below is what is in force.

| Topic | In force | Decided by | Built |
| --- | --- | --- | --- |
| A folder | every real directory in `~/Epicenter`; a link is outside and never synced | 0813, 0825 | yes |
| What a folder holds | only its content; saves and recordings stage beside their targets under reserved names | 0822 | yes |
| Its contract | `epicenter.json`: a title and collections, path patterns with JSON Schema | 0805, 0818 | yes |
| A note | one `key: <JSON>` per front-matter line, anything else is body; prose belongs in the body | 0796, 0797, 0818 | grammar reader no |
| A version | the SHA-256 of a file's bytes, on every store | 0824 | yes |
| The write | one door: a change naming each file's expected version; a stale write is refused | 0808, 0824 | yes |
| Who syncs | on a computer, only Epicenter's programs; a desktop app reads and writes files | 0822 | yes |
| The web | a web app's store is the folder on the server | 0823 | yes |
| When | a change is sent the moment it happens; others' are checked every thirty seconds; no notifier, no live session | 0830 | no: today every three seconds |
| The merge | a line is the unit: a field by key, the later change winning; a body by Git's line merge, both versions shown | 0795, 0830 | yes |
| Which directory is which | the directory Epicenter last synced (inode and birth time); anything else asks once | 0821, 0832 | partly: the name-and-files proof remains |
| Git working trees | Git's; never synced | 0822, 0825 | yes |
| History | an append-only log of changes in Postgres, with authors and marks; bytes in R2 | 0824, 0826 | yes |
| History's past | each folder's older changes in its own archive; text inline up to 2 KiB | 0833 | no |
| Restores and deletion | a restore never deletes on a device; bytes leave through an outbox; the chain covers what changed, not who | 0829 | no |
| Sharing | an invitation to an email; members equal; readers read | 0811, 0820 | yes |
| App reach | a web app reaches the folders attached to it; a desktop app's token holds only `ai` | 0820, 0822 | yes |
| Git in and out | `export --git`, `import --git`; `git land` turns a branch into one change | 0826, 0831 | export and import yes; land no |
| Git remote | every folder a Git remote: clone reads history, push lands as a change | 0834 | no |
| Names | the folders audience at `<api origin>/folders`; a write is `POST …/changes` | 0828 | yes |
| Apps | a view, a window over one folder, and capabilities; the platform owns folders | 0814, 0817, 0818 | no |
| The Epicenter app | every folder, its history, sharing, and import; syncs every folder from login | 0816, 0819, 0828 | yes, its pages unseen running |
| The CLI and MCP | one table of operations renders both; MCP adds tools from each contract | 0827 | yes |

**Withdrawn on the way, and why**, so they are not proposed again without a new
reason: spaces and groups (sharing is per folder, 0811); a stamp or id inside a
folder (copies carry it, 0832); copy detection by device number (the directory's
identity replaced it, 0821, 0832); history stored as Git (its writes are whole
trees racing one branch, 0824); a per-folder database on Durable Objects (it
split one ledger into two stores, 0830's review); a notifier (speed not yet
needed, 0830); live sessions and CRDTs (a second store and a second write path,
0830); a merge by word (it splices rewrites without a mark, 0830).

**Where records disagree, the one this table names governs.**

## Consequences

- A reader learns the model from [`docs/vision.md`](../vision.md), what is in
  force from this record, and why from the records it names.
- The Built column is updated, or this record amended, as work lands.
