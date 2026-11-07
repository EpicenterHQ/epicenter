# 0835. Records from 0802 to 0834 agree on files, a ledger, and Git at the edges

- **Status:** Accepted (2026-11-07)
- **Date:** 2026-11-07
- **Relates:** every record from [ADR-0802](0802-people-share-spaces-an-app-works-in-one-at-a-time-and-a-folder-carries-its-contract.md) to [ADR-0834](0834-every-folder-is-also-a-git-remote.md), and [ADR-0801](0801-records-from-0763-to-0800-agree-on-the-merge-rust-patching-marks-and-agents.md), the last such register.
- **Amended by:** [ADR-0837](0837-the-ledger-is-the-persons-model-folders-the-versions-of-their-files-and-who-may-see-them.md) at history's marks, app reach, and the inline threshold: see ADR-0837's table.
- **Amended by:** [ADR-0838](0838-git-speaks-to-a-folder-through-a-remote-helper-and-the-cli-speaks-a-persons-verbs.md) at Git in and out, the Git remote, and the CLI: see ADR-0838.
- **Amended by:** [ADR-0839](0839-a-save-is-one-numbered-write-a-reset-deletes-nothing-and-epicenter-owns-the-pages-every-app-links-to.md) at saves, resets, deletions, Git, and the platform's pages: see ADR-0839.
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
| A note | fields then body; any header a bounded YAML reader accepts is read by key; every write writes the whole header as one `key: <JSON>` line per field, in the contract's order; prose belongs in the body | 0796, 0797, 0818, 0839 | no: the code writes block YAML |
| A version | the SHA-256 of a file's bytes, on every store | 0824 | yes |
| The write | one door: a change naming each file's expected version; a stale write is refused | 0808, 0824 | yes |
| Who syncs | on a computer, only Epicenter's programs; a desktop app reads and writes files | 0822 | yes |
| The web | a web app's store is the folder on the server | 0823 | yes |
| When | a change is sent the moment it happens; others' are checked every thirty seconds; no notifier, no live session | 0830 | no: today every three seconds |
| The merge | a line is the unit: a field by key, the later change winning; a body by Git's line merge, both versions shown | 0795, 0830, 0836 | partly: sync yes; an app's own write and MCP still try words first |
| Which directory is which | the directory Epicenter last synced (inode and birth time); a directory nothing could be is a new folder at once; otherwise it asks | 0821, 0832, 0839 | partly: the name-and-files proof remains |
| Git working trees | Git's; never synced | 0822, 0825 | yes |
| History | an append-only log of file versions; versions saved together share a number, each naming its program, reached by time; content by hash | 0824, 0837, 0839 | partly: changes and marks remain in code |
| History's past | each folder's older versions in its own archive, when growth calls for it | 0833, 0837 | no |
| Restores and deletion | a reset deletes nothing on either side; only deletions of content appearing nowhere else are held back; bytes leave through an outbox | 0829, 0836, 0839 | no |
| Sharing | a grant to a person or an email; members equal; readers read | 0811, 0820, 0836, 0837 | partly: three tables remain |
| App reach | a web app opens a folder through Epicenter's sign-in page and holds a token for it; History and Share open Epicenter's window; a desktop app's token holds only `ai` | 0822, 0837, 0839 | partly: web apps reach attached folders today |
| Git in and out | `git clone epicenter::<folder>` and `git push` through the helper; a push lands only when made from the latest version | 0826, 0838, 0839 | no: `export --git` and `import --git` today |
| A Git remote on the server | only for a sandbox that has Git and cannot run the helper | 0834, 0838 | no |
| Names | the folders audience at `<api origin>/folders`; a write is `POST …/changes` | 0828 | yes |
| Apps | a view, a window over one folder, and capabilities; the platform owns folders | 0814, 0817, 0818 | no |
| The Epicenter app | every folder, its history, sharing, and import; syncs every folder from login | 0816, 0819, 0828 | yes, its pages unseen running |
| The CLI and MCP | one table of a person's verbs renders both; sharing is not an agent tool by default | 0827, 0838, 0839 | the table yes; the verbs no |

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
