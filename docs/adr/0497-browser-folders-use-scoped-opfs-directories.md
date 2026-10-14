# 0497. Browser folders use scoped OPFS directories

- **Status:** Accepted
- **Superseded by:** [ADR-0532](0532-a-browser-folder-is-its-id-written-lazily-and-its-remote-is-its-git-configuration.md), still Proposed: a browser folder is the directory its ID names, with no channel or owner in its address.
- **Date:** 2026-10-03
- **Amended:** 2026-10-04: OPFS opens directly; IndexedDB migration and legacy admission are removed.
- **Relates:** [ADR-0461](0461-portable-data-folders-live-under-local-and-derived-account-scopes.md) defines authored owners; [ADR-0496](0496-native-app-runtime-storage-is-independent-of-the-shell.md) defines private native runtime ownership; [ADR-0494](0494-file-folders-reserve-epicenter-for-rebuildable-caches.md) defines transient query sessions.
- **Unbuilt:** application selection of development and account scopes, and private SQL channel and account ownership in the `so.epicenter/<app-id>/<owner-path>/` namespace.

## Context

The browser adapter stored one folder in an IndexedDB database named
`epicenter-folder:<id>`, or its scoped equivalent. Its `contents`,
`inventory`, `directories`, and `git` object stores split ordinary files from
private repository paths, and incoming publication used one database
transaction.

The replacement stores literal files and Git together in OPFS. Individual saves
need no generic multi-file transaction. Incoming Git adoption needs its own
interruption recovery because it changes the working tree, staging index and
branch together. The initial cutover copied earlier databases. The user subsequently chose a
clean break: unmigrated IndexedDB files have no recovery promise. Keeping the
reader, freeze protocol and copy cursor would make every new OPFS folder pay
for a retired storage format.

## Decision

**Each browser folder occupies one scoped OPFS directory containing its files and `.git/`.**
The channel, owner and folder ID select the directory. A relative file path
selects the same authored bytes for table, KV, file and media access. Git reads
that working tree and stores repository data in its `.git/` directory, which no
folder path can name and no listing shows.

```text
OPFS, per origin:
  Epicenter/                       release authored root
    local/<folder-id>/
      kv.json
      notes/example.md
      audio/take.webm
      .git/
        epicenter-folder.json      ready marker naming the address
    accounts/<account-key>/<folder-id>/...
  Epicenter Dev/                   development authored root
    local/<folder-id>/...
    accounts/<account-key>/<folder-id>/...
```

One portable file maps to one physical file. A save creates no inventory
database, content mirror or private object-ID mapping; a file's identity is the
SHA-256 of the bytes read from it. Explicit empty directories remain
directories. Repository state stays outside portable source enumeration,
capture, transfer and file-change hints.

Opening requires `navigator.storage.getDirectory`, writable file streams and Web
Locks, and returns `NoFileSystem` without them. Opening requires no IndexedDB
API, database lookup or legacy admission. It never falls back to another store.

**Capture the address before acquiring resources.**
Channel means release or development. Owner means Local or a specific account
key under ADR-0461. One captured address determines the OPFS directory, the
files and Git Web Lock names and the notification channel. Changing login cannot
retarget an opened folder. Separate origins do not replace channel isolation.
Omitted scope opens release Local; applications choose any other scope
explicitly.

**Individual public operations do not promise cross-file atomicity.**
ADR-0482 defines individual publication and workflow-owned recovery. Every file
mutation holds the folder's files Web Lock, so cooperating tabs check and
publish conditions without interleaving. New bytes publish when a file's
writable stream closes. A stream whose close throws is `Unconfirmed`, whatever
the path holds afterward. Git incoming adoption retains a separate recovery
record under ADR-0474.

**Opening uses only the captured OPFS directory.**
The opener finds or creates that directory under its open Web Lock. It checks
`.git/epicenter-folder.json` against the captured address before returning a
handle. A marker for another address, an unreadable marker, or a populated
directory without a marker refuses opening. An interrupted initial marker
creation can be retried only while the directory contains no other files.
Initialization does not read or freeze another storage system.

Release, development, Local and account directories remain independent. A new
account folder does not inspect Local storage or assign Local data to the
current login. Existing OPFS files and Git history reopen in place. IndexedDB
readers, migration cursors, legacy scope fences and their errors are removed.
No runtime recovery tool or automatic database deletion replaces them.

**Private application SQLite retains independent channel, app and account ownership.**
Its OPFS namespace is `so.epicenter/<app-id>/<owner-path>/` for release and
`so.epicenter.dev/<app-id>/<owner-path>/` for development. SQLite's access-handle
pool owns physical filenames. Selecting an authored folder cannot select,
reset or copy a mailbox, outbox or pending provider work. Credentials follow the
private owner; authentication sessions remain separate.

**Authored storage preserves arbitrary exact bytes.**
Markdown validation belongs above storage. Malformed text remains readable for
repair. Saved completed SQLite datasets are ordinary authored files; they do
not activate a SQL driver or imported pending work. Transfer validates target
names and collisions without silently renaming or omitting files.

Folder queries build in memory from immutable captures under ADR-0494. This
layout reserves no folder-local cache directory. A future persistent cache must
have a measured caller and stay outside source capture, history and transfer.

## Consequences

The browser and native adapters expose the same literal file model. Browser
saves lose IndexedDB's cross-file transactions. Incoming Git recovery pays for
its own durable record instead of imposing a journal on every save.

OPFS remains origin-private and subject to quota and site-data deletion; quota
exhaustion and eviction surface as the failing step's `Io` or `Unconfirmed`.
A tree is neither a backup nor cross-origin sharing. The adapter makes no
power-loss or flush-to-disk promise, and OPFS offers no compare-and-swap:
cooperating tabs rely on the files Web Lock. Pages of other origins or browser
profiles are outside what the locks can see.

An unmigrated IndexedDB folder no longer appears automatically. Its database
may remain on disk until deliberate cleanup; the app never reads or deletes it.

## Verification

The clean-break Folder suite passes 676 tests, with 18 skips. Its identity
checks open fresh directories and reopen saved bytes and Git history while
IndexedDB globals are absent or throw. Scope tests cover release/development,
Local and two accounts. Browser bundles contain no IndexedDB globals. The live
package typecheck and OPFS evidence build pass.

These are stand-in and build checks. The earlier cutover also exercised saves
and reload in Chrome over previously migrated OPFS data. Final app browser
observations are recorded separately from the automated clean-break checks in
[the coordinator review](../../packages/folder/evidence/opfs/coordinator-clean-break-review.md).

Still to verify: quota failure in a real browser, and release/development and
Local/two-account isolation once applications select those scopes.

## Considered alternatives

- Retain IndexedDB transactions: preserves cross-file atomicity but keeps a
  different physical storage model and its inventory/content pairing.
- Journal every ordinary save: adds durable operation state to workflows that
  need only one file publication and its actual reply.
- Store authored files in private SQLite: couples file authority to a database
  engine and private application reset lifetime.
- Keep both adapters as a runtime option: two physical layouts would each need
  migration, locking and recovery, and an older build could keep writing the
  store the newer one left.
