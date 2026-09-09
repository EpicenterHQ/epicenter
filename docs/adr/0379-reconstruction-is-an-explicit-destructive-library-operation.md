# 0379. Reconstruction is an explicit destructive library operation

- **Status:** Proposed
- **Date:** 2026-09-09
- **Unbuilt:** Frozen complete backup capture, conditional authority installation, replica retirement and reload, and the destructive product action. Container replacement is an experiment, not a production document layout.

## Context

Generations began as an escape from retained Yjs history. Keeping each previous
database writable also introduced address selection and independent histories.
That is a larger product promise than reclaiming storage requires.

[ADR-0256](0256-automatic-folding-is-the-current-maintenance-path-and-manual-workspace-compaction-is-deferred.md)
separated automatic folding from a future deliberate destructive operation.
[ADR-0272](0272-restore-replaces-a-workspace-from-an-artifact-under-a-new-document-identity.md)
described destructive restore and reset on reconnection.
[ADR-0276](0276-an-authority-holds-a-numbered-succession-of-generations-and-nothing-is-ever-overwritten.md)
and [ADR-0281](0281-a-generation-is-a-whole-database-and-a-device-chooses-which-one-it-holds.md)
instead retained older writable databases. These are the decisions being
reconsidered here; this proposal does not describe the current implementation.
The older proposed [ADR-0170](0170-one-live-epicenter-has-sealed-backups-and-restore-creates-a-fresh-authority-lifetime.md)
explored sealed backups separately from the live database. Its implementation
and historical measurements are not assumptions of this proposal.

The [Yjs 14 experiment](../benchmarks/yjs-root-rotation/README.md) demonstrates
another option: replacing a nested data container can collect deleted
descendants while retaining one document lineage. It also discards edits made
against the removed container and retains historical writer metadata.

## Decision

Keep folding automatic and private. Introduce reconstruction only as a deliberate
replacement of a library's contents, after measured pressure or a restore need
justifies building it. The library keeps its stable logical address. Its current
implementation's numbered generations remain until a replacement protocol has
been proved and an explicit migration decision has been made.

Folding and garbage collection are distinct. Folding replaces many persisted
updates with fewer updates representing the same CRDT lineage. Yjs garbage
collection removes eligible deleted payloads while retaining the metadata needed
for synchronization. The current acknowledged-log fold replays updates into a
temporary `gc: true` document and encodes a complete state update, so the durable
rewrite incorporates GC. Unsynchronized outgoing updates are merged separately
without that whole-document rewrite. Binary update merging alone does not run GC.

Creating a temporary `Y.Doc` and replaying old updates is still the same lineage.
Reconstructing application values in a fresh document creates new operation
identities. Ordinary maintenance uses the former and requires neither retirement
nor reload. It reduces stored-log overhead and collectable payloads, but does not
promise to remove all historical writer and deletion metadata. Measure folded
bytes and cold-open cost before concluding that the remaining metadata warrants
a destructive operation.

The [push/pull benchmark](../benchmarks/yjs-root-rotation/checkout.md) identifies
whole-body updates and the byte size of the tail between count-triggered folds
as concrete costs. Prioritize measuring and improving those within the existing
lineage. A small fully folded snapshot does not imply a small unsynchronized
backlog, and replacing the document does not recover bandwidth already spent.

For a remotely synchronized library, its authority authorizes and commits the
replacement. A client that understands the application captures and reconstructs
the data. The authority does not infer application meaning from Yjs bytes.
Installation must condition on the exact state covered by that capture and fail
if accepted writes have advanced it. Serialization of replacement requests alone
does not establish coverage.

For a synchronized library, one stable library authority owns the current numeric
generation, its update log, and socket admission. Keep the generation outside the
replaceable Yjs document. Activation advances the number in the same transaction
that installs the complete replacement. Generation checks and accepted writes
share that serialization boundary. A separate current pointer beside independently
writable generation authorities would require distributed fencing and is not the
target. This identity is neither a Yjs writer/client ID nor an archive ID.

Each device has one stable IndexedDB library address, scoped by application,
authority, principal, and data definition. An optional generation header names
its complete cached replica. No header means no usable replica. The header and
update rows share one database so installation and invalidation are atomic.
There is no persisted transition status. The outbox and cursor remain derived
from update rows. An ordinary reopen hydrates a valid cached replica without
waiting for a network. Cached means locally available, not guaranteed current
on the server. There is no highest-generation scan and no inference from a failed request.
A cursor from the old identity has no meaning in the new one. Restoring the same
archive twice creates two different replacement identities; it never revives an
archived identity.

For a library with no remote synchronization, the local durable store owns the
equivalent identity and replacement record. Adding synchronization later must
explicitly establish its authority rather than silently electing a device's ID.

The product presents this as replacing the shared library, names the destination,
and explains that unsynchronized work on other devices can be lost. Before
activation, retain a verified, complete backup of the captured state and validate
the replacement against its intended contents. That backup cannot contain work
the authority has never received. A backup intended to recover rich content and
blobs must prove that fidelity; today's folder export is not automatically that
proof.

