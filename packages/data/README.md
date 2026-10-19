# @epicenter/data

The browser repository engine under construction for
[ADR-0626](../../docs/adr/0626-an-app-reaches-a-repository-only-through-open.md)
and [ADR-0628](../../docs/adr/0628-browser-sync-uses-transactions-and-git-updates-instead-of-cross-tab-ownership.md).
Local implementation clarifications are recorded in
[ADR-0629](../../docs/adr/0629-a-local-save-refuses-a-file-directory-replacement.md),
[ADR-0630](../../docs/adr/0630-a-file-save-accepts-exact-bytes-as-its-starting-content.md),
and [ADR-0631](../../docs/adr/0631-a-browser-observes-the-remote-before-making-a-commit.md).
Current applications still use `@epicenter/folder`. The
[implementation plan](../../specs/20261019T190000-browser-repository-engine.md)
tracks transport, retention, app integration, and data-safe migration.

## Implemented locally

`src/repository.ts` opens the internal local engine. Files and rows save into
IndexedDB before returning success, including before an initial fetch. A row
retains its exact source and exposes raw fields with issues when the app's
read schema does not fit. Writes do not validate against that schema.

Each draft passes its starting source. A row save returns `sent`, the source
that draft submitted, for its next save. Other writers' independent fields
and body regions survive without becoming part of the draft's base.

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

`src/storage.ts` stores inflated Git objects, B (last incorporated server
commit), C (that commit or one exact pending commit), E (newer text and
deletions relative to C), shallow-boundary metadata, and one repository
revision. Every mutation publishes atomically with a revision increment.
A push acknowledgement checks exact B/C and preserves newer E.
The persisted `remoteKnown` flag distinguishes an unopened remote from one
successfully fetched as empty. Preparation leaves E alone until that first
observation, then returns an exact pending `{ base, head }` pair or null.

Each repository database has three object stores:

| Store | Key | Value |
| --- | --- | --- |
| `objects` | Git object hash | `{ type, bytes }`, with uncompressed content |
| `edits` | Repository path | Newer text, or null for a deletion |
| `meta` | `state` | B, C, shallow boundaries, revision and remote knowledge |

Rows are views of Markdown files. There is no separately persisted table
database. Tabs of the same origin share this database; different app origins
keep separate copies and exchange their changes through the Git service.

Capture reads the current commit C. Point reads open its ancestor trees and
load only the requested blob. File lists walk the matching prefix; table lists
open the table directory and load its immediate Markdown rows. Commit preparation
opens trees along pending-edit paths and loads no existing blobs. Unexpanded
directories retain occupancy, so a narrow read still protects unseen contents.
Every pending-edit ancestor is also opened: deleting its final child may remove
the directory. All pending edit values are still read in each capture.

A captured view holds consistent inputs for one operation. Its revision check
still rejects publication if another tab saved in the meantime. It is not a
backup or a complete object closure for collection. Future reconciliation must
explicitly capture B and the remote inputs it needs; local operations need C.

`src/git/snapshot.ts` rebuilds changed trees without a checkout or Git index.
It preserves unrelated raw names, native modes, symlinks, and gitlinks.
`src/merge.ts` merges Markdown by frontmatter field and body region. Other
UTF-8 files, JSON included, merge by text region. Simultaneous insertions
survive current first; an edit beats an unseen deletion. A competing change
wins its field or text region. Invalid source stays available for file repair.

Local saves return `Occupied` if they would replace a folder with a file or
an ancestor file with a folder. This protects table rows and raw files through
the same check, including folders with names the app cannot decode. A witnessed
row deletion removes the row and its whole attachment folder together; the
folder follows the row, without a separate attachment-folder witness.

File operations accept a string or exact bytes as `from`. Use bytes from
the returned Blob to retain a leading byte-order mark or delete native binary
content. Changed content remains text only. Gitlinks remain structural entries
and are excluded from the file list; deletion does not claim an unseen gitlink
was removed. Writing text over a symlink or gitlink creates a regular file.
Untouched native modes and raw entries stay intact.

Closing a handle prevents new operations. A call made after close throws;
an already-running operation that cannot publish returns `StorageFailed`.
Previously acknowledged work remains saved.

## Git synchronization

`src/sync.ts` provides the internal `createSync(repository, options).run()`
trigger. It prepares a local commit when allowed, fetches `main`, establishes
whether a pending commit landed, adopts incoming data under a revision check,
and pushes at most one exact pending commit. Concurrent calls on that sync
instance share its current promise. A successful push can leave newer edits
waiting for the next trigger.

`src/git/transfer.ts` uses public isomorphic-git operations over an isolated
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

The package has no public opening API yet. The internal constructor does not
check a grant or start network sync. Do not migrate an application to it until
the public `open`, auth, subscriptions, sync status, and automatic scheduling
are connected.

Ordinary Git exchange and uncertain-push recovery now have local native-server
and browser evidence. Hosted-service checks, collection, network deadlines and
automatic triggers remain unfinished. The eventual scheduler must respect
`Retry-After`; the current internal trigger provides no retry scheduler.
The current object store grows as commits are prepared because collection is
unbuilt. Existing app data is untouched. Overwritten intermediate
local saves need not have a recoverable version; the eventual recovery
guarantee covers commits incorporated into server history.

## Verification

From the repository root:

```sh
bun run --cwd packages/data test
bun run --cwd packages/data typecheck
bun run --cwd packages/data smoke:local
bun run --cwd packages/data smoke:sync:local
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

[Synchronization evidence](evidence/sync/RESULTS.md) separates native-wire
regressions from the three-browser workload and the remaining gates.

[Recorded results](evidence/local/RESULTS.md) compare the full and scoped reads.
A 500-folder probe captures 3 trees for one file, down from 502. A separate
500-edit backlog still captures all affected trees and about 2 MB of pending
text. Phone measurements must determine whether that remaining cost needs
further narrowing. No persistent path index, pack cache or per-edit base store
has been added.
