# Browser repository engine

The engine inside `@epicenter/folder` (`src/browser/`) under construction for
[ADR-0626](../../../../docs/adr/0626-an-app-reaches-a-repository-only-through-open.md)
and [ADR-0628](../../../../docs/adr/0628-browser-sync-uses-transactions-and-git-updates-instead-of-cross-tab-ownership.md).
The internal implementation also follows proposed
[ADR-0629](../../../../docs/adr/0629-a-local-save-refuses-a-file-directory-replacement.md),
[ADR-0630](../../../../docs/adr/0630-a-file-save-accepts-exact-bytes-as-its-starting-content.md),
and [ADR-0631](../../../../docs/adr/0631-a-browser-observes-the-remote-before-making-a-commit.md).
Those records remain Proposed; their implementation here does not settle the
public contract.
It is implementation, not a public package: apps reach it only through
`@epicenter/folder`. The
[implementation plan](../../../../specs/20261019T190000-browser-repository-engine.md)
tracks transport, retention, app integration, and data-safe migration.

## Chosen integration direction

[ADR-0633](../../../../docs/adr/0633-apps-open-local-data-before-connecting-services.md)
requires desktop and browser apps to open local data before first sign-in.
A local dataset has its own identity; optional synchronization later connects
existing work to a chosen repository. No schema file or service grant is required for
local opening. CLI check and query require root epicenter.json in v1
([ADR-0632](../../../../docs/adr/0632-a-lens-belongs-to-its-reader.md)).

The internal constructors already separate local storage from Git exchange.
`openFolder({ tables })` is the public local opening API. It sits over
`openRepository` in `src/browser/repository.ts`, which only
`src/local-folder.ts` imports. Row parsing, canonical text, and merge rules
live in `src/shared/` and carry no browser dependency. Apps never see `Repository`. A persisted
connection, sync status, and first attachment of existing work are not built. Hosted inference is a separate
service and adds no dependency to this package
([ADR-0634](../../../../docs/adr/0634-hosted-inference-is-independent-of-repository-sync.md)).

## Implemented locally

`src/browser/repository.ts` opens the internal local engine. Files and rows save into
IndexedDB before returning success, including before an initial fetch. A row
retains its exact source and exposes raw fields with issues when the app's
read schema does not fit. Writes do not validate against that schema.

Each draft passes its starting source. A row save returns `sent`, the source
that draft submitted, for its next save. Other writers' independent fields
and body regions survive without becoming part of the draft's base.
The public table `change` is a partial row edit. The content merge receives a
complete candidate built from that edit: `base` is the caller's `from`,
`current` is this save attempt's stored file, and internal `change` is that
candidate. Browser Git sync uses the same content merge for competing file
leaves after it compares trees; Git ancestry and tree entries are separate work.

IndexedDB owns publication:

```txt
capture refs, edits, required bytes and revision
                    |
          merge and hash outside a transaction
                    |
          compare revision in a write transaction
              /                         \
          changed                     matches
            |                            |
        recompute              publish and acknowledge
```

`src/browser/storage.ts` persists `remoteBase`, `pendingCommit`, and saved
`edits`. `remoteBase` is the last server commit incorporated locally. It is
`undefined` before a successful fetch and `null` after observing an empty
remote. `pendingCommit` is null while idle; otherwise it is the exact commit
prepared for push or awaiting an outcome. `edits` contains the latest saved text or
deletion at each path since the current commit. That current commit is derived
as `pendingCommit ?? remoteBase ?? null`. Every mutation publishes atomically
with a revision increment. A push acknowledgement checks the exact remote base
and pending commit, then preserves newer edits.

Commit preparation leaves edits alone until the first successful fetch, then
returns an exact pending `{ base, head }` request or null. Git transfer derives
its shallow boundary from `remoteBase`; the boundary is not another durable
state value.

Each repository database has three object stores:

| Store | Key | Ownership |
| --- | --- | --- |
| `meta` | `state` | `remoteBase`, nullable `pendingCommit`, and the publication revision. It coordinates sync and holds no file content. |
| `edits` | Repository path | The latest locally saved text or null deletion relative to the current commit. It is the current overlay, not a log of every save. |
| `objects` | Git object hash | Immutable `{ type, bytes }` Git commits, trees, and blobs, with uncompressed content. It retains the snapshots needed by `remoteBase` and `pendingCommit`, not the newer overlay. |