Reconnecting devices must adopt the replacement and discard all unsynchronized
work belonging to the retired generation. Fence the old backing's writes and
stop its sync and application producers. Atomically delete the generation header
and clear its updates while retaining the library claim. Close its resources,
then reload the application document. The next page owns downloading and opening
the replacement through ordinary bootstrap; the retiring page does neither.
Old queued persistence operations and callbacks must not write after invalidation
or into the new lifetime. Ordinary close, which drains queued updates today, is
not sufficient to establish that fence. The library claim remains held through
invalidation and cleanup. This is a whole-application transition. It does not
require an ordinary generation picker. It cannot instantly erase an offline device's storage, purge backups, or promise
secure erasure of deleted bytes.

Archives are immutable captured states with their own retention policy. They may
be created periodically or before replacement without changing the live database.
Browsing an archive is read-only; restoring it is another deliberate replacement.
An older writable generation is not an archive.

For an explicit reset whose purpose is to shed the old causal history, prefer a
fresh document behind a private replacement identity. Keep nested container
replacement as comparative evidence: it retains writer metadata and discards old
subtree edits, so it is neither a complete history reset nor ordinary maintenance.
Do not introduce either mechanism as automatic cleanup.

A fresh `Y.Doc` or a different GUID does not itself reject old Yjs updates.
The synchronization protocol must bind every write to a document identity and
atomically retire the old identity when installing its replacement. That rule
must cover queued writes and already-open sockets as well as new connections.
Retirement must remain enforceable after deleting the old document's bytes;
an old connection must never recreate it or silently target the current one.

A stale device discovers retirement before uploading to the current document.
Socket opening is not admission: the transport waits for an explicit admitted or
retired result before sending the outbox. Rejoining loads the replacement rather
than applying or recovering its old binary outbox. The server's write rejection
establishes correctness. Closing and reopening the application retires local
editors and other references.

A device whose replica was durably invalidated follows the ordinary cache-miss
path after reload. It waits for a complete current-generation download; failure
leaves the cache absent and shows the normal bootstrap retry state. It does not
reload repeatedly for network failure. Installation atomically writes the
baseline and its generation under the still-live boot owner, and the connection
checks admission before sending. Another restore may occur during download or
after admission; the same retirement path handles it. Network failure alone
never proves retirement. A device with no local replica also needs the authority;
first-run creation uses one atomic ensure-current operation rather than list-empty
followed by an independent import. A local cache miss never proves the remote
library is empty.

Invalidation is a transaction, not deletion of the IndexedDB database. Database
deletion can block on other connections and is unnecessary. Before invalidation
commits, a crash can leave the previous valid cache; after it commits, a restart
cannot open that replica. A separate transition marker would have the same
durability boundary. The backing must reject later old writes, and previously
submitted overlapping transactions must finish before invalidation clears their
effects. Bare page reload without this durable invalidation would reopen the
retired cache.

Only the current generation is writable at the authority. Offline devices can
still edit their held generation until they discover retirement. Retired server
bytes may be deleted after installation and backup requirements are satisfied;
the durable current number rejects old identities even after cleanup. No picker,
read-only predecessor catalog, or pending-work recovery feature is part of this
model. Archives remain the recovery surface.

## Consequences

The destructive action accepts a real loss boundary in exchange for a simpler
live-library model. It does not require enumerating every device or waiting for
every offline device to acknowledge the transition.

Container replacement still needs a seeded shared root, complete content copying,
undo retirement, durable installation, and reload behavior. Two concurrent
replacements converge by choosing one subtree, so Yjs convergence alone cannot
authorize reconstruction. A head check prevents replacing already accepted work
with a stale capture; it cannot protect unseen offline work.

The next prototype must prove backup fidelity and interruption recovery before
adding an endpoint or button. Its acceptance cases include a write during capture,
two competing replacements, a crash before and after commit, a lost response and
retry, reconnecting stale replicas, and an editor holding the removed content node.
Include an old socket submitting during activation, a delayed queued write, and a
reconnect after retired bytes have been deleted. For the fresh-document path,
each must leave the replacement untouched and must not recreate the retired one.
Replacement requests also need durable operation receipts: retrying after a lost
response must report that activation rather than restore again. Capture must
cover the authoritative log head, including its tail; the latest stored snapshot
alone may lag accepted writes.

## Implementation evidence

The [implementation spec](../../specs/20260909T010040-current-generation-restore.md)
records the reviewed ownership changes, current code entrypoints, implementation
sequence, and interruption tests. The [continuation handoff](../../specs/20260909T010040-current-generation-restore.handoff.md)
preserves the settled user contract and the boundary between benchmark evidence
and the unimplemented production protocol. These planning documents are temporary;
this record owns the decision.

Two independent reviews support one stable library authority and an optional
local generation header. The second review removed the proposed persisted
transition state and old-page replacement download. Current code still lacks the
required generation admission and retirement write fence.

## Considered alternatives

- Keep indefinitely writable generations and let each device choose. This remains
  the current design being reconsidered. It preserves old branches but adds a
  navigation and synchronization promise that storage maintenance does not need.
- Replace containers automatically. Refused because old offline edits and a
  competing replacement's entire subtree can disappear despite convergence.
- Clear every known device manually. Insufficient for shared libraries and
  offline replicas; a current replacement fact must survive until reconnection.
- Replace document identities during ordinary maintenance. Refused because
  folding and GC retain synchronization with stale peers without requiring their
  retirement. A private replacement identity belongs to the explicit reset path.
