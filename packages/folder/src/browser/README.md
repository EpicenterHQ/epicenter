# Browser folder engine

The browser saves one current folder as an immutable Git tree. Two separate
commit references let sync distinguish the last incorporated server state from
an exact send whose outcome may be unknown. Unchanged files share objects:

```text
workingTree --------------------> tree --+
remoteBase ------> commit ------> tree --+--> shared trees and file bytes
pendingCommit ---> commit ------> tree --+
```

Applications reach this engine through `openFolder({ tables })` from
`@epicenter/folder`. Files and table views expose no commits, roots, history,
collection controls, or sync scheduling. Rows remain views of Markdown files.
Opening and offline saving require no account, network, or declaration file.
The public handle waits for started operations before releasing storage.

[ADR-0650](../../../../docs/adr/0650-a-browsers-current-folder-is-one-immutable-tree.md)
records the working-tree decision. The
[save-to-sync review](../../evidence/browser-engine/working-tree/REVIEW.md)
inventories the owners, methods, temporary maps, and lifecycle states.

## Stored data

Each origin's default folder opens `epicenter.folder.default`, version 1.
Internal tests can select another key. This is a clean break: there is no
migration, legacy reader, or fallback to the earlier IndexedDB or OPFS storage.
Existing older databases and OPFS files are not opened or changed.

| Store | Key | Stored value |
| --- | --- | --- |
| `meta` | `state` | `workingTree`, `remoteBase`, `pendingCommit`, `retiredBytes` |
| `objects` | Git object hash | Immutable `{ type, bytes }` with inflated commit, tree, or blob contents |

`workingTree` always names a valid tree, including Git's canonical empty tree.
`remoteBase` is undefined before the first successful observation, null after
observing an empty remote, or an incorporated commit hash. `pendingCommit` is
null or the exact prepared commit. `retiredBytes` conservatively schedules
collection; it is neither an exact garbage count nor a physical storage limit.
An IndexedDB index on object `type` is database-maintained, not another ledger.

There is no saved edit overlay, deletion marker, dirty-path map, revision,
per-file merge base, or local save history. Diffs are temporary comparisons of
trees. Retention keeps current snapshot closures and stops at commit parents.
Git history needed for ancestry proofs can be fetched into temporary memory.

## Saving

A file save captures W's required trees and the current file bytes in one
read transaction. It merges the caller's exact starting bytes with the current
contents and submitted change outside IndexedDB, hashes the new file, and
rewrites its ancestor directories. A write transaction compares captured W,
then publishes the new objects and root together. A changed root retries the
operation. Other tabs' B/P changes do not invalidate a local file save, and the
save preserves the latest sync metadata and collection accounting.

A point capture reads only the path's ancestor trees and blob. Prefix lists
walk matching directories without loading file bytes. Row lists load immediate
Markdown rows. `capture([])` walks all trees without blobs; an omitted scope
captures all current files; `capture('sync')` includes W and both checkpoint
closures. Captured objects stay in an operation-local map so a later save or
collection cannot change the inputs of an in-progress computation.

Markdown merges by frontmatter field and body region. Other UTF-8 files,
including JSON, merge by text region. Independent changes survive. Competing
changes follow the existing automatic merge policy. Row saves return `sent`,
the submitted source, so another writer's unseen changes do not enter the
draft's next merge base. A field edit refuses concurrently malformed source;
the raw file remains available for repair.

Native names, untouched modes, symlinks, gitlinks, and directory occupancy
survive tree rewriting. File/directory replacements require a witnessed
removal before reusing the path. A gitlink stays a structural leaf and is not
reported as a readable or successfully deleted file. Exact byte witnesses
retain BOM and binary content; mutable caller buffers are copied before awaits.

Only a changed W notifies subscribers. Local saves name their paths; a sync
adoption can invalidate all paths. Checkpoint-only changes and collection do
not notify file views. Failed publication reports `StorageFailed`, including
the browser's reason, without replacing the old root. No-op saves notify nobody.

## Preparing and settling a send

`prepareCommit(storage, author)` belongs to sync. Storage's `checkpoint()`
captures metadata and, when preparation is needed, W/B trees and regular
`.gitignore` blobs in one transaction. Other file payloads are not loaded.

Before a successful remote observation it does nothing. An existing P is
returned unchanged. Otherwise, preparation removes ignored untracked paths from W to derive the
send tree. Paths already in B stay tracked. A different send tree creates one
commit with B as parent and atomically installs P under a W/B/P guard. Ignored
files remain in W, so W differing from B alone does not mean work is unsent. The current
pre-fetch preparation timing is preserved.