The three states remain separate when a reply goes missing:

```txt
                         server    remoteBase  pendingCommit  edits
fetch                    R         R           null           empty
save Blue                R         R           null           Blue
prepare and push         P         R           P              empty
reply lost               P         R           P              empty
save local: 1            P         R           P              local: 1
fetch proves P landed    P         R           P              local: 1
reconcile and push M     M         M           null           empty
```

The last save stores the complete newer file, but its changes are measured
against P. If the server then advances to Q, sync preserves Q's independent
changes and applies only what the later save changed after P. If the server
instead advances from R without P, sync rebases P and then the later save onto
that server state. Until the server proves which happened, it keeps the exact P
and the newer edit. The revision guards a publication against another tab's
save. These details stay inside the browser sync engine, outside the public
`Folder` API.

Rows are views of Markdown files. There is no separately persisted table
database. Tabs of the same origin share this database; different app origins
keep separate copies and exchange their changes through the Git service.

Capture reads the derived current commit. Point reads open its ancestor trees and
load only the requested blob. File lists walk the matching prefix; table lists
open the table directory and load its immediate Markdown rows. Commit preparation
opens trees along pending-edit paths and loads no existing blobs. Unexpanded
directories retain occupancy, so a narrow read still protects unseen contents.
Every pending-edit ancestor is also opened: deleting its final child may remove
the directory. All pending edit values are still read in each capture.

A captured view holds consistent inputs for one operation. Its revision check
still rejects publication if another tab saved in the meantime. It is not a
backup or a complete object closure for collection. Future reconciliation must
explicitly capture `remoteBase` and the remote inputs it needs; local operations
need only the current commit.

`src/browser/git/snapshot.ts` rebuilds changed trees without a checkout or Git index.
It preserves unrelated raw names, native modes, symlinks, and gitlinks.
`src/shared/merge.ts` merges Markdown by frontmatter field and body region. Other
UTF-8 files, JSON included, merge by text region. Simultaneous insertions
survive current first; an edit beats an unseen deletion. A competing change
wins its field or text region. Invalid source stays available for file repair.

Local saves return `Occupied` if they would replace a folder with a file or
an ancestor file with a folder. This protects table rows and raw files through
the same check, including folders with names the app cannot decode. A witnessed
row deletion removes only the row file. Adjacent files stay available through
`folder.files`, including files the deleting caller never observed.

File operations accept a string or exact bytes as `from`. Use bytes from
the returned Blob to retain a leading byte-order mark or delete native binary
content. Changed content remains text only. Gitlinks remain structural entries
and are excluded from the file list; deletion does not claim an unseen gitlink
was removed. Writing text over a symlink or gitlink creates a regular file.
Untouched native modes and raw entries stay intact.

`onChange` reports each committed publication: the paths a save wrote or
deleted, or null when a snapshot change may touch any path. It reaches every
handle of the database, including other tabs, through a `BroadcastChannel`
named after the database. A save that fails or changes nothing notifies no one.
A transaction failure, including a synchronous request error such as a
`QuotaExceededError`, becomes `StorageFailed` and names the browser's reason.

Closing a handle prevents new operations. A call made after close throws;
an already-running operation that cannot publish returns `StorageFailed`.
Previously acknowledged work remains saved.

## Git synchronization

`src/browser/sync.ts` provides the internal `createSync(repository, options).run()`
trigger. It prepares a local commit when allowed, fetches `main`, establishes
whether a pending commit landed, adopts incoming data under a revision check,
and pushes at most one exact pending commit. Concurrent calls on that sync
instance share its current promise. A successful push can leave newer edits
waiting for the next trigger.

`src/browser/git/transfer.ts` uses public isomorphic-git operations over an isolated
in-memory filesystem for each transfer. It handles ordinary smart HTTP and
pack/delta decoding without a checkout or persistent Git index. Returned
objects are inflated and hash-verified. Initial fetch uses depth 1; later
fetches negotiate from B with no new depth limit. An unresolved ancestry gap
can trigger one full-history recovery fetch. Temporary history stays outside
the durable object publication.

