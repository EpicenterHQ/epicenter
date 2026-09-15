# 0379. Reconstruction is an explicit destructive library operation

- **Status:** Proposed
- **Date:** 2026-09-09
- **Relates:** [ADR-0394](0394-a-backup-is-the-library-s-folder-kept-by-the-authority.md) (what a backup is: the row and kv files of the ADR-0337 folder, kept as rows by the authority, naming each row's bytes by naming the row) and [ADR-0395](0395-restore-is-one-request-that-carries-its-own-safety-copy.md) (a restore is one request whose transaction keeps the safety copy; there is no receipt, because a retry after a lost response is refused by the position check and the reload already shows the result)
- **Unbuilt:** Kept backups, the one-request restore route, production activation transport, and the destructive product action. The authority and browser retirement path are implemented; container replacement remains an experiment.

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
reconsidered here. Current-generation startup and retirement are implemented;
the recovery operation and existing-library rollout remain incomplete.
The older proposed [ADR-0170](0170-one-live-epicenter-has-sealed-backups-and-restore-creates-a-fresh-authority-lifetime.md)
explored sealed backups separately from the live database. Its implementation
and historical measurements are not assumptions of this proposal.

The [Yjs 14 experiment](../benchmarks/yjs-root-rotation/README.md) demonstrates
another option: replacing a nested data container can collect deleted
descendants while retaining one document lineage. It also discards edits made
against the removed container and retains historical writer metadata.

## Decision

ADR-0395 defines the user contract: ordinary synchronization brings devices
together; restore deliberately makes the selected backup current everywhere.
Retirement discards old unsynchronized work, including completed recordings
whose audio has not uploaded. The pre-restore safety copy covers captured
account state through the folder codecs, with audio coverage separately
reported. It cannot preserve unseen offline work. There is no automatic
merge, abandoned-work inbox, or rescue queue.

Finish both row synchronization and audio upload before restore if that work
should enter the safety copy. An offline device cannot be certified current
by another device and can continue producing work until it learns retirement.
Those later edits are discarded too. Matching immutable local audio required
by restored rows survives row-state cache invalidation.

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
Opening establishes which replica the page holds; each sync connection asks the
authority whether that generation is still writable. The cache cannot answer
that second question. Online and offline changes preserve the same opened App.
There is no scheduled reload or one-time boot check that grants permanent
admission. A cache miss requires the authority before the App becomes ready;
a complete cache permits immediate local use while connection attempts continue.
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
the authority has never received. That backup is the text of the ADR-0337 folder (ADR-0394); it names each
row's bytes by naming the row (ADR-0393), and its fidelity is what each
table's mandatory codec writes (ADR-0268).

The accepted loss boundary is every edit in the retired generation that the
authority never accepted, including offline edits and queued edits during a
failing connection. A device can keep making those edits until it learns of
retirement; the loss is not limited to edits made before replacement. Already
accepted data follows the deliberate operation's semantics: reconstruction
preserves the captured application data, while restoring an older backup
intentionally replaces current contents with that backup. The exact-state
condition prevents activation from silently skipping writes accepted after
capture. Ordinary reconnection, folding, and garbage collection never authorize
discarding pending edits. Only explicit replacement retires a generation.

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

Archives are immutable captured states. The application keeps one daily and
keeps the newest seven; a person's own copies and every before-restore copy
are deleted only by that person (ADR-0394). They are created without changing
the live database.
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
Socket opening is not admission: on every initial connection and reconnect, the
transport waits for an explicit admitted or retired result before sending the
outbox. Admission applies to the connection's captured generation. Replacement
also retires already-open connections, and the authority rejects their later
writes under the same serialization boundary as activation. Rejoining loads the replacement rather
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
The authority enforces exclusion of retired edits even when a device has not
discovered replacement. People do not have to bring every device online before
restoring. The initiating action explains the possible loss of unsynchronized
work, and a device that discovers retirement explains why its library reloaded.
This trade gives up recovery and merging of retired edit queues so ordinary use
needs only one current writable library.

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
Replacement requests carry the position the safety copy was rendered from;
retrying after a lost response is refused because that position has moved,
and the reload already shows the result (ADR-0395). Capture must
cover the authoritative log head, including its tail; the latest stored snapshot
alone may lag accepted writes.

## Implementation evidence

The [implementation spec](../../specs/20260909T010040-current-generation-restore.md)
records the reviewed ownership changes, current code entrypoints, implementation
sequence, and interruption tests. The [continuation handoff](../../specs/20260909T010040-current-generation-restore.handoff.md)
preserves the settled user contract and the boundary between tested retirement
and the unimplemented recovery operation. These planning documents are temporary;
this record owns the decision.

Two independent reviews support one stable library authority and an optional
local generation header. The second review removed the proposed persisted
transition state and old-page replacement download. The mounted authority now
owns generation admission and the retirement write fence.

The [Honeycrisp browser journey](../../apps/honeycrisp/scripts/library-retirement.ts)
exercises two independent Chromium profiles against the real self-hosted Worker.
An offline edit survives reopening, then confirmed retirement discards it and
reloads the replacement. The test also covers an idle admitted socket, a delayed
editor callback, a paused invalidation with the library claim held, an aborted
invalidation and retry, and a failed replacement download. The fresh page displays
the replacement and its accepted tail while its new socket's frames are withheld.

Current downloads carry an opaque snapshot-plus-tail capture through one log
head. The browser validates and folds that capture before installing a usable
cache. `App.signal` exposes the existing store lifetime so editor producers stop
synchronously when retirement makes the App unusable. It does not mean resource
cleanup or durable invalidation has finished.

Activation in this journey uses a test-only service binding and the actual
authority owner. It does not expose a restore endpoint, keep backups, or carry
a safety copy in the activation transaction as ADR-0394 and ADR-0395 require.
Stronger cancellation of a cache
installation after its boot owner aborts also remains unproved; acquisition
currently retains its claim through completion and refuses a closed App's readiness.

## Considered alternatives

- Keep indefinitely writable generations and let each device choose. This was
  the preceding design. It preserves old branches but adds a
  navigation and synchronization promise that storage maintenance does not need.
- Replace containers automatically. Refused because old offline edits and a
  competing replacement's entire subtree can disappear despite convergence.
- Clear every known device manually. Insufficient for shared libraries and
  offline replicas; a current replacement fact must survive until reconnection.
- Replace document identities during ordinary maintenance. Refused because
  folding and GC retain synchronization with stale peers without requiring their
  retirement. A private replacement identity belongs to the explicit reset path.
