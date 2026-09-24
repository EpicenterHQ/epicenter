# 0372. Each store owns its blob namespace

- **Status:** Accepted
- **Date:** 2026-09-08
- **Implementation (2026-09-22):** The scoped API and transport are implemented. Whispering uses store-owned blobs and scoped copy references; product playback-worker registration remains deferred; see the [verification report](../reports/20260922-store-owned-blobs-implementation.md).
- **Amended by:** [ADR-0438](0438-hosted-blobs-have-stable-authority-urls.md) at hosted ownership, addressing, and operations: Personal stores no longer lend `.blobs`; an Account-bound client publishes owner-level authority URLs. Local BlobIds and the recorder destination remain. The remote examples below describe the former transport.

## Context

Applications create bytes, copy saved objects, read bytes for computation, and
acquire URLs for presentation. A local-source-only upload API makes remote
creation depend on local persistence. A public arbitrary-ID writer makes every
application responsible for assigning immutable identities. Treating every read
as a download forces playback to wait for a durable local write.

## Decision

**Every opened store owns `tables`, `kv`, and `blobs` under its captured scope.**

`openLocal(definition)` always provides `local.blobs` for device-local bytes.
`openPersonal(definition, { account })` always provides `personal.blobs` for
remote objects under that account. A future `openShared` provides `shared.blobs`
under the authorized shared owner. Shared membership, addressing, and transport
must be designed before that opener ships; this record adds no Shared export.

The definition ID selects the blob namespace. The store fixes its owner before
asynchronous acquisition and owns the blob capability's readiness and cleanup.
There is no separate public `openLocalBlobs` or `openRemoteBlobs` in the
API, no optional `blobs` member, and no lazy acquisition mode. Internal adapters
may remain separate. Opening a store acquires both its document and blob access;
it does not fetch every blob or certify future network availability.

**Blob operations create objects with `add`, copy their bytes with `copyFrom`, read
bytes with `get`, and acquire presentation with `open`.**

Each creation and copy returns its new destination ID:

```ts
import { openLocal, openPersonal } from '@epicenter/app/open';

const local = await openLocal(captureDefinition);
const personal = await openPersonal(savedDefinition, { account });

const added = await local.blobs.add(bytes);
if (added.error) return added;
const copied = await personal.blobs.copyFrom(local.blobs, added.data, { signal });
if (copied.error) return copied;
return local.blobs.copyFrom(personal.blobs, copied.data, { signal });
```

Local captures a definition without an Account. Personal captures a definition
and Account identity/transport before asynchronous acquisition. Neither store
requires the other. Different definitions can select different namespaces and
row schemas. The namespace and BlobId are distinct;
[ADR-0426](0426-copies-create-independent-blobs-at-their-destination.md) owns
address grammar, placement, and identity. Handles never retarget after account
replacement. Closing one store does not close another.

`store.close()` fences its document and blob access immediately, then settles
both before releasing ownership. Local closure retires dependent recorders and
drains admitted Stop publication. Blob capabilities are borrowed from their
store; callers close the store, not an independently owned `.blobs` child.
Failed opening settles every started acquisition, including a late successful
acquisition, and preserves both the opening and cleanup failures. Neither handle
escapes until required Local storage and document readiness succeed. Release
the namespace claim only after cleanup is known safe; an uncertain release
retains exclusion. Fence both capabilities synchronously before awaiting cleanup.
Personal captures remote access without a network health probe, preserving
cached document access during an outage.
Closing preserves committed rows and bytes. There is no transaction spanning
the document and blobs, no automatic byte synchronization, and no row-triggered
blob deletion. Personal tables can be available offline while its remote blobs
are unavailable.

Account retirement ends captured network authority, not the cached Personal
store's lifetime. The product working-lifetime owner closes or replaces that
store on departure. Neither sign-out nor an outage invalidates its document
generation or deletes pending edits. A new Account needs a new Personal handle;
existing requests and presentation never retarget to it. Presentation must
enforce captured-account authorization without assuming an unimplemented
Account retirement signal.

| Operation | Local and remote contract |
| --- | --- |
| `add(bytes, { signal }?)` | Accept Blob/File input, select its format, mint a BlobId, publish complete bytes, return `Result<BlobId, E>` |
| `copyFrom(source, blobId, { signal }?)` | Copy committed bytes from an actual supported source handle into this destination under a fresh destination ID; return `Result<BlobId, E>` after publication |
| `get(blobId)` | Return `Result<Blob, E>` containing the complete payload, without creating a persistent copy in another store |
| `open(blobId)` | Return `Result<BlobSource, E>` with a usable `url` and idempotent disposal; no promise of complete download or offline retention |
| `delete(blobId)` | Remove only this placement; deleting an absent object succeeds |
| Owning store's `signal`, `close()` | Fence new work and settle admitted work without deleting committed bytes |

Local retains `stat` and `list` for metadata and maintenance. Remote enumeration
is not introduced for interface symmetry. A remote metadata operation may be
added only for a concrete availability/copy caller; internal HEAD support need
not become a new public method. Expected operational errors use Results;
openers and `close()` retain rejecting Promise contracts. Invalid or closed
handle use may throw. Final application callers own presentation.

### New bytes and existing objects have different entrypoints

`personal.blobs.add(bytes)` can create a remote object without first saving locally.
`add` creates identity even if another object has equal bytes. Capture/import
and transformations use `add` or a producer's private publication capability.
The recorder keeps its selected ID across Stop publication retries.