If the server still holds B, retry exact C. If it contains C, merge only newer
E onto the incoming snapshot. Proven rejection permits replacing C; missing
parents do not prove rejection. The ancestry walk follows every parent.
A late fetch whose base changed locally is discarded. The push checks its
expected base against the same advertisement used to send the update, and
the server must enforce conditional, fast-forward updates.

Rejection reconciles two local generations. A transient snapshot D applies
E's deletions to C before merging B, the remote, and D. The second merge
applies the remaining D-to-current-local changes. This preserves a newer
reversal while preventing a deletion from resurrecting C's rejected text.
Adoption atomically publishes complete remote and candidate snapshots, a new
one-parent commit when needed, both refs, and removal of captured E. A save
during computation makes the revision check fail and leaves the save intact.

## Why the library is narrower than a Git client

Apps edit current rows and files on one `main` branch. They need no staging,
branch switching or browser history interface. Pending edits batch into
commits, so an overwritten intermediate save may have no history. Automatic
field and paragraph resolution removes conflict review from apps. Independent
edits still survive; competing edits follow the merge policy above.

The whole active repository is available offline. This avoids selective-fetch
and offline-cache rules, but the repository must fit browser storage. Retained
history can be small while recovery traffic is large. Inflated objects avoid
pack lookups during ordinary reads, at the cost of more space. Transfers still
create temporary packs and filesystem metadata in memory.

One repository revision avoids per-edit base records and cross-tab ownership.
It can reject useful work after an unrelated save. Sync may wait for editing
to settle; the scheduler need not force progress during uninterrupted typing.

## Integration boundary

The package exports nothing from this directory. `src/local-folder.ts` imports
`repository.ts` for `openFolder({ tables })`. The internal constructor does not check a grant or
start network sync. Do not migrate an application's stored data to it until
the data-safe migration from the older OPFS folders is connected. A sync-enabled app also needs optional auth, remote attachment,
and automatic scheduling; those do not gate local-only use.

Ordinary Git exchange and uncertain-push recovery now have local native-server
and browser evidence. Hosted-service checks, network deadlines, and automatic
triggers remain unfinished. The eventual scheduler must respect
`Retry-After`; the current internal trigger provides no retry scheduler.
After sync publishes a snapshot or acknowledges a push, storage collects
objects outside the confirmed and pending snapshot closures. It checks
liveness and deletes in one IndexedDB transaction; a failed collection leaves
published work intact and costs space.
The [retention evidence](../../evidence/browser-engine/retention/RESULTS.md) covers fake IndexedDB
and three desktop browser engines. Existing app data is untouched. Overwritten
intermediate local saves need not have a recoverable version; the eventual
recovery guarantee covers commits incorporated into server history.

## Verification

From the repository root:

```sh
bun run --cwd packages/folder test:engine
bun run --cwd packages/folder typecheck
bun run --cwd packages/folder smoke:local
bun run --cwd packages/folder smoke:sync:local
```

The smoke check needs Playwright's Chromium, WebKit, and Firefox binaries.
Install them with `bun x playwright install chromium webkit firefox` when
needed. To use existing binaries, pass `--chromium <path>`, `--webkit <path>`,
and `--firefox <path>` to the smoke script. `--output <path>` records JSON.
Every run creates and removes its own temporary profiles and native Git
repository. It contacts only a temporary loopback server.

Unit tests use in-memory IndexedDB. The local-only browser check runs the production
engine in two pages, races saves with commit publication, retains newer edits
after a simulated acknowledgement, reopens persistent profiles, and checks
the emitted objects with native Git. The sync browser check uses actual native
Git HTTP requests, concurrent pages, a reply lost after server acceptance,
a later native edit, graceful profile reopening, and ancestry recovery without
replay. Neither check establishes forced termination, quota behavior, hosted
service behavior, or phone durability. Those require separate release evidence.

[Synchronization evidence](../../evidence/browser-engine/sync/RESULTS.md) separates native-wire
regressions from the three-browser workload and the remaining gates.

[Recorded results](../../evidence/browser-engine/local/RESULTS.md) compare the full and scoped reads.
A 500-folder probe captures 3 trees for one file, down from 502. A separate
500-edit backlog still captures all affected trees and about 2 MB of pending
text. Phone measurements must determine whether that remaining cost needs
further narrowing. No persistent path index, pack cache or per-edit base store
has been added.