`createSync(repository, options).run()` is an internal bounded attempt. Concurrent
calls on one instance share its running promise. Different tabs may overlap;
there is no cross-tab leader or lock. A successful result does not promise that
all newer saves have been sent. Persisted attachment, optional authentication,
and automatic app scheduling remain unbuilt.

After fetch, sync recaptures current inputs while retaining the starting
capture's bytes. The transport can reuse those bytes even if another tab has
replaced and collected them. A fetch anchored to an obsolete B
is discarded. If the server still holds B, it retries exact P. If the server
contains P, it merges only newer P-to-W changes. Missing ancestry is unknown,
not rejection; one full-history recovery fetch can establish the outcome.
All parents participate in ancestry proofs.

Sync selects source against P while it is unsettled, otherwise B. It never
unions their tracked membership: a path deleted by P is no longer tracked even
when B contains it. The selected tree is temporary, not a fourth checkpoint.
After merging shared contents, sync restores W's ignored local additions. An
incoming file or directory occupying one of those paths, including a spelling
that collides on disk, returns `LocalFileInTheWay` and preserves the captured
state. The files API keeps those bytes accessible for repair. A newer rule does
not rewrite P or cancel a send whose outcome is still unknown.

A proven rejection needs two local generations. First remove entries deleted
between P and W from P, producing transient D. Rebase B/remote/D, then apply
D-to-W changes. This prevents a later deletion from resurrecting rejected text
while preserving a later reversal. Raw names are compared as bytes. Adoption
publishes only the retained snapshots under a W/B/P guard; a concurrent save
leaves the candidate unpublished for a later attempt. Push acknowledgement
checks exact B/P and preserves the latest W.

Equal snapshots carry equal change intent. Deleting a folder's files,
temporarily replacing it, and restoring identical contents leaves no hidden
prefix tombstone. Independent remote fields therefore survive that canceled
operation. An undo across a real P checkpoint still matters when W differs
from P. Native-server regressions cover both cases.

## Collection and costs

Storage collects after checkpoint retirement and when conservative retired
bytes reach 8 MiB. It marks W's tree and B/P's commits plus file snapshots, then
sweeps other objects in the same write transaction. A missing or wrongly typed
live object aborts the sweep. Blob keys from the type index establish liveness
without loading blob payloads. No reference counts or incremental collector
state are maintained.

Collection remains in the operation's lifetime. It can delay completion and
queue other tabs. A failure after publication is logged and leaves that save
successful. A quota failure before publication collects and retries once with
the same guards; another failure leaves the previous root and caller's draft.
The budget persists across reopening and is reset only by successful collection.

Saves hash contents and rewrite ancestor directories. Wide directories and
repeated large-file overwrites can cost more than a small overlay. Large offline
backlogs no longer force each point read to load all saved edits. The
[prototype measurements](../../evidence/browser-engine/working-tree-prototype/RESULTS.md)
show that tradeoff; they are not a timing guarantee for this implementation.

The isomorphic-git adapter is a separate cost. Each fetch and push seeds an
isolated in-memory bare repository through `writeObject`, recompressing known
inflated objects. Scratch files copy writes; Git maintains pack/index/cache
buffers; fetched objects are inflated, copied, and hash-verified; outgoing
request chunks are joined into a contiguous buffer. Sync's maps usually share
object byte references, but these encoding and transport steps copy bytes.
Recovery can temporarily hold much more history than the current folder.

Keep this adapter's ordinary smart-HTTP negotiation, delta decoding, shallow
push, server report handling, and interrupted-response checks. A custom
transport would take ownership of all of them. No peak-memory benchmark yet
justifies that replacement. Transfer workspaces and readers are released per
call; there is no persistent Git index, pack cache, or checkout.

## Verification and remaining work

From the repository root:

```sh
bun run --cwd packages/folder typecheck
bun run --cwd packages/folder test
bun run --cwd packages/folder smoke:local
bun run --cwd packages/folder smoke:sync:local
```

[Working-tree evidence](../../evidence/browser-engine/working-tree/RESULTS.md)
records native Git, concurrency, collection, lost replies, and full-profile
reopening. Browser runs use disposable profiles and loopback native servers.

Desktop evidence does not establish phone latency, browser eviction, forced
termination, real-device quota behavior, or hosted-service conditional updates.
The internal trigger has no retry scheduler or network deadline. Future
scheduling must respect `Retry-After`. These are release and integration work,
not alternate storage modes or migration requirements.