Application handles expose no arbitrary-ID `put`. Storage needs atomic
publication under an established identity, but no particular internal method
name, exported interface, or wrapper is required. Keep a low-level `put` only
where real adapters/producers use it. Its existence does not justify public ID
assignment. Future restore from externally assigned IDs needs a concrete
validated ingestion contract; it is not implemented speculatively here.

`copyFrom` is the one public copy spelling. Remove
`upload`, `download`, `addFrom`, `addLocal`, and top-level `copyBlob` aliases from
the target application surface. No destination-ID override exists. To create a
new identity for supplied bytes, use `add`.

### Copy owns one operation across store-owned blob capabilities

The initial source matrix is concrete: Local accepts Local or Personal;
Personal accepts Local. Personal-to-Personal is deferred and must not appear
in the source type. Shared adds no placeholder type. Reject unsupported pairs
before reading payloads or publishing. Do not promise all structural objects
with a `get` method are sources or add a generic source-store protocol.

Each admitted copy uses both captured scopes. Native source provenance comes
from the actual handle; a test/custom source must not silently select a
same-named native file. Cross-namespace copying is valid. Cross-account/authority
access requires independently authorized source and destination handles.

Both owning stores must be usable at admission. The copy is tracked by both until
settlement. Closing either store cancels and drains admitted transfer work without
closing the other store or cancelling its unrelated work. Preserve opened source
snapshots and owned descriptors; source deletion racing a copy must produce
complete captured bytes or a failure, never substituted or partial bytes.
Destination publication is atomic, without overwriting an occupied identity.
A new copy never accepts an occupied destination as success. An uncertain
publication reports failure even if complete destination bytes may exist.

Cancellation or a lost acknowledgment after publication can leave a complete
destination object. Neither failure nor close promises rollback. The source is
never deleted. A repeated public copy creates another destination ID. Lost server
acknowledgments may leave an object whose ID the caller never received. There is no transaction spanning stores or application rows.

### The runtime chooses transport

`get` followed by an internal publication can implement a copy, but it loses
source provenance at the public Blob boundary. Native copying should retain
host file streaming rather than transporting a complete payload through the
WebView. Browser implementations may use complete Blobs where their storage
requires them. Preserve size checks before payload reads where metadata exists.

A Blob is not necessarily a JavaScript heap buffer. The current WebView
`response.blob()` and broker request preparation do impose full-body completion
barriers; browser writes and Bun's ordinary `get` explicitly use ArrayBuffers.
Measure peak process memory and latency rather than assuming copy counts.
Opening remote media follows
[ADR-0427](0427-opening-a-blob-acquires-presentation-without-retaining-a-copy.md).
No generic transfer engine, capability registry, durable queue, automatic retry,
background synchronization, or cache manager belongs to this copy operation.

## Consequences

Applications choose scopes once at store acquisition. The store supplies the
namespace, account, and cleanup previously repeated by blob callers. Signed-out
recording and local playback remain possible through Local. Remote creation and
playback require Personal readiness, including its document acquisition, but
do not require a device-local copy of the media. Public byte reads remain
available for transcription without retaining another placement.

The cost is deliberate: blob-only access without opening a structured store is
outside this API. Table admission or hydration failure prevents acquiring its
blobs, and closing the store ends playback and capture that depend on them.
This removes two public constructors and separate product-owned blob lifetimes;
it does not remove internal storage adapters or publication coordination.

The physical publication primitive remains necessary even when its application
method disappears. The smaller public surface costs arbitrary external-ID
writes and requires deliberate copy/provenance and collision handling. It does
not prove global equality between untrusted stores with matching opaque IDs.

Current READMEs describe implemented exports. An integrated release must change
server, client, host relay, adapters, callers, and tests before removing the old
path. An isolated API implementation can precede product migration, but must
report broken consumers and cannot claim application integration or merge
readiness. Keeping two public acquisition paths is not a compatibility solution.
Historical APIs remain history; no compatibility aliases are required.

## Considered alternatives

- Independent public blob openers: preserve schema-free media access but repeat
  scope selection and cleanup outside the store that owns the namespace.
- Keep both nested access and standalone openers: leaves two public ownership
  paths and requires callers to understand which one owns cleanup.
- Automatically synchronize blobs alongside tables: adds transfer and retention
  policy that explicit `copyFrom` does not require.
- Capture LocalBlobs in the remote constructor: makes remote-only creation and
  presentation acquire an unrelated dependency and ties namespace selection.
- Expose `put(id, bytes)` to all application callers: permits arbitrary identity
  assignment without a demonstrated import/restore consumer.
- Require applications to compose every `get` and write: loses native source
  provenance and spreads transfer lifetime handling into callers.
- Top-level copy plus upload/download aliases: repeats one operation's meaning.
- Public destination-ID overrides: makes copying another creation API.
- Force equal method sets: invents remote enumeration to satisfy a generic type.

## Verification

Prove new-byte creation, both local/remote copy directions, cross-namespace local
copy, exact byte preservation with fresh destination IDs, atomic publication, refused
occupied keys, interrupted transfers, and independent store close. Verify custom
sources never borrow native provenance. Compare browser and native results,
including host descriptor release and account retirement. Preserve recorder
Stop publication and subsequent row-write failure outcomes. Public type checks
must reject removed methods and unsupported source pairs.
Prove that every opened Local and Personal store exposes usable blobs, failed
acquisition unwinds both children, and closing a store fences retained blob
methods and retires its sources and recorders. Preserve committed bytes when
document work or cleanup fails. Blob-only access without store readiness is no
longer an acceptance case; Shared requires separate membership and access tests.
